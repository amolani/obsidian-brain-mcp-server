import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { atomicWriteFileSync, atomicWriteJsonSync } from './atomic-file.ts'
import { planClaudeHookInstall } from './claude-hooks.ts'
import { assertGeneratedSurfaceOwnership } from './generated-surface-ownership.ts'
import { isActiveNote, isAutoCaptureNote } from './note-scope.ts'
import { assertCanWriteTool, loadBrainPolicy } from './policy.ts'
import { sanitizePathSegment, vaultJoin } from './vault-paths.ts'

export type BackgroundRunStatus = 'ok' | 'warn' | 'fail'
export type BackgroundJobStatus = 'ok' | 'warn' | 'fail' | 'skipped'

export interface BackgroundRunOptions {
  dryRun?: boolean
  jobs?: string[]
  maxRuntimeMs?: number
  maxJobRuntimeMs?: number
  lockPath?: string
  settingsPath?: string
  client?: string
  sourcePath?: string
  runAutoBuild?: boolean
  maxAutoBuildSources?: number
  isolateJobs?: boolean
  quiet?: boolean
}

export interface BackgroundJobResult {
  id: string
  label: string
  status: BackgroundJobStatus
  durationMs: number
  summary: string
  detail?: unknown
}

export interface BackgroundRunResult {
  dryRun: boolean
  status: BackgroundRunStatus
  generatedAt: string
  durationMs: number
  maxRuntimeMs: number
  maxJobRuntimeMs: number
  lockPath: string
  reportPath: string
  jsonPath: string
  jobs: BackgroundJobResult[]
  nextActions: string[]
  content: string
}

const DEFAULT_LOCK_PATH = '.brain-background.lock'
const BACKGROUND_REPORT_PATH = 'Maintenance/Background Run Report.md'
const BACKGROUND_JSON_PATH = '.brain-background-last-run.json'
const BACKGROUND_JOB_WORKER = new URL('./background-job-worker.ts', import.meta.url)
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4))
const DEFAULT_JOBS = [
  'brain_health_check',
  'brain_metrics',
  'build_brain_dashboard',
  'build_capture_review',
  'build_evidence_dashboard',
  'build_knowledge_inbox',
  'build_change_ledger',
  'build_knowledge_index',
  'brain_schedule',
  'migrate_brain_metadata_preview',
  'safe_maintenance_preview',
  'semantic_index_preview',
  'hook_repair_preview',
]

const GENERATED_JOB_SURFACES: Record<string, { path: string; owner: string; tool: string }> = {
  build_brain_dashboard: { path: 'Knowledge/_brain.md', owner: 'brain-dashboard', tool: 'build_brain_dashboard' },
  build_capture_review: { path: 'Maintenance/Capture Review.md', owner: 'capture-review', tool: 'build_capture_review' },
  build_evidence_dashboard: { path: 'Knowledge/evidence.md', owner: 'evidence-dashboard', tool: 'build_evidence_dashboard' },
  build_knowledge_inbox: { path: 'Maintenance/Knowledge Inbox.md', owner: 'knowledge-inbox', tool: 'build_knowledge_inbox' },
  build_change_ledger: { path: 'Maintenance/Change Ledger.md', owner: 'change-ledger', tool: 'build_change_ledger' },
  build_knowledge_index: { path: 'Knowledge/index.md', owner: 'knowledge-index', tool: 'build_knowledge_index' },
}

function nowIso(): string {
  return new Date().toISOString()
}

function clampRuntime(value: number | undefined): number {
  return Math.max(1000, Math.min(value ?? 30000, 10 * 60 * 1000))
}

function clampJobRuntime(value: number | undefined, maxRuntimeMs: number): number {
  return Math.max(1, Math.min(value ?? Math.min(10000, maxRuntimeMs), maxRuntimeMs))
}

function normalizeJobs(jobs: string[] | undefined): string[] {
  return jobs?.length ? jobs.map(String) : DEFAULT_JOBS
}

