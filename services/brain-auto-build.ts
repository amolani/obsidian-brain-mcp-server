import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SaveKnowledgeOptions, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { autoBuildFeedbackCategory, brainAutoBuildLearning, type BrainAutoBuildLearning } from './brain-feedback.ts'
import { assertCanWriteTool, loadBrainPolicy } from './policy.ts'
import { sanitizePathSegment, vaultJoin } from './vault-paths.ts'

export interface BrainAutoBuildOptions {
  sourcePath?: string
  client?: string
  dryRun?: boolean
  maxClaims?: number
  maxNewNotes?: number
}

export interface BrainAutoBuildStep {
  step: string
  applied: boolean
  skipped: boolean
  summary: string
  result?: unknown
}

export interface BrainAutoBuildPlanItem {
  id: string
  action: string
  title: string
  sourcePath: string | null
  quality: 'pass' | 'skip'
  reason: string
}

export interface BrainAutoBuildResult {
  dryRun: boolean
  mode: 'auto_build' | 'review_only' | 'off'
  sourcePath: string | null
  client: string | null
  plan: BrainAutoBuildPlanItem[]
  steps: BrainAutoBuildStep[]
  manifestPath: string
  reportPath: string | null
}

interface AutoBuildBudget {
  maxNewNotes: number
  newNotes: number
  deadline: number
}

interface AutoBuildManifestEntry {
  sourcePath: string
  hash: string
  promotedAt: string
  archivedAt?: string
  archiveFolder?: string
  artifacts: string[]
  reportPath?: string | null
  plan: BrainAutoBuildPlanItem[]
  steps: Array<{ step: string; applied: boolean; skipped: boolean; summary: string }>
}

interface AutoBuildManifest {
  version: 1
  sources: Record<string, AutoBuildManifestEntry>
}

export const AUTO_BUILD_MANIFEST_PATH = '.brain-auto-build-manifest.json'

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function textSection(content: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^##\\s+|$)`, 'im')
  return content.match(pattern)?.[1]?.trim() ?? ''
}

