import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { SaveKnowledgeOptions, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { atomicWriteJsonSync } from './atomic-file.ts'
import { autoBuildFeedbackCategory, brainAutoBuildLearning, type BrainAutoBuildLearning } from './brain-feedback.ts'
import { classifyIntent, isMutatingCommand, performedCommands, type ClassifiedIntent } from './intent-classifier.ts'
import { isActiveNote, isAutoCaptureNote } from './note-scope.ts'
import { assertCanWriteTool, loadBrainPolicy } from './policy.ts'
import {
  hasCompleteDigestProvenance,
  parseSessionDigestFacts,
  type ParsedDigestFact,
} from './session-digest-facts.ts'
import { buildSessionImpactReport } from './session-impact-report.ts'
import { assertSafeRelativePath, sanitizePathSegment, uniqueRelativePath, vaultJoin } from './vault-paths.ts'

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
  intent: ClassifiedIntent
  plan: BrainAutoBuildPlanItem[]
  steps: BrainAutoBuildStep[]
  manifestPath: string
  reportPath: string | null
  impactReportPath: string | null
}

interface AutoBuildBudget {
  maxNewNotes: number
  newNotes: number
  deadline: number
}

interface ArchivedArtifactTrace {
  from: string
  to: string
}

interface SkippedArtifactTrace {
  path: string
  reason: string
}

interface AutoBuildRunRecord {
  sourcePath: string
  hash: string
  promotedAt: string
  archivedAt?: string
  supersededAt?: string
  supersededByHash?: string
  archiveFolder?: string
  artifacts: string[]
  archivedArtifacts?: ArchivedArtifactTrace[]
  archiveSkipped?: SkippedArtifactTrace[]
  reportPath?: string | null
  impactReportPath?: string | null
  intent?: ClassifiedIntent
  plan: BrainAutoBuildPlanItem[]
  steps: Array<{ step: string; applied: boolean; skipped: boolean; summary: string }>
}

interface AutoBuildManifestEntry extends AutoBuildRunRecord {
  previousRuns?: AutoBuildRunRecord[]
}

interface AutoBuildManifest {
  version: 1
  sources: Record<string, AutoBuildManifestEntry>
}

export const AUTO_BUILD_MANIFEST_PATH = '.brain-auto-build-manifest.json'
const AUTO_PROMOTION_MIN_EVIDENCE = 75
const AUTO_GAP_MIN_EVIDENCE = 45
const AUTO_PROMOTION_MIN_SALIENCE = 60

function minimumPromotionSalience(fact: ParsedDigestFact): number {
  // Stand-alone command findings are especially easy to overvalue. A result
  // therefore needs more task utility than a decision/cause/change atom.
  return fact.kind === 'result' ? 70 : AUTO_PROMOTION_MIN_SALIENCE
}

function sourceTitle(vault: Vault, sourcePath?: string): string {
  if (!sourcePath) return 'Vault Auto-Build'
  return vault.notes.get(sourcePath)?.title ?? sourcePath.replace(/\.md$/, '').split('/').pop() ?? sourcePath
}

function sourceContent(vault: Vault, sourcePath?: string): string {
  return sourcePath ? vault.notes.get(sourcePath)?.content ?? '' : ''
}

function sourceIntent(source: { content: string; tags: string[]; frontmatter: Record<string, unknown> } | null | undefined): ClassifiedIntent {
  if (!source) return classifyIntent('', [])
  const storedIntent = String(source.frontmatter.session_intent ?? '')
  const storedConfidence = String(source.frontmatter.intent_confidence ?? '')
  if (
    ['implementation', 'troubleshooting', 'research', 'planning', 'documentation', 'meeting', 'unknown'].includes(storedIntent)
    && ['low', 'medium', 'high'].includes(storedConfidence)
  ) {
    return {
      intent: storedIntent as ClassifiedIntent['intent'],
      confidence: storedConfidence as ClassifiedIntent['confidence'],
      score: Number(source.frontmatter.intent_score ?? 0),
      reasons: ['Session-Intent aus Capture-Metadaten übernommen'],
    }
  }
  return classifyIntent(source.content, source.tags)
}

function sourceHash(vault: Vault, sourcePath?: string): string {
  return createHash('sha256').update(sourceContent(vault, sourcePath)).digest('hex')
}