function preflightApplyJobs(vault: Vault, jobs: string[], options: BackgroundRunOptions): void {
  for (const id of new Set(jobs)) {
    const surface = GENERATED_JOB_SURFACES[id]
    if (surface) {
      assertCanWriteTool(surface.tool, [surface.path])
      assertGeneratedSurfaceOwnership(vault.vaultPath, surface.path, surface.owner)
    }
  }

  if (options.client) {
    const client = sanitizePathSegment(options.client.trim())
    if (!client) throw new Error('client ist für Customer-Surfaces ungültig')
    if (jobs.includes('build_memory_timeline')) {
      const path = `Kunden/${client}/_timeline.md`
      assertCanWriteTool('build_memory_timeline', [path])
      assertGeneratedSurfaceOwnership(vault.vaultPath, path, 'memory-timeline')
    }
    if (jobs.includes('build_customer_snapshot')) {
      const path = `Kunden/${client}/_snapshot.md`
      assertCanWriteTool('build_customer_snapshot', [path])
      assertGeneratedSurfaceOwnership(vault.vaultPath, path, 'customer-snapshot')
    }
  }
}

function summarizeUnknown(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value ?? '')
  const record = value as Record<string, any>
  if (typeof record.status === 'string') return `status=${record.status}`
  if (typeof record.path === 'string') return `path=${record.path}`
  if (typeof record.entryCount === 'number') return `entries=${record.entryCount}`
  return Object.entries(record)
    .slice(0, 4)
    .map(([key, val]) => `${key}=${typeof val === 'object' ? '[object]' : String(val)}`)
    .join(', ')
}

function statusFromJobs(jobs: BackgroundJobResult[], reviewBacklogGrew = false): BackgroundRunStatus {
  if (jobs.some(job => job.status === 'fail')) return 'fail'
  if (reviewBacklogGrew || jobs.some(job => job.status === 'warn' || job.status === 'skipped')) return 'warn'
  return 'ok'
}

function nextActions(jobs: BackgroundJobResult[], reviewBacklogGrew = false): string[] {
  const actions = jobs
    .filter(job => job.status === 'fail' || job.status === 'warn')
    .slice(0, 8)
    .map(job => `${job.label}: ${job.summary}`)
  if (reviewBacklogGrew) actions.unshift('Knowledge Inbox: Review-Backlog ist seit dem letzten Lauf gewachsen')
  return actions.slice(0, 8)
}

function metricsOperations(jobs: BackgroundJobResult[]): Record<string, any> | null {
  const detail = jobs.find(job => job.id === 'brain_metrics')?.detail
  if (!detail || typeof detail !== 'object') return null
  const operations = (detail as Record<string, unknown>).operations
  return operations && typeof operations === 'object' ? operations as Record<string, any> : null
}