function firstUsefulParagraph(content: string): string {
  return content
    .split(/\n\s*\n/)
    .map(part => part.replace(/^[-*#>\s]+/gm, '').replace(/\s+/g, ' ').trim())
    .find(part => part.length >= 40)
    ?.slice(0, 900) ?? ''
}

function sourceTitle(vault: Vault, sourcePath?: string): string {
  if (!sourcePath) return 'Vault Auto-Build'
  return vault.notes.get(sourcePath)?.title ?? sourcePath.replace(/\.md$/, '').split('/').pop() ?? sourcePath
}

function sourceContent(vault: Vault, sourcePath?: string): string {
  return sourcePath ? vault.notes.get(sourcePath)?.content ?? '' : ''
}

function sourceHash(vault: Vault, sourcePath?: string): string {
  return createHash('sha256').update(sourceContent(vault, sourcePath)).digest('hex')
}

function isAutoCapture(vault: Vault, sourcePath?: string): boolean {
  if (!sourcePath) return false
  const note = vault.notes.get(sourcePath)
  return !!note && (note.tags.includes('auto-capture') || note.frontmatter.quelle === 'knowledge-harvester')
}

function pushStep(steps: BrainAutoBuildStep[], step: string, fn: () => unknown, dryRun: boolean): void {
  try {
    const result = fn()
    const skippedResult = !!(result && typeof result === 'object' && 'skipped' in result && (result as { skipped?: unknown }).skipped === true)
    steps.push({
      step,
      applied: !dryRun && !skippedResult,
      skipped: skippedResult,
      summary: skippedResult
        ? `${step} skipped: ${String((result as { reason?: unknown }).reason ?? 'quality gate')}`
        : `${step} ${dryRun ? 'previewed' : 'applied'}`,
      result,
    })
  } catch (err) {
    steps.push({
      step,
      applied: false,
      skipped: true,
      summary: err instanceof Error ? err.message : String(err),
    })
  }
}

function pushLimitedStep(steps: BrainAutoBuildStep[], step: string, budget: AutoBuildBudget, estimatedNewNotes: number, fn: () => unknown, dryRun: boolean): void {
  if (Date.now() > budget.deadline) {
    steps.push({ step, applied: false, skipped: true, summary: 'Auto-build runtime limit erreicht' })
    return
  }
  if (!dryRun && estimatedNewNotes > 0 && budget.newNotes + estimatedNewNotes > budget.maxNewNotes) {
    steps.push({ step, applied: false, skipped: true, summary: `Auto-build note limit erreicht (${budget.newNotes}/${budget.maxNewNotes})` })
    return
  }
  const before = steps.length
  pushStep(steps, step, fn, dryRun)
  const latest = steps[before]
  if (latest?.applied && estimatedNewNotes > 0) budget.newNotes += estimatedNewNotes
}

function readManifest(vault: Vault): AutoBuildManifest {
  try {
    const path = vaultJoin(vault.vaultPath, AUTO_BUILD_MANIFEST_PATH)
    if (!existsSync(path)) return { version: 1, sources: {} }
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AutoBuildManifest>
    return { version: 1, sources: parsed.sources ?? {} }
  } catch {
    return { version: 1, sources: {} }
  }
}

function writeManifest(vault: Vault, manifest: AutoBuildManifest): void {
  writeFileSync(vaultJoin(vault.vaultPath, AUTO_BUILD_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(w => w.length >= 4))
}

function similarity(a: string, b: string): number {
  const left = words(a)
  const right = words(b)
  if (left.size === 0 || right.size === 0) return 0
  const intersection = [...left].filter(word => right.has(word)).length
  return intersection / Math.max(left.size, right.size)
}

function isBanal(content: string): boolean {
  return /^(ok|done|erledigt|weiter|keine|nichts|test)$/i.test(content.trim()) || content.trim().length < 35
}

function hasSimilarKnowledge(vault: Vault, title: string, content: string, folders: string[]): boolean {
  return [...vault.notes.values()].some(note => {
    if (!folders.some(folder => note.relativePath.startsWith(folder))) return false
    if (note.frontmatter.quelle && String(note.frontmatter.quelle) === title) return true
    return similarity(`${note.title}\n${note.content}`, `${title}\n${content}`) >= 0.76
  })
}

function learningGate(learning: BrainAutoBuildLearning, action: string): BrainAutoBuildLearning['categories'][string] | null {
  return learning.categories[autoBuildFeedbackCategory(action)] ?? null
}

function gateKnowledge(vault: Vault, action: string, title: string, content: string, sourcePath: string, learning: BrainAutoBuildLearning): BrainAutoBuildPlanItem {
  const folder = action === 'save_answer' ? 'Knowledge/Answers/' : action === 'flag_knowledge_gap' ? 'Knowledge/Gaps/' : 'Knowledge/Insights/'
  const gate = learningGate(learning, action)
  const minLength = gate?.strict ? 120 : 35
  const duplicate = hasSimilarKnowledge(vault, title, content, [folder])
  const tooShort = isBanal(content) || content.trim().length < minLength
  const blockedByFeedback = gate?.blocked === true
  const skip = tooShort || duplicate || blockedByFeedback
  return {
    id: `${action}:${sourcePath}:${title}`.replace(/[^a-zA-Z0-9._:/-]+/g, '_').slice(0, 180),
    action,
    title,
    sourcePath,
    quality: skip ? 'skip' : 'pass',
    reason: blockedByFeedback
      ? `feedback gate blocked (${gate.rejected} rejected, ${gate.accepted} accepted)`
      : tooShort
        ? `zu kurz oder banal${gate?.strict ? ' nach Feedback-Learning' : ''}`
        : duplicate
          ? 'ähnliches Wissen existiert bereits'
          : gate?.strict
            ? 'quality gate passed (strict feedback mode)'
            : 'quality gate passed',
  }
}

function applyKnowledgePlan(vault: Vault, item: BrainAutoBuildPlanItem, options: Omit<SaveKnowledgeOptions, 'type'> & { type?: SaveKnowledgeOptions['type'] }, dryRun: boolean): unknown {
  if (item.quality === 'skip') return { skipped: true, reason: item.reason }
  if (item.action === 'save_answer') return vault.saveAnswer({ ...options, dryRun })
  if (item.action === 'save_insight') return vault.saveInsight({ ...options, dryRun })
  throw new Error(`Unsupported knowledge plan action: ${item.action}`)
}

function promoteCapture(vault: Vault, sourcePath: string, dryRun: boolean, plan: BrainAutoBuildPlanItem[], budget: AutoBuildBudget, learning: BrainAutoBuildLearning): BrainAutoBuildStep[] {
  const steps: BrainAutoBuildStep[] = []
  const title = sourceTitle(vault, sourcePath)
  const content = sourceContent(vault, sourcePath)
  const summary = firstUsefulParagraph(textSection(content, 'Zusammenfassung') || textSection(content, 'Ablauf') || content)
  if (summary) {
    const item = gateKnowledge(vault, 'save_insight', `Session Insight - ${title}`.slice(0, 100), summary, sourcePath, learning)
    plan.push(item)
    pushLimitedStep(steps, 'save_insight', budget, item.quality === 'pass' ? 1 : 0, () => applyKnowledgePlan(vault, item, {
      title: `Session Insight - ${title}`.slice(0, 100),
      content: summary,
      source: sourcePath,
      confidence: 'medium',
      checkedAt: today(),
      tags: ['auto-promoted'],
    }, dryRun), dryRun)
  }

  const fixes = textSection(content, 'Fehler und Workarounds')
  if (fixes) {
    const item = gateKnowledge(vault, 'save_answer', `Workaround - ${title}`.slice(0, 100), fixes, sourcePath, learning)
    plan.push(item)
    pushLimitedStep(steps, 'save_answer', budget, item.quality === 'pass' ? 1 : 0, () => applyKnowledgePlan(vault, item, {
      title: `Workaround - ${title}`.slice(0, 100),
      content: fixes.slice(0, 1400),
      source: sourcePath,
      confidence: 'medium',
      checkedAt: today(),
      tags: ['workaround', 'auto-promoted'],
    }, dryRun), dryRun)
  }

  if (/\b(unklar|offen|prüfen|pruefen|todo|noch klären|noch klaeren)\b/i.test(content)) {
    const question = `Welche offenen Punkte aus ${title} müssen geklärt werden?`
    const item = gateKnowledge(vault, 'flag_knowledge_gap', question, content, sourcePath, learning)
    plan.push(item)
    pushLimitedStep(steps, 'flag_knowledge_gap', budget, item.quality === 'pass' ? 1 : 0, () => item.quality === 'skip' ? { skipped: true, reason: item.reason } : vault.flagKnowledgeGap({
      question: `Welche offenen Punkte aus ${title} müssen geklärt werden?`,
      context: `Automatisch aus Session-Capture [[${sourcePath}|${title}]] erkannt.`,
      tags: ['auto-promoted'],
      dryRun,
    }), dryRun)
  }

  return steps
}

function countRunbookSignals(content: string): number {
  const commands = (content.match(/^\d+\.\s+`[^`]+`/gm) ?? []).length
  const phases = (content.match(/^###\s+\d+\./gm) ?? []).length
  const fixes = content.includes('## Fehler und Workarounds') ? 2 : 0
  return commands + phases + fixes
}

function learnedMaxClaims(learning: BrainAutoBuildLearning, requested: number): number {
  const gate = learningGate(learning, 'extract_claims')
  if (gate?.blocked) return 0
  if (gate?.strict) return Math.max(1, Math.floor(requested / 2))
  return requested
}

function learnedRunbookThreshold(learning: BrainAutoBuildLearning): number {
  const gate = learningGate(learning, 'generate_runbook')
  if (gate?.blocked) return Number.POSITIVE_INFINITY
  return gate?.strict ? 6 : 4
}

function reportPathFor(sourcePath: string | null): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const source = sourcePath ? sanitizePathSegment(sourcePath.replace(/\.md$/, '').split('/').pop() ?? 'vault') : 'vault'
  return `Maintenance/Auto-Build/${stamp}-${source}.md`
}

function renderReport(result: Omit<BrainAutoBuildResult, 'reportPath'>): string {
  const stepLines = result.steps.length > 0
    ? result.steps.map(step => `- ${step.applied ? '[x]' : step.skipped ? '[!]' : '[ ]'} \`${step.step}\`: ${step.summary}`).join('\n')
    : '- Keine Schritte'
  const planLines = result.plan.length > 0
    ? result.plan.map(item => `- **${item.quality}** \`${item.action}\` ${item.title} - ${item.reason}`).join('\n')
    : '- Kein Promotion-Plan'
  const next = result.steps.some(step => step.skipped)
    ? '- Skips im Brain Review oder Auto-Build-Plan prüfen\n- Bei zu strengen Gates Feedback/Policy anpassen'
    : '- Keine unmittelbare Aktion nötig'

  return `---\nstatus: aktiv\ntags:\n  - auto-build\n  - maintenance\naktualisiert: ${new Date().toISOString()}\nquelle: brain-auto-build\n---\n\n# Auto-Build Report\n\nQuelle: ${result.sourcePath ? `[[${result.sourcePath}]]` : '(keine)'}\nClient: ${result.client ?? '(keiner)'}\nMode: ${result.mode}\nDry-Run: ${result.dryRun}\n\n## Schritte\n\n${stepLines}\n\n## Promotion Plan\n\n${planLines}\n\n## Nächste Aktionen\n\n${next}\n`
}

function writeReport(vault: Vault, result: Omit<BrainAutoBuildResult, 'reportPath'>): string | null {
  if (result.dryRun) return null
  const path = reportPathFor(result.sourcePath)
  assertCanWriteTool('brain_auto_build', [path])
  const fullPath = vaultJoin(vault.vaultPath, path)
  mkdirSync(join(vault.vaultPath, 'Maintenance', 'Auto-Build'), { recursive: true })
  writeFileSync(fullPath, renderReport(result), 'utf-8')
  vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
  vault.buildLinkIndex()
  appendActionLog(vault.vaultPath, {
    tool: 'brain_auto_build_report',
    mode: 'apply',
    targets: [path],
    summary: `Auto-Build Report geschrieben: ${path}`,
    meta: { sourcePath: result.sourcePath, steps: result.steps.length },
  })
  return path
}

function collectArtifacts(steps: BrainAutoBuildStep[], sourcePath: string | null, reportPath: string | null): string[] {
  const artifacts = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value.endsWith('.md')) return
    if (sourcePath && value === sourcePath) return
    if (value === 'Knowledge/_brain.md' || value === 'Knowledge/index.md' || value === 'Knowledge/hot.md') return
    if (/^Kunden\/[^/]+\/_(timeline|snapshot)\.md$/.test(value)) return
    artifacts.add(value)
  }

  for (const step of steps) {
    if (!step.applied || !step.result || typeof step.result !== 'object') continue
    const result = step.result as { path?: unknown; outputPath?: unknown; written?: unknown; paths?: unknown }
    add(result.path)
    add(result.outputPath)
    if (Array.isArray(result.written)) result.written.forEach(add)
    if (Array.isArray(result.paths)) result.paths.forEach(add)
  }
  add(reportPath)
  return [...artifacts].sort()
}

function runbookTopic(vault: Vault, sourcePath: string, client: string | null): string {
  const title = sourceTitle(vault, sourcePath)
  return client && !title.toLowerCase().includes(client.toLowerCase())
    ? title
    : title
}

export function brainAutoBuild(vault: Vault, options: BrainAutoBuildOptions = {}): BrainAutoBuildResult {
  const policy = loadBrainPolicy()
  const dryRun = options.dryRun ?? policy.automation.mode !== 'auto_build'
  const sourcePath = options.sourcePath ?? null
  const client = options.client ?? null
  const steps: BrainAutoBuildStep[] = []
  const plan: BrainAutoBuildPlanItem[] = []
  const learning = brainAutoBuildLearning(vault)
  const limits = policy.automation.limits
  const budget: AutoBuildBudget = {
    maxNewNotes: options.maxNewNotes ?? limits.maxNewNotesPerRun,
    newNotes: 0,
    deadline: Date.now() + limits.maxRuntimeMs,
  }

  if (policy.automation.mode === 'off') {
    const offResult = { dryRun, mode: policy.automation.mode, sourcePath, client, plan, manifestPath: AUTO_BUILD_MANIFEST_PATH, reportPath: null, steps: [{ step: 'policy', applied: false, skipped: true, summary: 'Automation ist deaktiviert' }] }
    return offResult
  }

  const after = policy.automation.afterSession
  const manifest = readManifest(vault)
  const hash = sourcePath ? sourceHash(vault, sourcePath) : null
  const existing = sourcePath ? manifest.sources[sourcePath] : null
  const alreadyPromoted = !!existing && !existing.archivedAt && !!hash && existing.hash === hash

  if (alreadyPromoted) {
    steps.push({
      step: 'manifest',
      applied: false,
      skipped: true,
      summary: `Quelle bereits mit identischem Hash verarbeitet: ${sourcePath}`,
      result: existing,
    })
  }

  if (sourcePath && after.promoteCaptures && isAutoCapture(vault, sourcePath)) {
    if (alreadyPromoted) {
      plan.push(...(existing?.plan ?? []))
    } else {
      steps.push(...promoteCapture(vault, sourcePath, dryRun, plan, budget, learning))
    }
  }

  if (sourcePath && after.extractClaims && !alreadyPromoted) {
    const requestedClaims = Math.min(options.maxClaims ?? limits.maxClaimsPerRun, limits.maxClaimsPerRun)
    const maxClaims = learnedMaxClaims(learning, requestedClaims)
    if (maxClaims === 0) {
      steps.push({
        step: 'extract_claims',
        applied: false,
        skipped: true,
        summary: 'extract_claims skipped: feedback gate blocked',
      })
    } else {
      pushLimitedStep(steps, 'extract_claims', budget, maxClaims, () => vault.extractClaims({
        path: sourcePath,
        maxClaims,
        dryRun,
      }), dryRun)
    }
  }

  if (sourcePath && after.updateEvidence && !alreadyPromoted) {
    pushLimitedStep(steps, 'update_evidence', budget, 0, () => vault.updateEvidence({
      path: sourcePath,
      confidence: 'medium',
      source: 'brain-auto-build',
      checkedAt: today(),
      dryRun,
    }), dryRun)
  }

  if (sourcePath && after.promoteRunbooks && !alreadyPromoted) {
    const signals = countRunbookSignals(sourceContent(vault, sourcePath))
    const threshold = learnedRunbookThreshold(learning)
    const blocked = !Number.isFinite(threshold)
    const item: BrainAutoBuildPlanItem = {
      id: `generate_runbook:${sourcePath}`.replace(/[^a-zA-Z0-9._:/-]+/g, '_'),
      action: 'generate_runbook',
      title: `Runbook aus ${sourceTitle(vault, sourcePath)}`,
      sourcePath,
      quality: !blocked && signals >= threshold ? 'pass' : 'skip',
      reason: blocked
        ? 'feedback gate blocked'
        : signals >= threshold
          ? `runbook gate passed (${signals} Signale, threshold ${threshold})`
          : `zu wenig Runbook-Signale (${signals}/${threshold})`,
    }
    plan.push(item)
    pushLimitedStep(steps, 'generate_runbook', budget, item.quality === 'pass' ? 1 : 0, () => item.quality === 'skip'
      ? { skipped: true, reason: item.reason }
      : vault.generateRunbook(runbookTopic(vault, sourcePath, client), { outputFolder: client ? `Kunden/${client}` : undefined, dryRun }), dryRun)
  }

  if (after.buildDashboard) {
    pushLimitedStep(steps, 'build_brain_dashboard', budget, 0, () => vault.buildBrainDashboard({ dryRun }), dryRun)
  }

  if (after.buildKnowledgeIndex) {
    pushLimitedStep(steps, 'build_knowledge_index', budget, 0, () => vault.buildKnowledgeIndex({ dryRun }), dryRun)
  }

  if (after.updateHotCache) {
    const query = client || sourceTitle(vault, sourcePath ?? undefined)
    pushLimitedStep(steps, 'update_hot_cache', budget, 0, () => vault.updateHotCache({ query, dryRun }), dryRun)
  }

  if (client && after.buildCustomerTimeline) {
    pushLimitedStep(steps, 'build_memory_timeline', budget, 0, () => vault.buildMemoryTimeline({ client, dryRun }), dryRun)
  }

  if (client && after.buildCustomerSnapshot) {
    pushLimitedStep(steps, 'build_customer_snapshot', budget, 0, () => vault.buildCustomerSnapshot({ client, dryRun }), dryRun)
  }

  const resultWithoutReport = {
    dryRun,
    mode: policy.automation.mode,
    sourcePath,
    client,
    plan,
    steps,
    manifestPath: AUTO_BUILD_MANIFEST_PATH,
  }
  const reportPath = writeReport(vault, resultWithoutReport)

  if (!dryRun && sourcePath && hash) {
    manifest.sources[sourcePath] = {
      sourcePath,
      hash,
      promotedAt: new Date().toISOString(),
      artifacts: collectArtifacts(steps, sourcePath, reportPath),
      reportPath,
      plan,
      steps: steps.map(step => ({ step: step.step, applied: step.applied, skipped: step.skipped, summary: step.summary })),
    }
    writeManifest(vault, manifest)
    appendActionLog(vault.vaultPath, {
      tool: 'brain_auto_build',
      mode: 'apply',
      targets: [sourcePath, AUTO_BUILD_MANIFEST_PATH],
      summary: `Brain Auto-Build verarbeitet: ${sourcePath}`,
      meta: { stepCount: steps.length, planCount: plan.length, alreadyPromoted },
    })
  }

  return {
    ...resultWithoutReport,
    reportPath,
  }
}