function isAutoCapture(vault: Vault, sourcePath?: string): boolean {
  if (!sourcePath) return false
  const note = vault.notes.get(sourcePath)
  return !!note && isAutoCaptureNote(note)
}

function isCheckpoint(vault: Vault, sourcePath?: string): boolean {
  if (!sourcePath) return false
  const note = vault.notes.get(sourcePath)
  return sourcePath.startsWith('Knowledge/Checkpoints/')
    || !!note?.tags.includes('checkpoint')
    || note?.frontmatter.source_stage === 'checkpoint'
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
  const path = vaultJoin(vault.vaultPath, AUTO_BUILD_MANIFEST_PATH)
  if (!existsSync(path)) return { version: 1, sources: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AutoBuildManifest>
    if (parsed.version !== 1 || !parsed.sources || typeof parsed.sources !== 'object' || Array.isArray(parsed.sources)) {
      throw new Error('version=1 und sources-Objekt erforderlich')
    }
    for (const [sourcePath, entry] of Object.entries(parsed.sources)) {
      if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string') {
        throw new Error(`ungültiger Source-Eintrag: ${sourcePath}`)
      }
      if (entry.artifacts !== undefined && (!Array.isArray(entry.artifacts) || entry.artifacts.some(item => typeof item !== 'string'))) {
        throw new Error(`ungültige Artefaktliste: ${sourcePath}`)
      }
      if (entry.previousRuns !== undefined && !Array.isArray(entry.previousRuns)) {
        throw new Error(`ungültige Run-Historie: ${sourcePath}`)
      }
      for (const [index, run] of (entry.previousRuns ?? []).entries()) {
        if (!run || typeof run !== 'object' || typeof run.hash !== 'string' || !Array.isArray(run.artifacts)) {
          throw new Error(`ungültiger historischer Run: ${sourcePath}#${index}`)
        }
        if (run.archivedArtifacts !== undefined && (!Array.isArray(run.archivedArtifacts) || run.archivedArtifacts.some(item => (
          !item || typeof item.from !== 'string' || typeof item.to !== 'string'
        )))) {
          throw new Error(`ungültige historische Archivspuren: ${sourcePath}#${index}`)
        }
      }
    }
    return { version: 1, sources: parsed.sources }
  } catch (error) {
    throw new Error(`Auto-Build-Manifest ist beschädigt (${AUTO_BUILD_MANIFEST_PATH}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

function writeManifest(vault: Vault, manifest: AutoBuildManifest): void {
  atomicWriteJsonSync(vaultJoin(vault.vaultPath, AUTO_BUILD_MANIFEST_PATH), manifest)
}

function activeRunRecord(entry: AutoBuildManifestEntry): AutoBuildRunRecord {
  const { previousRuns: _previousRuns, ...run } = entry
  return {
    ...run,
    artifacts: [...(run.artifacts ?? [])],
    archivedArtifacts: run.archivedArtifacts?.map(item => ({ ...item })),
    archiveSkipped: run.archiveSkipped?.map(item => ({ ...item })),
    plan: [...(run.plan ?? [])],
    steps: [...(run.steps ?? [])],
  }
}

function correctionArchiveFolder(sourcePath: string, entry: AutoBuildManifestEntry): string {
  const source = sanitizePathSegment(basename(sourcePath, '.md')) || 'source'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '')
  return assertSafeRelativePath(`Archiv/Auto-Build/Superseded/${source}/${stamp}-${entry.hash.slice(0, 12)}`)
}

function uniqueCorrectionTarget(vault: Vault, target: string, reserved: Set<string>): string {
  const extension = extname(target)
  const stem = extension ? target.slice(0, -extension.length) : target
  let candidate = target
  let counter = 2
  while (reserved.has(candidate) || existsSync(vaultJoin(vault.vaultPath, candidate))) {
    candidate = `${stem} (${counter})${extension}`
    counter++
  }
  reserved.add(candidate)
  return candidate
}

function artifactBelongsToSource(vault: Vault, artifact: string, sourcePath: string): boolean {
  const note = vault.notes.get(artifact)
  if (!note) return false
  const declaredSource = String(note.frontmatter.source ?? '')
  const generator = String(note.frontmatter.quelle ?? '')
  if (declaredSource === sourcePath || generator === sourcePath) return true
  if (generator && !['brain-auto-build', 'session-impact-report', 'runbook-generator'].includes(generator)) return false
  const linksSource = note.outgoingLinks.includes(sourcePath)
    || note.content.includes(`[[${sourcePath}`)
  if (!linksSource) return false
  return /^(?:Knowledge\/(?:Claims|Insights|Answers|Gaps)|Kunden\/[^/]+\/Runbook |Referenz\/Runbook |Maintenance\/(?:Auto-Build|Session Impact)\/)/.test(artifact)
}

interface SupersedeRunResult {
  archiveFolder: string
  archived: ArchivedArtifactTrace[]
  skipped: SkippedArtifactTrace[]
  entry: AutoBuildManifestEntry
}

/**
 * Moves every still-active artifact of the previous source revision before a
 * corrected revision is promoted. All moves are preflighted and rolled back
 * if either a move or the atomic manifest commit fails.
 */
function supersedePreviousRun(
  vault: Vault,
  manifest: AutoBuildManifest,
  sourcePath: string,
  nextHash: string,
  dryRun: boolean,
): SupersedeRunResult {
  const entry = manifest.sources[sourcePath]
  if (!entry) throw new Error(`Kein vorheriger Auto-Build-Run für Korrektur gefunden: ${sourcePath}`)
  const archiveFolder = correctionArchiveFolder(sourcePath, entry)
  const archived: ArchivedArtifactTrace[] = []
  const skipped: SkippedArtifactTrace[] = []
  const reserved = new Set<string>()
  const artifactPaths = [...new Set([
    ...(entry.artifacts ?? []),
    entry.reportPath,
    entry.impactReportPath,
  ].filter((value): value is string => typeof value === 'string' && value.endsWith('.md')))]

  for (const rawArtifact of artifactPaths) {
    const artifact = assertSafeRelativePath(rawArtifact)
    if (artifact === sourcePath || artifact === AUTO_BUILD_MANIFEST_PATH || artifact.startsWith('Archiv/')) {
      throw new Error(`Unsicheres Derived Artifact im Auto-Build-Manifest: ${artifact}`)
    }
    const sourceFull = vaultJoin(vault.vaultPath, artifact)
    if (!existsSync(sourceFull)) {
      skipped.push({ path: artifact, reason: 'vor Korrektur nicht mehr vorhanden' })
      continue
    }
    if (!artifactBelongsToSource(vault, artifact, sourcePath)) {
      throw new Error(`Derived Artifact kann der Quelle nicht sicher zugeordnet werden: ${artifact}`)
    }
    const target = uniqueCorrectionTarget(vault, `${archiveFolder}/${artifact}`, reserved)
    archived.push({ from: artifact, to: target })
  }

  const now = new Date().toISOString()
  const supersededEntry: AutoBuildManifestEntry = {
    ...entry,
    archivedAt: now,
    supersededAt: now,
    supersededByHash: nextHash,
    archiveFolder,
    archivedArtifacts: archived.map(item => ({ ...item })),
    archiveSkipped: skipped.map(item => ({ ...item })),
  }
  if (dryRun) return { archiveFolder, archived, skipped, entry: supersededEntry }

  const targets = archived.flatMap(item => [item.from, item.to])
  assertCanWriteTool('brain_auto_build', [AUTO_BUILD_MANIFEST_PATH, ...targets])
  for (const item of archived) mkdirSync(dirname(vaultJoin(vault.vaultPath, item.to)), { recursive: true })

  const moved: ArchivedArtifactTrace[] = []
  try {
    for (const item of archived) {
      const from = vaultJoin(vault.vaultPath, item.from)
      const to = vaultJoin(vault.vaultPath, item.to)
      if (existsSync(to)) throw new Error(`Archivziel existiert bereits: ${item.to}`)
      renameSync(from, to)
      moved.push(item)
    }
    manifest.sources[sourcePath] = supersededEntry
    writeManifest(vault, manifest)
  } catch (error) {
    const rollbackErrors: string[] = []
    for (const item of [...moved].reverse()) {
      const from = vaultJoin(vault.vaultPath, item.from)
      const to = vaultJoin(vault.vaultPath, item.to)
      try {
        if (!existsSync(to)) continue
        if (existsSync(from)) throw new Error(`Aktiver Pfad wurde während Rollback neu angelegt: ${item.from}`)
        mkdirSync(dirname(from), { recursive: true })
        renameSync(to, from)
      } catch (rollbackError) {
        rollbackErrors.push(`${item.to}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
    }
    manifest.sources[sourcePath] = entry
    vault.refreshIndex()
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(rollbackErrors.length > 0
      ? `Korrektur-Archivierung fehlgeschlagen (${detail}); Rollback unvollständig: ${rollbackErrors.join('; ')}`
      : `Korrektur-Archivierung fehlgeschlagen; alle Moves zurückgerollt: ${detail}`)
  }

  vault.refreshIndex()
  appendActionLog(vault.vaultPath, {
    tool: 'brain_auto_build_supersede',
    mode: 'apply',
    targets: [sourcePath, AUTO_BUILD_MANIFEST_PATH, ...archived.flatMap(item => [item.from, item.to])],
    summary: `Vorherigen Auto-Build-Run vor Korrektur superseded: ${sourcePath}`,
    meta: {
      previousHash: entry.hash,
      nextHash,
      archived: archived.length,
      missing: skipped.length,
      archiveFolder,
    },
  })
  return { archiveFolder, archived, skipped, entry: supersededEntry }
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

function normalizeGapTitle(value: string): string {
  return value
    .replace(/^#*\s*(wissenslücke|wissensluecke)\s*:\s*/i, '')
    .replace(/[?!.]+$/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function hasExistingOpenGap(vault: Vault, title: string): boolean {
  const normalized = normalizeGapTitle(title)
  if (!normalized) return false
  return [...vault.notes.values()].some(note => {
    if (!isActiveNote(note)) return false
    if (!note.relativePath.startsWith('Knowledge/Gaps/') && !note.tags.includes('knowledge-gap')) return false
    if (note.frontmatter.status === 'resolved') return false
    const heading = note.content.match(/^#\s+(.+)$/m)?.[1] ?? ''
    return normalizeGapTitle(note.title) === normalized || normalizeGapTitle(heading) === normalized
  })
}

function learningGate(learning: BrainAutoBuildLearning, action: string): BrainAutoBuildLearning['categories'][string] | null {
  return learning.categories[autoBuildFeedbackCategory(action)] ?? null
}

function gateKnowledge(vault: Vault, action: string, title: string, content: string, sourcePath: string, learning: BrainAutoBuildLearning): BrainAutoBuildPlanItem {
  const folder = action === 'save_answer' ? 'Knowledge/Answers/' : action === 'flag_knowledge_gap' ? 'Knowledge/Gaps/' : 'Knowledge/Insights/'
  const gate = learningGate(learning, action)
  const minLength = gate?.strict ? 120 : 35
  const duplicate = action === 'flag_knowledge_gap'
    ? hasExistingOpenGap(vault, title)
    : hasSimilarKnowledge(vault, title, content, [folder])
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

const FACT_LABELS: Readonly<Record<ParsedDigestFact['kind'], string>> = {
  cause: 'Ursache',
  decision: 'Entscheidung',
  change: 'Änderung',
  verification: 'Verifikation',
  result: 'Ergebnis',
  problem: 'Problem',
  open_question: 'Offene Frage',
  constraint: 'Constraint',
}

function isDurableAutoFact(fact: ParsedDigestFact): boolean {
  return fact.evidenceScore >= AUTO_PROMOTION_MIN_EVIDENCE
    && fact.salienceScore >= minimumPromotionSalience(fact)
    && hasCompleteDigestProvenance(fact)
    && !['problem', 'open_question'].includes(fact.kind)
}

function typedFactContent(facts: ParsedDigestFact[]): string {
  return facts
    .map(fact => `- **${FACT_LABELS[fact.kind]}:** ${fact.statement}`)
    .join('\n')
}

function evidenceContext(sourcePath: string, modelVersion: string | null, facts: ParsedDigestFact[]): string {
  const references = [...new Set(facts.flatMap(fact => fact.provenance.map(item => item.ref)))].slice(0, 8)
  return [
    `Automatisch aus dem strukturierten Session Digest [[${sourcePath}]] übernommen.`,
    `Modell: ${modelVersion ?? 'unbekannt'}; Evidenz-Scores: ${facts.map(fact => `${fact.id}=${fact.evidenceScore}/100`).join(', ')}.`,
    references.length > 0 ? `Evidenzreferenzen: ${references.join(', ')}.` : '',
  ].filter(Boolean).join(' ')
}

function promoteCapture(vault: Vault, sourcePath: string, dryRun: boolean, plan: BrainAutoBuildPlanItem[], budget: AutoBuildBudget, learning: BrainAutoBuildLearning): BrainAutoBuildStep[] {
  const steps: BrainAutoBuildStep[] = []
  const title = sourceTitle(vault, sourcePath)
  const content = sourceContent(vault, sourcePath)
  const digest = parseSessionDigestFacts(content)
  if (!digest.hasDigest) {
    return [{
      step: 'promote_capture',
      applied: false,
      skipped: true,
      summary: 'Auto-Capture ohne strukturierten Session Digest bleibt im Review',
    }]
  }

  const durableFacts = digest.facts.filter(isDurableAutoFact)
  const answerKinds = new Set<ParsedDigestFact['kind']>(['cause', 'change', 'verification'])
  const answerCandidates = durableFacts.filter(fact => answerKinds.has(fact.kind))
  const answerReady = answerCandidates.some(fact => fact.kind === 'change')
    && answerCandidates.some(fact => fact.kind === 'verification')
  const answerFacts = answerReady ? answerCandidates : []
  const insightFacts = durableFacts.filter(fact => !answerFacts.includes(fact))

  if (insightFacts.length > 0) {
    const insight = typedFactContent(insightFacts)
    const item = gateKnowledge(vault, 'save_insight', `Session Insight - ${title}`.slice(0, 100), insight, sourcePath, learning)
    plan.push(item)
    pushLimitedStep(steps, 'save_insight', budget, item.quality === 'pass' ? 1 : 0, () => applyKnowledgePlan(vault, item, {
      title: `Session Insight - ${title}`.slice(0, 100),
      content: insight,
      context: evidenceContext(sourcePath, digest.modelVersion, insightFacts),
      source: sourcePath,
      confidence: 'high',
      tags: ['auto-promoted', 'distilled-fact'],
    }, dryRun), dryRun)
  }

  if (answerFacts.length > 0) {
    const answer = typedFactContent(answerFacts)
    const item = gateKnowledge(vault, 'save_answer', `Belegter Fix - ${title}`.slice(0, 100), answer, sourcePath, learning)
    plan.push(item)
    pushLimitedStep(steps, 'save_answer', budget, item.quality === 'pass' ? 1 : 0, () => applyKnowledgePlan(vault, item, {
      title: `Belegter Fix - ${title}`.slice(0, 100),
      content: answer,
      context: evidenceContext(sourcePath, digest.modelVersion, answerFacts),
      source: sourcePath,
      confidence: 'high',
      tags: ['workaround', 'auto-promoted', 'distilled-fact'],
    }, dryRun), dryRun)
  }

  const openQuestions = digest.facts
    .filter(fact => fact.kind === 'open_question')
    .filter(fact => fact.salienceScore >= AUTO_PROMOTION_MIN_SALIENCE)
    .filter(fact => fact.evidenceScore >= AUTO_GAP_MIN_EVIDENCE && hasCompleteDigestProvenance(fact))
    .slice(0, 3)
  for (const fact of openQuestions) {
    const context = evidenceContext(sourcePath, digest.modelVersion, [fact])
    const item = gateKnowledge(vault, 'flag_knowledge_gap', fact.statement, context, sourcePath, learning)
    plan.push(item)
    pushLimitedStep(steps, 'flag_knowledge_gap', budget, item.quality === 'pass' ? 1 : 0, () => item.quality === 'skip' ? { skipped: true, reason: item.reason } : vault.flagKnowledgeGap({
      question: fact.statement,
      context,
      tags: ['auto-promoted', 'distilled-open-question'],
      dryRun,
    }), dryRun)
  }

  if (steps.length === 0) {
    steps.push({
      step: 'promote_capture',
      applied: false,
      skipped: true,
      summary: `Keine typisierte Tatsache mit Salienz >= ${AUTO_PROMOTION_MIN_SALIENCE}, Evidenz >= ${AUTO_PROMOTION_MIN_EVIDENCE} und vollständiger Provenienz`,
    })
  }
  return steps
}

function countLegacyRunbookSignals(content: string): number {
  const commands = (content.match(/^\d+\.\s+`[^`]+`/gm) ?? []).length
  const phases = (content.match(/^###\s+\d+\./gm) ?? []).length
  const fixes = content.includes('## Fehler und Workarounds') ? 2 : 0
  return commands + phases + fixes
}

function hasLegacyImplementationSignals(content: string): boolean {
  return performedCommands(content).some(isMutatingCommand)
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

function renderReport(result: Omit<BrainAutoBuildResult, 'reportPath' | 'impactReportPath'>): string {
  const stepLines = result.steps.length > 0
    ? result.steps.map(step => `- ${step.applied ? '[x]' : step.skipped ? '[!]' : '[ ]'} \`${step.step}\`: ${step.summary}`).join('\n')
    : '- Keine Schritte'
  const planLines = result.plan.length > 0
    ? result.plan.map(item => `- **${item.quality}** \`${item.action}\` ${item.title} - ${item.reason}`).join('\n')
    : '- Kein Promotion-Plan'
  const next = result.steps.some(step => step.skipped)
    ? '- Skips im Brain Review oder Auto-Build-Plan prüfen\n- Bei zu strengen Gates Feedback/Policy anpassen'
    : '- Keine unmittelbare Aktion nötig'

  return `---\nstatus: aktiv\ntags:\n  - auto-build\n  - maintenance\naktualisiert: ${new Date().toISOString()}\nquelle: brain-auto-build\nsession_intent: ${result.intent.intent}\nintent_confidence: ${result.intent.confidence}\n---\n\n# Auto-Build Report\n\nQuelle: ${result.sourcePath ? `[[${result.sourcePath}]]` : '(keine)'}\nClient: ${result.client ?? '(keiner)'}\nMode: ${result.mode}\nDry-Run: ${result.dryRun}\nIntent: ${result.intent.intent} (${result.intent.confidence})\n\n## Intent-Gründe\n\n${result.intent.reasons.map(reason => `- ${reason}`).join('\n')}\n\n## Schritte\n\n${stepLines}\n\n## Promotion Plan\n\n${planLines}\n\n## Nächste Aktionen\n\n${next}\n`
}

function writeReport(vault: Vault, result: Omit<BrainAutoBuildResult, 'reportPath' | 'impactReportPath'>): string | null {
  if (result.dryRun) return null
  const proposedPath = reportPathFor(result.sourcePath)
  const path = existsSync(vaultJoin(vault.vaultPath, proposedPath))
    ? uniqueRelativePath(vault.vaultPath, 'Maintenance/Auto-Build', basename(proposedPath))
    : proposedPath
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

function collectArtifacts(steps: BrainAutoBuildStep[], sourcePath: string | null, reportPath: string | null, impactReportPath: string | null): string[] {
  const artifacts = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value.endsWith('.md')) return
    if (sourcePath && value === sourcePath) return
    if (value === 'Knowledge/_brain.md' || value === 'Knowledge/index.md' || value === 'Knowledge/hot.md') return
    if (value === 'Maintenance/Knowledge Inbox.md') return
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
  add(impactReportPath)
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
  // review_only and off are policy ceilings, not caller-overridable defaults.
  const dryRun = policy.automation.mode === 'auto_build' ? options.dryRun ?? false : true
  const sourcePath = options.sourcePath ? assertSafeRelativePath(options.sourcePath) : null
  const client = options.client ?? null
  const source = sourcePath ? vault.notes.get(sourcePath) : null
  const intent = sourceIntent(source)
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
    const offResult = { dryRun, mode: policy.automation.mode, sourcePath, client, intent, plan, manifestPath: AUTO_BUILD_MANIFEST_PATH, reportPath: null, impactReportPath: null, steps: [{ step: 'policy', applied: false, skipped: true, summary: 'Automation ist deaktiviert' }] }
    return offResult
  }

  if (sourcePath && !source) throw new Error(`Auto-Build-Quelle nicht gefunden: ${sourcePath}`)
  if (!dryRun) assertCanWriteTool('brain_auto_build', [AUTO_BUILD_MANIFEST_PATH, ...(sourcePath ? [sourcePath] : [])])

  const after = policy.automation.afterSession
  const manifest = readManifest(vault)
  const hash = sourcePath ? sourceHash(vault, sourcePath) : null
  const existing = sourcePath ? manifest.sources[sourcePath] : null
  const alreadyPromoted = !!existing && !existing.archivedAt && !!hash && existing.hash === hash
  let previousRuns: AutoBuildRunRecord[] = existing?.previousRuns?.map(run => ({ ...run })) ?? []

  if (alreadyPromoted && existing) {
    const manifestStep: BrainAutoBuildStep = {
      step: 'manifest',
      applied: false,
      skipped: true,
      summary: `Quelle bereits mit identischem Hash verarbeitet: ${sourcePath}`,
      result: existing,
    }
    return {
      dryRun,
      mode: policy.automation.mode,
      sourcePath,
      client,
      intent: existing.intent ?? intent,
      plan: existing.plan ?? [],
      manifestPath: AUTO_BUILD_MANIFEST_PATH,
      reportPath: existing.reportPath ?? null,
      impactReportPath: existing.impactReportPath ?? null,
      steps: [manifestStep],
    }
  }

  if (sourcePath && hash && existing) {
    if (!existing.archivedAt) {
      // A changed source is a correction, not an unrelated second promotion.
      // Archive the complete previous run first; failures abort before any new
      // derived artifact can be written.
      const superseded = supersedePreviousRun(vault, manifest, sourcePath, hash, dryRun)
      steps.push({
        step: 'supersede_previous_run',
        applied: !dryRun,
        skipped: false,
        summary: dryRun
          ? `${superseded.archived.length} vorherige Derived Artifacts würden vor der Korrektur archiviert`
          : `${superseded.archived.length} vorherige Derived Artifacts vor der Korrektur archiviert`,
        result: {
          archiveFolder: superseded.archiveFolder,
          archived: superseded.archived,
          missing: superseded.skipped,
          previousHash: existing.hash,
          nextHash: hash,
        },
      })
      if (!dryRun) previousRuns = [...previousRuns, activeRunRecord(superseded.entry)]
    } else if (!dryRun) {
      // A manually archived run is still part of the source lineage when the
      // source is promoted again.
      previousRuns = [...previousRuns, activeRunRecord(existing)]
    }
  }

  if (sourcePath && after.promoteCaptures && isAutoCapture(vault, sourcePath)) {
    steps.push(...promoteCapture(vault, sourcePath, dryRun, plan, budget, learning))
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
        claimStatus: 'provisional',
        sourceStage: isCheckpoint(vault, sourcePath) ? 'checkpoint' : isAutoCapture(vault, sourcePath) ? 'stop_capture' : 'manual',
        dryRun,
      }), dryRun)
    }
  }

  if (sourcePath && after.updateEvidence && !alreadyPromoted) {
    const extractedEvidence = String(source?.frontmatter.evidence_quality ?? 'low')
    const evidenceConfidence = ['low', 'medium', 'high'].includes(extractedEvidence)
      ? extractedEvidence as 'low' | 'medium' | 'high'
      : 'low'
    pushLimitedStep(steps, 'update_evidence', budget, 0, () => vault.updateEvidence({
      path: sourcePath,
      confidence: evidenceConfidence,
      confirmedBy: [],
      checkedAt: null,
      dryRun,
    }), dryRun)
  }

  if (sourcePath && after.promoteRunbooks && !alreadyPromoted) {
    const content = sourceContent(vault, sourcePath)
    const digest = parseSessionDigestFacts(content)
    const autoCapture = isAutoCapture(vault, sourcePath)
    const strongDigestFacts = digest.facts.filter(fact => (
      fact.salienceScore >= AUTO_PROMOTION_MIN_SALIENCE
      && fact.evidenceScore >= AUTO_PROMOTION_MIN_EVIDENCE
      && hasCompleteDigestProvenance(fact)
    ))
    const hasStrongChange = strongDigestFacts.some(fact => fact.kind === 'change')
    const hasStrongVerification = strongDigestFacts.some(fact => fact.kind === 'verification')
    const structuredRunbookReady = digest.hasDigest && hasStrongChange && hasStrongVerification
    const signals = countLegacyRunbookSignals(content)
    const implementationSignals = hasLegacyImplementationSignals(content)
    const threshold = learnedRunbookThreshold(learning)
    const blocked = !Number.isFinite(threshold)
    const allowedIntent = ['implementation', 'troubleshooting'].includes(intent.intent)
    const evidenceGatePassed = autoCapture
      ? structuredRunbookReady
      : implementationSignals && signals >= threshold
    const item: BrainAutoBuildPlanItem = {
      id: `generate_runbook:${sourcePath}`.replace(/[^a-zA-Z0-9._:/-]+/g, '_'),
      action: 'generate_runbook',
      title: `Runbook aus ${sourceTitle(vault, sourcePath)}`,
      sourcePath,
      quality: !blocked && !isCheckpoint(vault, sourcePath) && allowedIntent && evidenceGatePassed ? 'pass' : 'skip',
      reason: blocked
        ? 'feedback gate blocked'
        : isCheckpoint(vault, sourcePath)
          ? 'Runbooks aus Zwischen-Checkpoints bleiben Review-Kandidaten'
          : !allowedIntent
            ? `Intent ${intent.intent} bleibt Review-Kandidat statt Runbook; vermutlich Recherche/Analyse`
          : autoCapture && !digest.hasDigest
            ? 'Auto-Capture ohne strukturierten Session Digest bleibt Review-Kandidat'
            : autoCapture && !hasStrongChange
              ? `keine belegte Änderung mit Salienz >= ${AUTO_PROMOTION_MIN_SALIENCE} und Evidenz >= ${AUTO_PROMOTION_MIN_EVIDENCE}`
              : autoCapture && !hasStrongVerification
                ? `keine belegte Verifikation mit Salienz >= ${AUTO_PROMOTION_MIN_SALIENCE} und Evidenz >= ${AUTO_PROMOTION_MIN_EVIDENCE}`
                : autoCapture
                  ? `structured runbook gate passed (Änderung und Verifikation mit Salienz >= ${AUTO_PROMOTION_MIN_SALIENCE}, Evidenz >= ${AUTO_PROMOTION_MIN_EVIDENCE})`
                  : !implementationSignals
                    ? 'keine umsetzenden Befehle erkannt; vermutlich Recherche/Analyse'
                    : signals >= threshold
                      ? `legacy runbook gate passed (${signals} Signale, threshold ${threshold})`
                      : `zu wenig Legacy-Runbook-Signale (${signals}/${threshold})`,
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
    intent,
    plan,
    steps,
    manifestPath: AUTO_BUILD_MANIFEST_PATH,
  }
  const reportPath = writeReport(vault, resultWithoutReport)
  const impact = sourcePath
    ? buildSessionImpactReport(vault, {
      sourcePath,
      autoBuild: { ...resultWithoutReport, reportPath },
      dryRun,
    })
    : null
  const impactReportPath = impact && !impact.dryRun ? impact.path : null

  if (!dryRun && sourcePath && hash) {
    manifest.sources[sourcePath] = {
      sourcePath,
      // Earlier steps may normalize the source frontmatter/body. Persist the
      // post-run hash so an unchanged source is not queued again next run.
      hash: sourceHash(vault, sourcePath),
      promotedAt: new Date().toISOString(),
      artifacts: collectArtifacts(steps, sourcePath, reportPath, impactReportPath),
      reportPath,
      impactReportPath,
      intent,
      plan,
      steps: steps.map(step => ({ step: step.step, applied: step.applied, skipped: step.skipped, summary: step.summary })),
      ...(previousRuns.length > 0 ? { previousRuns } : {}),
    }
    writeManifest(vault, manifest)
  }

  if (after.buildKnowledgeInbox) {
    pushLimitedStep(steps, 'build_knowledge_inbox', budget, 0, () => vault.buildKnowledgeInbox({ dryRun }), dryRun)
    if (!dryRun && sourcePath && hash) {
      manifest.sources[sourcePath].steps = steps.map(step => ({ step: step.step, applied: step.applied, skipped: step.skipped, summary: step.summary }))
      writeManifest(vault, manifest)
    }
  }

  if (!dryRun && sourcePath && hash) {
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
    impactReportPath,
  }
}