function previousReviewBacklog(vault: Vault): number | null {
  try {
    const parsed = JSON.parse(readFileSync(vaultJoin(vault.vaultPath, BACKGROUND_JSON_PATH), 'utf-8')) as {
      jobs?: Array<{ id?: string; detail?: { operations?: { reviewBacklogOpen?: unknown } } }>
    }
    const value = parsed.jobs?.find(job => job.id === 'brain_metrics')?.detail?.operations?.reviewBacklogOpen
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function formatReport(result: Omit<BackgroundRunResult, 'content'>): string {
  const rows = result.jobs.length > 0
    ? result.jobs.map(job => `| \`${job.id}\` | ${job.status} | ${job.durationMs} | ${job.summary.replace(/\|/g, '\\|')} |`).join('\n')
    : '| - | - | - | Keine Jobs ausgeführt |'
  const actions = result.nextActions.length > 0
    ? result.nextActions.map(action => `- ${action}`).join('\n')
    : '- Keine unmittelbaren Aktionen'
  const operations = metricsOperations(result.jobs)
  const signals = operations
    ? [
      `- Neue Captures seit letztem Lauf: ${operations.newCapturesSinceLastRun ?? 0}`,
      `- Provisional Claims: ${operations.provisionalClaims ?? 0}`,
      `- Fällige Evidence-Rechecks: ${operations.staleEvidence ?? 0}`,
      `- Unsichere Kundenzuordnungen: ${operations.uncertainClientMatches ?? 0}`,
      `- Runbook-Kandidaten: ${operations.runbookCandidates ?? 0}`,
      `- Noisy Auto-Build Runs: ${operations.noisyAutoBuildRuns ?? 0}`,
      `- Review-Backlog: ${operations.reviewBacklogOpen ?? 0} (ältestes Item ${operations.reviewBacklogOldestDays ?? 0} Tage)`,
      `- Fehlende/stale Surfaces: ${(operations.generatedSurfacesMissing?.length ?? 0)}/${(operations.generatedSurfacesStale?.length ?? 0)}`,
      `- Action-Log Writes: ${operations.actionLogWrites ?? 0}`,
      `- Fehler im vorherigen Background-Lauf: ${operations.previousFailedJobs ?? 0}`,
    ].join('\n')
    : '- Brain Metrics war nicht Teil dieses Laufs.'
  return `---\nstatus: aktiv\ntags:\n  - background-run\n  - maintenance\naktualisiert: ${result.generatedAt}\nquelle: brain-run-background\n---\n\n# Background Run Report\n\nStatus: **${result.status}**\n\n- Dry-Run: ${result.dryRun}\n- Dauer: ${result.durationMs} ms\n- Runtime-Budget: ${result.maxRuntimeMs} ms\n- Job-Budget: ${result.maxJobRuntimeMs} ms\n- Lock: \`${result.lockPath}\`\n- JSON: \`${result.jsonPath}\`\n\n## Jobs\n\n| Job | Status | Dauer ms | Summary |\n|---|---:|---:|---|\n${rows}\n\n## Intelligence Signals\n\n${signals}\n\n## Nächste Aktionen\n\n${actions}\n`
}

function acquireLock(vault: Vault, relativePath: string): string | null {
  const path = vaultJoin(vault.vaultPath, relativePath)
  let fd: number
  try {
    fd = openSync(path, 'wx')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null
    throw err
  }
  try {
    writeFileSync(fd, `${process.pid}\n${nowIso()}\n`, 'utf-8')
  } finally {
    closeSync(fd)
  }
  return path
}

function releaseLock(fullPath: string | null): void {
  if (!fullPath) return
  try {
    unlinkSync(fullPath)
  } catch {}
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function autoBuildManifestHashes(vault: Vault): Map<string, { hash: string }> {
  const path = vaultJoin(vault.vaultPath, '.brain-auto-build-manifest.json')
  if (!existsSync(path)) return new Map()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
      version?: unknown
      sources?: Record<string, { hash?: unknown }>
    }
    if (parsed.version !== 1 || !parsed.sources || typeof parsed.sources !== 'object' || Array.isArray(parsed.sources)) {
      throw new Error('version=1 und sources-Objekt erforderlich')
    }
    return new Map(Object.entries(parsed.sources).map(([source, entry]) => {
      if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string') {
        throw new Error(`ungültiger Source-Eintrag: ${source}`)
      }
      return [source, { hash: entry.hash }]
    }))
  } catch (error) {
    throw new Error(`Auto-Build-Manifest ist beschädigt: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function createdNoteCount(result: ReturnType<Vault['brainAutoBuild']>): number {
  let count = 0
  for (const step of result.steps) {
    if (!step.applied || !['save_insight', 'save_answer', 'flag_knowledge_gap', 'extract_claims', 'generate_runbook'].includes(step.step)) continue
    const detail = step.result && typeof step.result === 'object' ? step.result as Record<string, unknown> : {}
    const list = Array.isArray(detail.written) ? detail.written : Array.isArray(detail.paths) ? detail.paths : null
    count += list ? list.filter(value => typeof value === 'string' && value.endsWith('.md')).length : 1
  }
  return count
}

function runAutoBuildQueue(vault: Vault, options: BackgroundRunOptions & { dryRun: boolean; maxJobRuntimeMs: number }): unknown {
  if (options.sourcePath) {
    return vault.brainAutoBuild({ sourcePath: options.sourcePath, client: options.client, dryRun: options.dryRun })
  }

  const policy = loadBrainPolicy()
  const manifest = autoBuildManifestHashes(vault)
  const queued = [...vault.notes.values()]
    .filter(isActiveNote)
    .filter(isAutoCaptureNote)
    .filter(note => !options.client || String(note.frontmatter.kunde ?? '').toLowerCase() === options.client.toLowerCase())
    .filter(note => {
      const previous = manifest.get(note.relativePath)
      // Archiving is explicit negative feedback. Do not silently reprocess an
      // unchanged archived source; a later source edit changes the hash and
      // makes it eligible again.
      return !previous || previous.hash !== contentHash(note.content)
    })
    .sort((a, b) => a.lastModified - b.lastModified || a.relativePath.localeCompare(b.relativePath))

  const maxSources = Math.max(1, Math.min(options.maxAutoBuildSources ?? 3, 50))
  const started = Date.now()
  let remainingNotes = policy.automation.limits.maxNewNotesPerRun
  const results: Array<{ sourcePath: string; result: ReturnType<Vault['brainAutoBuild']> }> = []
  for (const note of queued.slice(0, maxSources)) {
    if (Date.now() - started >= options.maxJobRuntimeMs || remainingNotes <= 0) break
    const result = vault.brainAutoBuild({
      sourcePath: note.relativePath,
      client: typeof note.frontmatter.kunde === 'string' ? note.frontmatter.kunde : options.client,
      dryRun: options.dryRun,
      maxNewNotes: remainingNotes,
    })
    results.push({ sourcePath: note.relativePath, result })
    if (!options.dryRun) remainingNotes = Math.max(0, remainingNotes - createdNoteCount(result))
  }
  return {
    mode: 'queue',
    queued: queued.length,
    processed: results.length,
    remaining: Math.max(0, queued.length - results.length),
    maxSources,
    maxNewNotes: policy.automation.limits.maxNewNotesPerRun,
    results,
  }
}

type NormalizedJobOptions = Required<Pick<BackgroundRunOptions, 'dryRun' | 'maxRuntimeMs' | 'maxJobRuntimeMs'>> & BackgroundRunOptions

export function runBackgroundJobInProcess(vault: Vault, id: string, options: NormalizedJobOptions): BackgroundJobResult {
  const started = Date.now()
  const ok = (label: string, detail: unknown, summary = summarizeUnknown(detail)): BackgroundJobResult => ({
    id,
    label,
    status: 'ok',
    durationMs: Date.now() - started,
    summary,
    detail,
  })
  const warn = (label: string, detail: unknown, summary = summarizeUnknown(detail)): BackgroundJobResult => ({
    id,
    label,
    status: 'warn',
    durationMs: Date.now() - started,
    summary,
    detail,
  })
  const fail = (label: string, detail: unknown, summary = summarizeUnknown(detail)): BackgroundJobResult => ({
    id,
    label,
    status: 'fail',
    durationMs: Date.now() - started,
    summary,
    detail,
  })

  switch (id) {
    case 'brain_health_check': {
      const result = vault.brainHealthCheck({ checkHooks: true })
      return result.status === 'ok'
        ? ok('Brain Health Check', result, `ok ${result.summary.ok}, warn ${result.summary.warn}, fail ${result.summary.fail}`)
        : result.status === 'fail'
          ? fail('Brain Health Check', result, `status=${result.status}; ok ${result.summary.ok}, warn ${result.summary.warn}, fail ${result.summary.fail}`)
          : warn('Brain Health Check', result, `status=${result.status}; ok ${result.summary.ok}, warn ${result.summary.warn}, fail ${result.summary.fail}`)
    }
    case 'brain_metrics':
      return ok('Brain Metrics', vault.brainMetrics())
    case 'build_brain_dashboard':
      return ok('Brain Dashboard', vault.buildBrainDashboard({ dryRun: options.dryRun }))
    case 'build_capture_review':
      return ok('Capture Review', vault.buildCaptureReview({ dryRun: options.dryRun }))
    case 'build_evidence_dashboard':
      return ok('Evidence Dashboard', vault.buildEvidenceDashboard({ dryRun: options.dryRun }))
    case 'build_knowledge_inbox':
      return ok('Knowledge Inbox', vault.buildKnowledgeInbox({ dryRun: options.dryRun }))
    case 'build_change_ledger':
      return ok('Change Ledger', vault.buildChangeLedger({ dryRun: options.dryRun }))
    case 'build_knowledge_index':
      return ok('Knowledge Index', vault.buildKnowledgeIndex({ dryRun: options.dryRun }))
    case 'brain_schedule': {
      const result = vault.proposeBrainSchedule()
      return ok('Brain Schedule', result, `${result.items.length} Vorschlag/Vorschläge`)
    }
    case 'migrate_brain_metadata_preview':
      return ok('Metadata Migration Preview', vault.migrateBrainMetadata({ dryRun: true }), 'Dry-Run bleibt erzwungen')
    case 'safe_maintenance_preview':
      return ok('Safe Maintenance Preview', vault.runSafeMaintenance({ dryRun: true }), 'Dry-Run bleibt erzwungen')
    case 'semantic_index_preview':
      return ok('Semantic Index Preview', vault.rebuildSemanticIndex({ dryRun: true }), 'Dry-Run bleibt erzwungen')
    case 'hook_repair_preview':
      return ok('Hook Repair Preview', planClaudeHookInstall({ vaultPath: vault.vaultPath, settingsPath: options.settingsPath }), 'Dry-Run bleibt erzwungen')
    case 'build_memory_timeline':
      return options.client
        ? ok('Customer Timeline', vault.buildMemoryTimeline({ client: options.client, dryRun: options.dryRun }))
        : { id, label: 'Customer Timeline', status: 'skipped', durationMs: Date.now() - started, summary: 'Kein client gesetzt' }
    case 'build_customer_snapshot':
      return options.client
        ? ok('Customer Snapshot', vault.buildCustomerSnapshot({ client: options.client, dryRun: options.dryRun }))
        : { id, label: 'Customer Snapshot', status: 'skipped', durationMs: Date.now() - started, summary: 'Kein client gesetzt' }
    case 'brain_auto_build':
      return options.runAutoBuild
        ? ok('Brain Auto-Build', runAutoBuildQueue(vault, {
          ...options,
          dryRun: options.dryRun,
          maxJobRuntimeMs: options.maxJobRuntimeMs ?? Math.min(10000, options.maxRuntimeMs),
        }))
        : { id, label: 'Brain Auto-Build', status: 'skipped', durationMs: Date.now() - started, summary: 'run_auto_build ist nicht gesetzt' }
    default:
      return { id, label: id, status: 'skipped', durationMs: Date.now() - started, summary: 'Unbekannter oder deaktivierter Background-Job' }
  }
}

function runIsolatedJob(vault: Vault, id: string, options: NormalizedJobOptions, timeoutMs: number): BackgroundJobResult {
  const started = Date.now()
  const { port1, port2 } = new MessageChannel()
  const worker = new Worker(BACKGROUND_JOB_WORKER, {
    workerData: { input: { vaultPath: vault.vaultPath, id, options }, port: port2 },
    transferList: [port2],
  })
  const deadline = started + Math.max(1, timeoutMs)
  while (Date.now() < deadline) {
    const received = receiveMessageOnPort(port1)
    if (received) {
      port1.close()
      void worker.terminate()
      const message = received.message as { result?: BackgroundJobResult; error?: string }
      if (message.error) throw new Error(message.error)
      if (!message.result) throw new Error('Ungültige Background-Worker-Antwort')
      return { ...message.result, durationMs: Date.now() - started }
    }
    Atomics.wait(WAIT_ARRAY, 0, 0, Math.min(10, Math.max(1, deadline - Date.now())))
  }
  port1.close()
  void worker.terminate()
  throw new Error(`Hard timeout nach ${Math.max(1, timeoutMs)} ms`)
}

export function runBackgroundBrain(vault: Vault, options: BackgroundRunOptions = {}): BackgroundRunResult {
  const dryRun = options.dryRun ?? true
  const maxRuntimeMs = clampRuntime(options.maxRuntimeMs)
  const maxJobRuntimeMs = clampJobRuntime(options.maxJobRuntimeMs, maxRuntimeMs)
  const lockPath = options.lockPath ?? DEFAULT_LOCK_PATH
  const generatedAt = nowIso()
  const started = Date.now()
  const previousBacklog = previousReviewBacklog(vault)
  const requestedJobs = normalizeJobs(options.jobs)
  let lockFullPath: string | null = null

  try {
    // The lock is itself a write. Validate its target and the runner policy
    // before touching disk, including for otherwise read-only dry-runs.
    assertCanWriteTool('brain_run_background', [lockPath, BACKGROUND_REPORT_PATH, BACKGROUND_JSON_PATH])
    lockFullPath = acquireLock(vault, lockPath)
    if (!lockFullPath) {
      const resultWithoutContent = {
        dryRun,
        status: 'fail' as const,
        generatedAt,
        durationMs: Date.now() - started,
        maxRuntimeMs,
        maxJobRuntimeMs,
        lockPath,
        reportPath: BACKGROUND_REPORT_PATH,
        jsonPath: BACKGROUND_JSON_PATH,
        jobs: [{
          id: 'lock',
          label: 'Background Lock',
          status: 'fail' as const,
          durationMs: 0,
          summary: `Lock existiert bereits: ${lockPath}`,
        }],
        nextActions: [`Bestehenden Background-Lauf prüfen oder stale Lock entfernen: ${lockPath}`],
      }
      return { ...resultWithoutContent, content: formatReport(resultWithoutContent) }
    }

    // Fail before any apply-mode job can touch a generated surface. The lock is
    // intentionally acquired first so this preflight is serialized with other
    // background runs, but it is always released by the finally block below.
    if (!dryRun) {
      assertGeneratedSurfaceOwnership(vault.vaultPath, BACKGROUND_REPORT_PATH, 'brain-run-background')
      preflightApplyJobs(vault, requestedJobs, options)
    }

    const jobs: BackgroundJobResult[] = []
    for (const job of requestedJobs) {
      if (Date.now() - started >= maxRuntimeMs) {
        jobs.push({ id: job, label: job, status: 'skipped', durationMs: 0, summary: 'Runtime-Budget erreicht' })
        continue
      }
      const jobStarted = Date.now()
      try {
        const normalizedOptions = { ...options, dryRun, maxRuntimeMs, maxJobRuntimeMs }
        const remainingRuntimeMs = Math.max(1, maxRuntimeMs - (Date.now() - started))
        const result = options.isolateJobs === false
          ? runBackgroundJobInProcess(vault, job, normalizedOptions)
          : runIsolatedJob(vault, job, normalizedOptions, Math.min(maxJobRuntimeMs, remainingRuntimeMs))
        const totalDurationMs = Date.now() - started
        if (result.durationMs > maxJobRuntimeMs) {
          jobs.push({
            ...result,
            status: 'fail',
            summary: `Job-Budget ${maxJobRuntimeMs} ms überschritten (${result.durationMs} ms): ${result.summary}`,
          })
        } else if (totalDurationMs > maxRuntimeMs) {
          jobs.push({
            ...result,
            status: 'fail',
            summary: `Gesamt-Runtime-Budget ${maxRuntimeMs} ms überschritten: ${result.summary}`,
          })
        } else {
          jobs.push(result)
        }
      } catch (err) {
        jobs.push({
          id: job,
          label: job,
          status: 'fail',
          durationMs: Date.now() - jobStarted,
          summary: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (!dryRun && options.isolateJobs !== false) vault.refreshIndex()

    const currentBacklog = metricsOperations(jobs)?.reviewBacklogOpen
    const reviewBacklogGrew = previousBacklog !== null
      && typeof currentBacklog === 'number'
      && currentBacklog > previousBacklog
    const resultWithoutContent = {
      dryRun,
      status: statusFromJobs(jobs, reviewBacklogGrew),
      generatedAt,
      durationMs: Date.now() - started,
      maxRuntimeMs,
      maxJobRuntimeMs,
      lockPath,
      reportPath: BACKGROUND_REPORT_PATH,
      jsonPath: BACKGROUND_JSON_PATH,
      jobs,
      nextActions: nextActions(jobs, reviewBacklogGrew),
    }
    const content = formatReport(resultWithoutContent)
    const result: BackgroundRunResult = { ...resultWithoutContent, content }

    if (!dryRun) {
      mkdirSync(join(vault.vaultPath, 'Maintenance'), { recursive: true })
      atomicWriteFileSync(vaultJoin(vault.vaultPath, BACKGROUND_REPORT_PATH), content)
      atomicWriteJsonSync(vaultJoin(vault.vaultPath, BACKGROUND_JSON_PATH), { ...result, content: undefined })
      const fullPath = vaultJoin(vault.vaultPath, BACKGROUND_REPORT_PATH)
      vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
      vault.buildLinkIndex()
      appendActionLog(vault.vaultPath, {
        tool: 'brain_run_background',
        mode: 'apply',
        targets: [BACKGROUND_REPORT_PATH, BACKGROUND_JSON_PATH],
        summary: `Background Run abgeschlossen: ${result.status}; ${jobs.length} Job(s)`,
        meta: { status: result.status, jobs: jobs.length, dryRun },
      })
    }

    return result
  } finally {
    releaseLock(lockFullPath)
  }
}
