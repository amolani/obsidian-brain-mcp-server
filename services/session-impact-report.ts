import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { classifyIntent, type ClassifiedIntent } from './intent-classifier.ts'
import { assertCanWriteTool } from './policy.ts'
import { sanitizePathSegment, uniqueRelativePath, vaultJoin } from './vault-paths.ts'

export interface ImpactStep {
  step: string
  applied: boolean
  skipped: boolean
  summary: string
  result?: unknown
}

export interface ImpactPlanItem {
  action: string
  title: string
  sourcePath: string | null
  quality: 'pass' | 'skip'
  reason: string
}

export interface AutoBuildImpactSnapshot {
  dryRun: boolean
  mode: string
  sourcePath: string | null
  client: string | null
  intent: ClassifiedIntent
  plan: ImpactPlanItem[]
  steps: ImpactStep[]
  reportPath: string | null
}

export interface BuildSessionImpactReportOptions {
  sourcePath: string
  autoBuild?: AutoBuildImpactSnapshot
  dryRun?: boolean
}

export interface SessionImpactReportResult {
  dryRun: boolean
  path: string
  sourcePath: string
  intent: ClassifiedIntent
  createdCount: number
  skippedCount: number
  reviewCount: number
  content: string
}

interface ManifestEntry {
  artifacts?: string[]
  reportPath?: string | null
  impactReportPath?: string | null
  intent?: ClassifiedIntent
  plan?: ImpactPlanItem[]
  steps?: Array<{ step: string; applied: boolean; skipped: boolean; summary: string }>
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function readManifest(vault: Vault): Record<string, ManifestEntry> {
  try {
    const path = vaultJoin(vault.vaultPath, '.brain-auto-build-manifest.json')
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { sources?: Record<string, ManifestEntry> }
    return parsed.sources ?? {}
  } catch {
    return {}
  }
}

function artifactPaths(snapshot: AutoBuildImpactSnapshot | null, manifest: ManifestEntry | undefined): string[] {
  const artifacts = new Set<string>(manifest?.artifacts ?? [])
  if (snapshot?.reportPath) artifacts.add(snapshot.reportPath)
  for (const step of snapshot?.steps ?? []) {
    if (!step.applied || !step.result || typeof step.result !== 'object') continue
    const result = step.result as { path?: unknown; outputPath?: unknown; written?: unknown; paths?: unknown }
    for (const value of [result.path, result.outputPath]) {
      if (typeof value === 'string' && value.endsWith('.md')) artifacts.add(value)
    }
    if (Array.isArray(result.written)) {
      for (const value of result.written) if (typeof value === 'string' && value.endsWith('.md')) artifacts.add(value)
    }
    if (Array.isArray(result.paths)) {
      for (const value of result.paths) if (typeof value === 'string' && value.endsWith('.md')) artifacts.add(value)
    }
  }
  return [...artifacts].sort()
}

function sourceIntent(vault: Vault, sourcePath: string, manifest: ManifestEntry | undefined): ClassifiedIntent {
  if (manifest?.intent) return manifest.intent
  const source = vault.notes.get(sourcePath)
  return source ? classifyIntent(source.content, source.tags) : classifyIntent('', [])
}

function provisionalClaims(vault: Vault, sourcePath: string): string[] {
  return [...vault.notes.values()]
    .filter(note => note.tags.includes('claim'))
    .filter(note => note.frontmatter.quelle === sourcePath)
    .filter(note => note.frontmatter.claim_status === 'provisional')
    .map(note => note.relativePath)
    .sort()
}

function uncertainClient(source: NoteEntry | undefined): string | null {
  const method = String(source?.frontmatter.client_match_method ?? '')
  if (!['fuzzy_cwd', 'exact_content'].includes(method)) return null
  const confidence = String(source?.frontmatter.client_match_confidence ?? 'unknown')
  const candidate = source?.frontmatter.client_match_candidate ? `; Kandidat ${source.frontmatter.client_match_candidate}` : ''
  const alias = source?.frontmatter.client_match_alias ? `; Alias ${source.frontmatter.client_match_alias}` : ''
  return `${method}/${confidence}${candidate}${alias}`
}

function renderList(values: string[]): string {
  return values.length > 0 ? values.map(value => `- ${value}`).join('\n') : '- Keine'
}

function renderLinkedList(values: string[]): string {
  return values.length > 0 ? values.map(value => `- [[${value}|${basename(value, '.md')}]]`).join('\n') : '- Keine'
}

function renderImpactReport(
  vault: Vault,
  sourcePath: string,
  snapshot: AutoBuildImpactSnapshot | null,
  manifest: ManifestEntry | undefined,
  path: string,
): SessionImpactReportResult {
  const source = vault.notes.get(sourcePath)
  const intent = snapshot?.intent ?? sourceIntent(vault, sourcePath, manifest)
  const plan = snapshot?.plan ?? manifest?.plan ?? []
  const steps = snapshot?.steps ?? manifest?.steps ?? []
  const artifacts = artifactPaths(snapshot, manifest).filter(artifact => artifact !== sourcePath && artifact !== path)
  const skipped = steps.filter(step => step.skipped)
  const applied = steps.filter(step => step.applied)
  const claims = provisionalClaims(vault, sourcePath)
  const clientReview = uncertainClient(source)
  const skippedPlan = plan.filter(item => item.quality === 'skip')
  const reviewItems = [
    ...claims.map(claim => `Provisional Claim prüfen: [[${claim}|${basename(claim, '.md')}]]`),
    ...skippedPlan.map(item => `${item.action}: ${item.reason}`),
    ...(clientReview ? [`Kundenzuordnung prüfen: ${clientReview}`] : []),
  ]
  const nextActions = [
    claims.length > 0 ? `${claims.length} provisional Claim(s) prüfen und bei belastbarer Quelle bestätigen.` : '',
    clientReview ? 'Kundenalias im Capture Review bestätigen oder clients.json ergänzen.' : '',
    skippedPlan.some(item => item.action === 'generate_runbook') ? 'Runbook erst nach validierter Umsetzung oder manuellem Dry-Run promoten.' : '',
    'Knowledge Inbox und Capture Review für nächste Review-Runde aktualisieren.',
  ].filter(Boolean)

  const content = `---\nstatus: aktiv\ntags:\n  - session-impact\n  - maintenance\naktualisiert: ${new Date().toISOString()}\nquelle: session-impact-report\nsource: ${sourcePath}\nsession_intent: ${intent.intent}\nintent_confidence: ${intent.confidence}\n---\n\n# Session Impact\n\nQuelle: [[${sourcePath}|${source?.title ?? basename(sourcePath, '.md')}]]\nClient: ${snapshot?.client ?? source?.frontmatter.kunde ?? '(keiner)'}\nIntent: ${intent.intent} (${intent.confidence})\nAuto-Build Mode: ${snapshot?.mode ?? '(aus Manifest)'}\nAuto-Build Report: ${snapshot?.reportPath ? `[[${snapshot.reportPath}|Report]]` : manifest?.reportPath ? `[[${manifest.reportPath}|Report]]` : '(keiner)'}\n\n## Warum dieser Intent?\n\n${renderList(intent.reasons)}\n\n## Was wurde geschrieben?\n\n${renderLinkedList(artifacts)}\n\n## Auto-Build Schritte\n\n${steps.length > 0 ? steps.map(step => `- ${step.applied ? '[x]' : step.skipped ? '[!]' : '[ ]'} \`${step.step}\`: ${step.summary}`).join('\n') : '- Keine Schritte gefunden'}\n\n## Übersprungen / Review nötig\n\n${renderList(reviewItems)}\n\n## Promotion Plan\n\n${plan.length > 0 ? plan.map(item => `- **${item.quality}** \`${item.action}\` ${item.title} - ${item.reason}`).join('\n') : '- Kein Plan gefunden'}\n\n## Nächste Aktionen\n\n${renderList(nextActions)}\n`

  return {
    dryRun: false,
    path,
    sourcePath,
    intent,
    createdCount: applied.length + artifacts.length,
    skippedCount: skipped.length + skippedPlan.length,
    reviewCount: reviewItems.length,
    content,
  }
}

export function buildSessionImpactReport(vault: Vault, options: BuildSessionImpactReportOptions): SessionImpactReportResult {
  const dryRun = options.dryRun ?? true
  const manifest = readManifest(vault)[options.sourcePath]
  const base = sanitizePathSegment(`${today()}-${basename(options.sourcePath, '.md')}`)
  const path = dryRun
    ? `Maintenance/Session Impact/${base}.md`
    : uniqueRelativePath(vault.vaultPath, 'Maintenance/Session Impact', `${base}.md`)
  const result = { ...renderImpactReport(vault, options.sourcePath, options.autoBuild ?? null, manifest, path), dryRun }

  if (!dryRun) {
    assertCanWriteTool('build_session_impact_report', [path])
    mkdirSync(join(vault.vaultPath, 'Maintenance', 'Session Impact'), { recursive: true })
    const fullPath = vaultJoin(vault.vaultPath, path)
    writeFileSync(fullPath, result.content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'build_session_impact_report',
      mode: 'apply',
      targets: [path],
      summary: `Session Impact Report geschrieben: ${options.sourcePath}`,
      meta: { sourcePath: options.sourcePath, intent: result.intent.intent, reviewCount: result.reviewCount },
    })
  }

  return result
}
