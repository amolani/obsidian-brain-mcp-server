import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { planClaudeHookInstall } from './claude-hooks.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export type BackgroundRunStatus = 'ok' | 'warn' | 'fail'
export type BackgroundJobStatus = 'ok' | 'warn' | 'fail' | 'skipped'

export interface BackgroundRunOptions {
  dryRun?: boolean
  jobs?: string[]
  maxRuntimeMs?: number
  lockPath?: string
  settingsPath?: string
  client?: string
  sourcePath?: string
  runAutoBuild?: boolean
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

function nowIso(): string {
  return new Date().toISOString()
}

function clampRuntime(value: number | undefined): number {
  return Math.max(1000, Math.min(value ?? 30000, 10 * 60 * 1000))
}

function normalizeJobs(jobs: string[] | undefined): string[] {
  return jobs?.length ? jobs.map(String) : DEFAULT_JOBS
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

function statusFromJobs(jobs: BackgroundJobResult[]): BackgroundRunStatus {
  if (jobs.some(job => job.status === 'fail')) return 'fail'
  if (jobs.some(job => job.status === 'warn' || job.status === 'skipped')) return 'warn'
  return 'ok'
}

function nextActions(jobs: BackgroundJobResult[]): string[] {
  return jobs
    .filter(job => job.status === 'fail' || job.status === 'warn')
    .slice(0, 8)
    .map(job => `${job.label}: ${job.summary}`)
}

function formatReport(result: Omit<BackgroundRunResult, 'content'>): string {
  const rows = result.jobs.length > 0
    ? result.jobs.map(job => `| \`${job.id}\` | ${job.status} | ${job.durationMs} | ${job.summary.replace(/\|/g, '\\|')} |`).join('\n')
    : '| - | - | - | Keine Jobs ausgeführt |'
  const actions = result.nextActions.length > 0
    ? result.nextActions.map(action => `- ${action}`).join('\n')
    : '- Keine unmittelbaren Aktionen'
  return `---\nstatus: aktiv\ntags:\n  - background-run\n  - maintenance\naktualisiert: ${result.generatedAt}\nquelle: brain-run-background\n---\n\n# Background Run Report\n\nStatus: **${result.status}**\n\n- Dry-Run: ${result.dryRun}\n- Dauer: ${result.durationMs} ms\n- Runtime-Budget: ${result.maxRuntimeMs} ms\n- Lock: \`${result.lockPath}\`\n- JSON: \`${result.jsonPath}\`\n\n## Jobs\n\n| Job | Status | Dauer ms | Summary |\n|---|---:|---:|---|\n${rows}\n\n## Nächste Aktionen\n\n${actions}\n`
}

function acquireLock(vault: Vault, relativePath: string): string | null {
  const path = vaultJoin(vault.vaultPath, relativePath)
  if (existsSync(path)) return null
  const fd = openSync(path, 'wx')
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

function runJob(vault: Vault, id: string, options: Required<Pick<BackgroundRunOptions, 'dryRun' | 'maxRuntimeMs'>> & BackgroundRunOptions): BackgroundJobResult {
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

  switch (id) {
    case 'brain_health_check': {
      const result = vault.brainHealthCheck({ checkHooks: true })
      return result.status === 'ok'
        ? ok('Brain Health Check', result, `ok ${result.summary.ok}, warn ${result.summary.warn}, fail ${result.summary.fail}`)
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
        ? ok('Brain Auto-Build', vault.brainAutoBuild({ sourcePath: options.sourcePath, client: options.client, dryRun: options.dryRun }))
        : { id, label: 'Brain Auto-Build', status: 'skipped', durationMs: Date.now() - started, summary: 'run_auto_build ist nicht gesetzt' }
    default:
      return { id, label: id, status: 'skipped', durationMs: Date.now() - started, summary: 'Unbekannter oder deaktivierter Background-Job' }
  }
}

export function runBackgroundBrain(vault: Vault, options: BackgroundRunOptions = {}): BackgroundRunResult {
  const dryRun = options.dryRun ?? true
  const maxRuntimeMs = clampRuntime(options.maxRuntimeMs)
  const lockPath = options.lockPath ?? DEFAULT_LOCK_PATH
  const generatedAt = nowIso()
  const started = Date.now()
  let lockFullPath: string | null = null

  try {
    lockFullPath = acquireLock(vault, lockPath)
    if (!lockFullPath) {
      const resultWithoutContent = {
        dryRun,
        status: 'fail' as const,
        generatedAt,
        durationMs: Date.now() - started,
        maxRuntimeMs,
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

    const jobs: BackgroundJobResult[] = []
    for (const job of normalizeJobs(options.jobs)) {
      if (Date.now() - started > maxRuntimeMs) {
        jobs.push({ id: job, label: job, status: 'skipped', durationMs: 0, summary: 'Runtime-Budget erreicht' })
        continue
      }
      try {
        jobs.push(runJob(vault, job, { ...options, dryRun, maxRuntimeMs }))
      } catch (err) {
        jobs.push({
          id: job,
          label: job,
          status: 'fail',
          durationMs: Date.now() - started,
          summary: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const resultWithoutContent = {
      dryRun,
      status: statusFromJobs(jobs),
      generatedAt,
      durationMs: Date.now() - started,
      maxRuntimeMs,
      lockPath,
      reportPath: BACKGROUND_REPORT_PATH,
      jsonPath: BACKGROUND_JSON_PATH,
      jobs,
      nextActions: nextActions(jobs),
    }
    const content = formatReport(resultWithoutContent)
    const result: BackgroundRunResult = { ...resultWithoutContent, content }

    if (!dryRun) {
      assertCanWriteTool('brain_run_background', [BACKGROUND_REPORT_PATH, BACKGROUND_JSON_PATH])
      mkdirSync(join(vault.vaultPath, 'Maintenance'), { recursive: true })
      writeFileSync(vaultJoin(vault.vaultPath, BACKGROUND_REPORT_PATH), content, 'utf-8')
      writeFileSync(vaultJoin(vault.vaultPath, BACKGROUND_JSON_PATH), `${JSON.stringify({ ...result, content: undefined }, null, 2)}\n`, 'utf-8')
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
