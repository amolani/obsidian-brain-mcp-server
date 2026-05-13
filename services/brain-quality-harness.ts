import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Vault } from '../vault.ts'
import { loadBrainPolicy } from './policy.ts'

export type BrainQualityStatus = 'pass' | 'warn' | 'fail'
export type BrainQualityFixtureType =
  | 'harvester_update'
  | 'retrieval'
  | 'surface_redaction'
  | 'promotion'
  | 'review'
  | 'background'
  | 'claim_extraction'

export interface BrainQualityOptions {
  fixturesDir?: string
  keepTemp?: boolean
}

export interface BrainQualityMetric {
  id: string
  label: string
  value: number
  threshold?: number
  status: BrainQualityStatus
  detail: string
}

export interface BrainQualityFixtureResult {
  id: string
  type: BrainQualityFixtureType | 'policy'
  status: BrainQualityStatus
  score: number
  metrics: BrainQualityMetric[]
  failures: string[]
  tempPath?: string
}

export interface BrainQualityResult {
  status: BrainQualityStatus
  score: number
  generatedAt: string
  fixturesDir: string
  summary: { pass: number; warn: number; fail: number }
  hardGateFailures: string[]
  fixtures: BrainQualityFixtureResult[]
}

interface ExpectedFact {
  id: string
  pattern: string
  mustCapture?: boolean
  late?: boolean
}

interface HarvesterStep {
  name: string
  entries: unknown[]
  expectedAbsent?: string[]
}

interface HarvesterFixture {
  id: string
  type: 'harvester_update'
  description?: string
  sessionId: string
  cwd: string
  expectedClient?: string
  expectedPathIncludes?: string[]
  steps: HarvesterStep[]
  expectedFacts: ExpectedFact[]
  forbiddenPatterns?: string[]
  forbiddenSecrets?: string[]
}

interface RetrievalNote {
  path: string
  content: string
}

interface RetrievalQuery {
  query: string
  k?: number
  relevantNotes: string[]
  minPrecisionAtK?: number
  minRecallAtK?: number
  minMrrAtK?: number
  minNdcgAtK?: number
}

interface RetrievalFixture {
  id: string
  type: 'retrieval'
  notes: RetrievalNote[]
  queries: RetrievalQuery[]
}

interface SurfaceRedactionFixture {
  id: string
  type: 'surface_redaction'
  notes: RetrievalNote[]
  query: string
  client: string
  forbiddenSecrets: string[]
  forbiddenPatterns?: string[]
  requireRedactionMarker?: boolean
}

interface ExpectedPromotion {
  id: string
  pathPattern: string
  requiredPatterns: string[]
  mustPromote?: boolean
}

interface PromotionFixture {
  id: string
  type: 'promotion'
  notes: RetrievalNote[]
  sourcePath: string
  client?: string
  maxClaims?: number
  expectedPromotions: ExpectedPromotion[]
  forbiddenPatterns?: string[]
  minPromotionPrecision?: number
  minPromotionRecall?: number
  minPromotionF0_5?: number
  minFaithfulness?: number
  minEvidenceCoverage?: number
}

interface ExpectedReviewItem {
  id: string
  itemIdPattern: string
}

interface ReviewFixture {
  id: string
  type: 'review'
  notes: RetrievalNote[]
  expectedItems: ExpectedReviewItem[]
  resolveItemPattern?: string
  minReviewCoverage?: number
}

interface BackgroundFixture {
  id: string
  type: 'background'
  notes: RetrievalNote[]
  jobs?: string[]
  maxRuntimeMs?: number
  lockPath?: string
  requireActionLog?: boolean
}

interface ClaimExtractionFixture {
  id: string
  type: 'claim_extraction'
  notes: RetrievalNote[]
  sourcePath: string
  maxClaims?: number
  expectedClaimPatterns: string[]
  forbiddenClaimPatterns: string[]
  minClaimPrecision?: number
  minClaimRecall?: number
  minClaimF0_5?: number
}

type BrainQualityFixture =
  | HarvesterFixture
  | RetrievalFixture
  | SurfaceRedactionFixture
  | PromotionFixture
  | ReviewFixture
  | BackgroundFixture
  | ClaimExtractionFixture

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_FIXTURES_DIR = join(PROJECT_ROOT, 'tests', 'fixtures', 'brain-quality')
const HARVESTER = join(PROJECT_ROOT, 'hooks', 'knowledge-harvester.ts')

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function statusFromFailures(failures: string[], warnings: string[] = []): BrainQualityStatus {
  if (failures.length > 0) return 'fail'
  if (warnings.length > 0) return 'warn'
  return 'pass'
}

function metric(
  id: string,
  label: string,
  value: number,
  threshold: number | undefined,
  detail: string,
  greaterIsBetter = true,
): BrainQualityMetric {
  let status: BrainQualityStatus = 'pass'
  if (threshold !== undefined) {
    const ok = greaterIsBetter ? value >= threshold : value <= threshold
    status = ok ? 'pass' : 'fail'
  }
  return { id, label, value, threshold, status, detail }
}

function readFixture(path: string): BrainQualityFixture {
  return JSON.parse(readFileSync(path, 'utf-8')) as BrainQualityFixture
}

function listFixtureFiles(fixturesDir: string): string[] {
  if (!existsSync(fixturesDir)) return []
  return readdirSync(fixturesDir)
    .filter(file => file.endsWith('.json'))
    .map(file => join(fixturesDir, file))
    .sort()
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

function writeText(path: string, content: string): void {
  ensureParent(path)
  writeFileSync(path, content, 'utf-8')
}

function writeTranscript(path: string, entries: unknown[]): void {
  writeText(path, entries.map(entry => JSON.stringify(entry)).join('\n'))
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function markdownSnapshot(vaultPath: string): Map<string, string> {
  const snapshot = new Map<string, string>()
  for (const file of walkFiles(vaultPath)) {
    if (!file.endsWith('.md')) continue
    snapshot.set(relative(vaultPath, file), readFileSync(file, 'utf-8'))
  }
  return snapshot
}

function snapshotChanged(before: Map<string, string>, after: Map<string, string>): boolean {
  if (before.size !== after.size) return true
  for (const [path, content] of before) {
    if (after.get(path) !== content) return true
  }
  return false
}

function combinedMarkdown(snapshot: Map<string, string>): string {
  return [...snapshot.entries()]
    .map(([path, content]) => `\n--- ${path} ---\n${content}`)
    .join('\n')
}

function matchesPattern(content: string, pattern: string): boolean {
  return new RegExp(pattern, 'i').test(content)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fBeta(precision: number, recall: number, beta: number): number {
  if (precision <= 0 && recall <= 0) return 0
  const betaSquared = beta * beta
  return ((1 + betaSquared) * precision * recall) / ((betaSquared * precision) + recall)
}

function runHarvester(vaultPath: string, stateDir: string, input: Record<string, unknown>): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync('node', [HARVESTER], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...process.env,
      VAULT_PATH: vaultPath,
      HARVESTER_INPUT_JSON: JSON.stringify(input),
      HARVESTER_LOG: join(stateDir, 'harvester.log'),
      HARVESTER_STATE_DIR: stateDir,
      HARVESTER_SUGGESTIONS_LOG: join(stateDir, 'suggestions.log'),
    },
  })
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

function evaluateHarvesterFixture(fixture: HarvesterFixture, keepTemp: boolean): BrainQualityFixtureResult {
  const tempPath = mkdirTemp(`brain-quality-${fixture.id}-`)
  const vaultPath = join(tempPath, 'vault')
  const stateDir = join(tempPath, 'state')
  const transcriptPath = join(tempPath, 'transcript.jsonl')
  mkdirSync(vaultPath, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

  const failures: string[] = []
  const metrics: BrainQualityMetric[] = []
  let finalSnapshot = new Map<string, string>()
  let initialContent = ''

  try {
    for (const [index, step] of fixture.steps.entries()) {
      writeTranscript(transcriptPath, step.entries)
      const result = runHarvester(vaultPath, stateDir, {
        session_id: fixture.sessionId,
        transcript_path: transcriptPath,
        cwd: fixture.cwd,
      })
      if (result.status !== 0) {
        failures.push(`${step.name}: harvester exited with ${result.status}; ${result.stderr}`)
        continue
      }
      const snapshot = markdownSnapshot(vaultPath)
      const content = combinedMarkdown(snapshot)
      if (index === 0) initialContent = content
      if (step.expectedAbsent) {
        for (const pattern of step.expectedAbsent) {
          if (matchesPattern(content, pattern)) failures.push(`${step.name}: unexpected early match for ${pattern}`)
        }
      }
      finalSnapshot = snapshot
    }

    const finalContent = combinedMarkdown(finalSnapshot)
    const matchedFacts = fixture.expectedFacts.filter(fact => matchesPattern(finalContent, fact.pattern))
    const missingFacts = fixture.expectedFacts.filter(fact => !matchesPattern(finalContent, fact.pattern))
    for (const fact of missingFacts.filter(fact => fact.mustCapture)) {
      failures.push(`missing must-capture fact: ${fact.id}`)
    }

    const lateFacts = fixture.expectedFacts.filter(fact => fact.late)
    const matchedLateFacts = lateFacts.filter(fact => matchesPattern(finalContent, fact.pattern))
    const forbiddenMatches = [...(fixture.forbiddenPatterns ?? []), ...(fixture.forbiddenSecrets ?? [])]
      .filter(pattern => matchesPattern(finalContent, pattern))
    for (const pattern of forbiddenMatches) {
      failures.push(`forbidden generated content matched: ${pattern}`)
    }

    if (fixture.expectedClient) {
      const hasClientPath = [...finalSnapshot.keys()].some(path => path.toLowerCase().includes(`kunden/${fixture.expectedClient!.toLowerCase()}/`))
      if (!hasClientPath) failures.push(`expected client route not found: ${fixture.expectedClient}`)
    }
    for (const pathNeedle of fixture.expectedPathIncludes ?? []) {
      if (![...finalSnapshot.keys()].some(path => path.includes(pathNeedle))) failures.push(`expected path fragment not found: ${pathNeedle}`)
    }

    const beforeRepeat = markdownSnapshot(vaultPath)
    const repeat = runHarvester(vaultPath, stateDir, {
      session_id: fixture.sessionId,
      transcript_path: transcriptPath,
      cwd: fixture.cwd,
    })
    const afterRepeat = markdownSnapshot(vaultPath)
    const idempotencyViolations = repeat.status !== 0 || snapshotChanged(beforeRepeat, afterRepeat) ? 1 : 0
    if (idempotencyViolations > 0) failures.push('unchanged transcript changed generated Markdown on repeat run')

    const captureRecall = fixture.expectedFacts.length === 0 ? 1 : matchedFacts.length / fixture.expectedFacts.length
    const useful = matchedFacts.length
    const noisy = forbiddenMatches.length
    const capturePrecision = useful + noisy === 0 ? 1 : useful / (useful + noisy)
    const captureF2 = useful === 0 && fixture.expectedFacts.length > 0
      ? 0
      : (5 * capturePrecision * captureRecall) / ((4 * capturePrecision) + captureRecall)
    const temporalCompleteness = lateFacts.length === 0 ? 1 : matchedLateFacts.length / lateFacts.length
    const initiallyMissingLate = lateFacts.length === 0
      ? 1
      : lateFacts.filter(fact => !matchesPattern(initialContent, fact.pattern)).length / lateFacts.length
    const noiseRejection = forbiddenMatches.length === 0 ? 1 : 0

    metrics.push(metric('capture_recall', 'Capture Recall', clamp01(captureRecall), 0.85, `${matchedFacts.length}/${fixture.expectedFacts.length} expected facts captured`))
    metrics.push(metric('capture_precision', 'Capture Precision', clamp01(capturePrecision), 0.65, `${useful} useful facts, ${noisy} forbidden matches`))
    metrics.push(metric('capture_f2', 'Capture F2', clamp01(captureF2), 0.80, 'Recall-weighted capture score'))
    metrics.push(metric('temporal_completeness', 'Temporal Completeness', clamp01(temporalCompleteness), 1, `${matchedLateFacts.length}/${lateFacts.length} late facts captured`))
    metrics.push(metric('initially_missing_late', 'Initial Late-Fact Absence', clamp01(initiallyMissingLate), 1, `${lateFacts.length} late facts should not be present in the early run`))
    metrics.push(metric('idempotency_violations', 'Idempotency Violations', idempotencyViolations, 0, 'Repeated unchanged transcript must not rewrite Markdown', false))
    metrics.push(metric('noise_rejection', 'Noise/Secret Rejection', noiseRejection, 1, `${forbiddenMatches.length} forbidden generated matches`))
  } finally {
    if (!keepTemp) rmSync(tempPath, { recursive: true, force: true })
  }

  const failedMetrics = metrics.filter(item => item.status === 'fail')
  for (const item of failedMetrics) failures.push(`${item.label} below threshold: ${item.value}`)
  const score = average(metrics.map(item => item.status === 'pass' ? 100 : item.value * 100))
  return {
    id: fixture.id,
    type: fixture.type,
    status: statusFromFailures(failures),
    score,
    metrics,
    failures,
    tempPath: keepTemp ? tempPath : undefined,
  }
}

function writeFixtureNotes(vaultPath: string, notes: RetrievalNote[]): void {
  for (const note of notes) {
    writeText(join(vaultPath, note.path), note.content)
  }
}

function generatedKnowledgePaths(snapshot: Map<string, string>, sourcePath: string): string[] {
  return [...snapshot.keys()]
    .filter(path => path !== sourcePath)
    .filter(path => /^Knowledge\/(Claims|Insights|Answers|Runbooks)\//.test(path) || /^Kunden\/[^/]+\/Runbook /.test(path))
    .sort()
}

function promotionMatches(content: string, promotion: ExpectedPromotion): boolean {
  return promotion.requiredPatterns.every(pattern => matchesPattern(content, pattern))
}

function evaluatePromotionFixture(fixture: PromotionFixture, keepTemp: boolean): Promise<BrainQualityFixtureResult> {
  const tempPath = mkdirTemp(`brain-quality-${fixture.id}-`)
  const vaultPath = join(tempPath, 'vault')
  mkdirSync(vaultPath, { recursive: true })
  writeFixtureNotes(vaultPath, fixture.notes)

  const failures: string[] = []
  const metrics: BrainQualityMetric[] = []
  const vault = new Vault(vaultPath)

  return evaluateWithVault(vault, async () => {
    try {
      const source = vault.notes.get(fixture.sourcePath)
      if (!source) failures.push(`source note not found: ${fixture.sourcePath}`)
      vault.brainAutoBuild({
        sourcePath: fixture.sourcePath,
        client: fixture.client,
        dryRun: false,
        maxClaims: fixture.maxClaims,
      })

      const snapshot = markdownSnapshot(vaultPath)
      const candidates = generatedKnowledgePaths(snapshot, fixture.sourcePath)
      const candidateContent = new Map(candidates.map(path => [path, snapshot.get(path) ?? '']))
      const matchedPromotions = fixture.expectedPromotions.filter(expected =>
        candidates.some(path => matchesPattern(path, expected.pathPattern) && promotionMatches(candidateContent.get(path) ?? '', expected))
      )
      const missingMustPromotions = fixture.expectedPromotions.filter(expected =>
        expected.mustPromote !== false && !matchedPromotions.includes(expected)
      )
      for (const expected of missingMustPromotions) failures.push(`missing expected promotion: ${expected.id}`)

      const validCandidateCount = candidates.filter(path =>
        fixture.expectedPromotions.some(expected =>
          matchesPattern(path, expected.pathPattern) && promotionMatches(candidateContent.get(path) ?? '', expected)
        )
      ).length
      const promotionPrecision = candidates.length === 0
        ? fixture.expectedPromotions.length === 0 ? 1 : 0
        : validCandidateCount / candidates.length
      const promotionRecall = fixture.expectedPromotions.length === 0 ? 1 : matchedPromotions.length / fixture.expectedPromotions.length
      const promotionF0_5 = fBeta(promotionPrecision, promotionRecall, 0.5)
      const evidenceCoverage = candidates.length === 0
        ? fixture.expectedPromotions.length === 0 ? 1 : 0
        : candidates.filter(path => {
          const content = candidateContent.get(path) ?? ''
          return /(^|\n)quelle:|(^|\n)quellen:|## Quelle|## Quellen|\[\[/.test(content)
        }).length / candidates.length

      const sourceContent = source?.content ?? fixture.notes.find(note => note.path === fixture.sourcePath)?.content ?? ''
      const generatedRequiredPatterns = matchedPromotions.flatMap(expected => expected.requiredPatterns)
      const sourceSupported = generatedRequiredPatterns.filter(pattern => matchesPattern(sourceContent, pattern)).length
      const faithfulness = generatedRequiredPatterns.length === 0
        ? fixture.expectedPromotions.length === 0 ? 1 : 0
        : sourceSupported / generatedRequiredPatterns.length

      const forbiddenMatches = (fixture.forbiddenPatterns ?? []).filter(pattern =>
        [...candidateContent.values()].some(content => matchesPattern(content, pattern))
      )
      for (const pattern of forbiddenMatches) failures.push(`forbidden promoted content matched: ${pattern}`)

      metrics.push(metric('promotion_precision', 'Promotion Precision', clamp01(promotionPrecision), fixture.minPromotionPrecision ?? 0.90, `${validCandidateCount}/${candidates.length} generated knowledge items match expected promotions`))
      metrics.push(metric('promotion_recall', 'Promotion Recall', clamp01(promotionRecall), fixture.minPromotionRecall ?? 0.85, `${matchedPromotions.length}/${fixture.expectedPromotions.length} expected promotions found`))
      metrics.push(metric('promotion_f0_5', 'Promotion F0.5', clamp01(promotionF0_5), fixture.minPromotionF0_5 ?? 0.85, 'Precision-weighted promotion score'))
      metrics.push(metric('faithfulness', 'Faithfulness', clamp01(faithfulness), fixture.minFaithfulness ?? 0.90, `${sourceSupported}/${generatedRequiredPatterns.length} required promoted statements supported by source`))
      metrics.push(metric('evidence_coverage', 'Evidence Coverage', clamp01(evidenceCoverage), fixture.minEvidenceCoverage ?? 0.85, 'Generated knowledge items with source/provenance markers'))
      metrics.push(metric('forbidden_promotion_matches', 'Forbidden Promotion Matches', forbiddenMatches.length, 0, 'Promoted knowledge must not contain forbidden noise/secrets', false))
      for (const item of metrics.filter(item => item.status === 'fail')) failures.push(`${item.label} below threshold: ${item.value}`)
      return {
        id: fixture.id,
        type: fixture.type,
        status: statusFromFailures(failures),
        score: average(metrics.map(item => item.status === 'pass' ? 100 : item.value * 100)),
        metrics,
        failures,
        tempPath: keepTemp ? tempPath : undefined,
      }
    } finally {
      vault.shutdown()
      if (!keepTemp) rmSync(tempPath, { recursive: true, force: true })
    }
  })
}

function precisionAtK(results: string[], relevant: Set<string>, k: number): number {
  return results.slice(0, k).filter(path => relevant.has(path)).length / k
}

function recallAtK(results: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1
  return results.slice(0, k).filter(path => relevant.has(path)).length / relevant.size
}

function mrrAtK(results: string[], relevant: Set<string>, k: number): number {
  const index = results.slice(0, k).findIndex(path => relevant.has(path))
  return index < 0 ? 0 : 1 / (index + 1)
}

function ndcgAtK(results: string[], relevant: Set<string>, k: number): number {
  const dcg = results.slice(0, k).reduce((sum, path, index) => {
    const gain = relevant.has(path) ? 1 : 0
    return sum + gain / Math.log2(index + 2)
  }, 0)
  const idealCount = Math.min(relevant.size, k)
  let idcg = 0
  for (let index = 0; index < idealCount; index++) {
    idcg += 1 / Math.log2(index + 2)
  }
  return idcg === 0 ? 1 : dcg / idcg
}

async function evaluateRetrievalFixture(fixture: RetrievalFixture, keepTemp: boolean): Promise<BrainQualityFixtureResult> {
  const tempPath = mkdirTemp(`brain-quality-${fixture.id}-`)
  const vaultPath = join(tempPath, 'vault')
  mkdirSync(vaultPath, { recursive: true })
  writeFixtureNotes(vaultPath, fixture.notes)

  const failures: string[] = []
  const metrics: BrainQualityMetric[] = []
  const vault = new Vault(vaultPath)

  try {
    return await evaluateWithVault(vault, async () => {
      for (const query of fixture.queries) {
        const k = Math.max(1, Math.min(query.k ?? 5, 20))
        const relevant = new Set(query.relevantNotes)
        const resultPaths = vault.search({ query: query.query }).map(result => result.path)
        metrics.push(metric(`precision_at_${k}_${query.query}`, `Precision@${k}: ${query.query}`, precisionAtK(resultPaths, relevant, k), query.minPrecisionAtK ?? 0.60, resultPaths.slice(0, k).join(', ') || 'no results'))
        metrics.push(metric(`recall_at_${k}_${query.query}`, `Recall@${k}: ${query.query}`, recallAtK(resultPaths, relevant, k), query.minRecallAtK ?? 0.80, `${query.relevantNotes.length} relevant notes`))
        metrics.push(metric(`mrr_at_${k}_${query.query}`, `MRR@${k}: ${query.query}`, mrrAtK(resultPaths, relevant, k), query.minMrrAtK ?? 0.90, 'first relevant result rank quality'))
        metrics.push(metric(`ndcg_at_${k}_${query.query}`, `nDCG@${k}: ${query.query}`, ndcgAtK(resultPaths, relevant, k), query.minNdcgAtK ?? 0.85, 'ranked relevance quality'))
      }
      for (const item of metrics.filter(item => item.status === 'fail')) failures.push(`${item.label} below threshold: ${item.value}`)
      return {
        id: fixture.id,
        type: fixture.type,
        status: statusFromFailures(failures),
        score: average(metrics.map(item => item.value * 100)),
        metrics,
        failures,
        tempPath: keepTemp ? tempPath : undefined,
      }
    })
  } finally {
    vault.shutdown()
    if (!keepTemp) rmSync(tempPath, { recursive: true, force: true })
  }
}

async function evaluateSurfaceRedactionFixture(fixture: SurfaceRedactionFixture, keepTemp: boolean): Promise<BrainQualityFixtureResult> {
  const tempPath = mkdirTemp(`brain-quality-${fixture.id}-`)
  const vaultPath = join(tempPath, 'vault')
  mkdirSync(vaultPath, { recursive: true })
  writeFixtureNotes(vaultPath, fixture.notes)

  const failures: string[] = []
  const metrics: BrainQualityMetric[] = []
  const vault = new Vault(vaultPath)

  try {
    return await evaluateWithVault(vault, async () => {
      const hot = vault.updateHotCache({ query: fixture.query, dryRun: true, maxNotes: 8 })
      const snapshot = vault.buildCustomerSnapshot({ client: fixture.client, dryRun: true })
      const timeline = vault.buildMemoryTimeline({ client: fixture.client, dryRun: true })
      const dashboard = vault.buildCustomerDashboard(fixture.client, { dryRun: true })
      const content = `${hot.content}\n${snapshot.content}\n${timeline.content}\n${dashboard.content}`
      const leakedSecrets = fixture.forbiddenSecrets.filter(secret => content.includes(secret))
      for (const secret of leakedSecrets) failures.push(`generated surface leaked forbidden secret: ${secret}`)
      const forbiddenPatterns = (fixture.forbiddenPatterns ?? []).filter(pattern => matchesPattern(content, pattern))
      for (const pattern of forbiddenPatterns) failures.push(`generated surface matched forbidden pattern: ${pattern}`)
      const markerPresent = content.includes('[REDACTED_SENSITIVE_NOTE_SNIPPET')
      if (fixture.requireRedactionMarker && !markerPresent) failures.push('expected sensitive-note redaction marker not found')

      metrics.push(metric('secret_leak_count', 'Secret Leak Count', leakedSecrets.length, 0, 'Generated surfaces must not expose literal secrets', false))
      metrics.push(metric('forbidden_surface_pattern_count', 'Forbidden Surface Pattern Count', forbiddenPatterns.length, 0, 'Generated surfaces must not expose raw artifacts, verbose commands, or sensitive file probes', false))
      metrics.push(metric('redaction_marker_present', 'Redaction Marker Present', markerPresent ? 1 : 0, fixture.requireRedactionMarker ? 1 : undefined, 'Sensitive snippets should be hidden but linked'))
      for (const item of metrics.filter(item => item.status === 'fail')) failures.push(`${item.label} failed: ${item.value}`)
      return {
        id: fixture.id,
        type: fixture.type,
        status: statusFromFailures(failures),
        score: average(metrics.map(item => item.status === 'pass' ? 100 : item.value * 100)),
        metrics,
        failures,
        tempPath: keepTemp ? tempPath : undefined,
      }
    })
  } finally {
    vault.shutdown()
    if (!keepTemp) rmSync(tempPath, { recursive: true, force: true })
  }
}

function extractInboxItemIds(content: string): string[] {
  return [...content.matchAll(/`(inbox:[^`]+)`/g)].map(match => match[1]).sort()
}

async function evaluateReviewFixture(fixture: ReviewFixture, keepTemp: boolean): Promise<BrainQualityFixtureResult> {
  const tempPath = mkdirTemp(`brain-quality-${fixture.id}-`)
  const vaultPath = join(tempPath, 'vault')
  mkdirSync(vaultPath, { recursive: true })
  writeFixtureNotes(vaultPath, fixture.notes)

  const failures: string[] = []
  const metrics: BrainQualityMetric[] = []
  const vault = new Vault(vaultPath)

  try {
    return await evaluateWithVault(vault, async () => {
      const first = vault.buildKnowledgeInbox({ dryRun: true })
      const second = vault.buildKnowledgeInbox({ dryRun: true })
      const firstIds = extractInboxItemIds(first.content)
      const secondIds = extractInboxItemIds(second.content)
      const matchedExpected = fixture.expectedItems.filter(expected => firstIds.some(id => matchesPattern(id, expected.itemIdPattern)))
      const reviewCoverage = fixture.expectedItems.length === 0 ? 1 : matchedExpected.length / fixture.expectedItems.length
      const stableIds = firstIds.filter(id => secondIds.includes(id)).length
      const reviewItemStability = firstIds.length === 0 && secondIds.length === 0
        ? 1
        : stableIds / Math.max(firstIds.length, secondIds.length)

      let reappearanceCount = 0
      const resolvePattern = fixture.resolveItemPattern
      if (resolvePattern) {
        const itemId = firstIds.find(id => matchesPattern(id, resolvePattern))
        if (!itemId) {
          failures.push(`resolve item not found: ${fixture.resolveItemPattern}`)
          reappearanceCount = 1
        } else {
          vault.brainApplyInboxItem({ itemId, dryRun: false })
          const after = vault.buildKnowledgeInbox({ dryRun: true })
          reappearanceCount = after.content.includes(itemId) ? 1 : 0
        }
      }

      metrics.push(metric('review_coverage', 'Review Coverage', clamp01(reviewCoverage), fixture.minReviewCoverage ?? 0.90, `${matchedExpected.length}/${fixture.expectedItems.length} expected review items visible`))
      metrics.push(metric('review_item_stability', 'Review Item Stability', clamp01(reviewItemStability), 1, `${stableIds}/${Math.max(firstIds.length, secondIds.length)} item IDs stable across rebuilds`))
      metrics.push(metric('resolved_item_reappearance_count', 'Resolved Item Reappearance Count', reappearanceCount, 0, 'Resolved review items must not reappear without source changes', false))
      for (const expected of fixture.expectedItems.filter(expected => !matchedExpected.includes(expected))) failures.push(`missing expected review item: ${expected.id}`)
      for (const item of metrics.filter(item => item.status === 'fail')) failures.push(`${item.label} below threshold: ${item.value}`)
      return {
        id: fixture.id,
        type: fixture.type,
        status: statusFromFailures(failures),
        score: average(metrics.map(item => item.status === 'pass' ? 100 : item.value * 100)),
        metrics,
        failures,
        tempPath: keepTemp ? tempPath : undefined,
      }
    })
  } finally {
    vault.shutdown()
    if (!keepTemp) rmSync(tempPath, { recursive: true, force: true })
  }
}

async function evaluateBackgroundFixture(fixture: BackgroundFixture, keepTemp: boolean): Promise<BrainQualityFixtureResult> {
  const tempPath = mkdirTemp(`brain-quality-${fixture.id}-`)
  const vaultPath = join(tempPath, 'vault')
  mkdirSync(vaultPath, { recursive: true })
  writeFixtureNotes(vaultPath, fixture.notes)

  const failures: string[] = []
  const metrics: BrainQualityMetric[] = []
  const vault = new Vault(vaultPath)

  try {
    return await evaluateWithVault(vault, async () => {
      const lockPath = fixture.lockPath ?? '.brain-quality-background.lock'
      const result = vault.runBackgroundBrain({
        dryRun: false,
        jobs: fixture.jobs,
        maxRuntimeMs: fixture.maxRuntimeMs,
        lockPath,
      })
      const reportExists = existsSync(join(vaultPath, result.reportPath))
      const jsonExists = existsSync(join(vaultPath, result.jsonPath))
      const reportComplete = result.status !== 'fail'
        && reportExists
        && jsonExists
        && result.durationMs >= 0
        && result.jobs.length > 0
        && /## Jobs/.test(result.content)
        && /Status:/.test(result.content)
      const actionLogPath = join(vaultPath, '.action-log.jsonl')
      const actionLog = existsSync(actionLogPath) ? readFileSync(actionLogPath, 'utf-8') : ''
      const actionLogComplete = fixture.requireActionLog === false || actionLog.includes('brain_run_background')

      const lockFullPath = join(vaultPath, lockPath)
      writeText(lockFullPath, 'existing-lock\n')
      const locked = vault.runBackgroundBrain({ dryRun: true, jobs: fixture.jobs, lockPath })
      rmSync(lockFullPath, { force: true })
      const lockViolations = locked.status === 'fail' && locked.jobs.some(job => job.id === 'lock') ? 0 : 1

      metrics.push(metric('background_report_completeness', 'Background Report Completeness', reportComplete ? 1 : 0, 1, 'Run writes Markdown and JSON reports with status, duration, jobs, and summaries'))
      metrics.push(metric('action_log_completeness', 'Action Log Completeness', actionLogComplete ? 1 : 0, 0.98, 'Applied background run is represented in action log'))
      metrics.push(metric('concurrent_write_violations', 'Concurrent Write Violations', lockViolations, 0, 'Existing lock must prevent a second writer', false))
      metrics.push(metric('background_failed_jobs', 'Background Failed Jobs', result.jobs.filter(job => job.status === 'fail').length, 0, 'Quality fixture background jobs must not fail', false))
      for (const item of metrics.filter(item => item.status === 'fail')) failures.push(`${item.label} below threshold: ${item.value}`)
      return {
        id: fixture.id,
        type: fixture.type,
        status: statusFromFailures(failures),
        score: average(metrics.map(item => item.status === 'pass' ? 100 : item.value * 100)),
        metrics,
        failures,
        tempPath: keepTemp ? tempPath : undefined,
      }
    })
  } finally {
    vault.shutdown()
    if (!keepTemp) rmSync(tempPath, { recursive: true, force: true })
  }
}

async function evaluateClaimExtractionFixture(fixture: ClaimExtractionFixture, keepTemp: boolean): Promise<BrainQualityFixtureResult> {
  const tempPath = mkdirTemp(`brain-quality-${fixture.id}-`)
  const vaultPath = join(tempPath, 'vault')
  mkdirSync(vaultPath, { recursive: true })
  writeFixtureNotes(vaultPath, fixture.notes)

  const failures: string[] = []
  const metrics: BrainQualityMetric[] = []
  const vault = new Vault(vaultPath)

  try {
    return await evaluateWithVault(vault, async () => {
      const result = vault.extractClaims({
        path: fixture.sourcePath,
        maxClaims: fixture.maxClaims ?? 20,
        dryRun: true,
      })
      const claims = result.claims.map(claim => claim.claim)
      const matchedExpected = fixture.expectedClaimPatterns.filter(pattern => claims.some(claim => matchesPattern(claim, pattern)))
      const forbiddenMatches = fixture.forbiddenClaimPatterns.filter(pattern => claims.some(claim => matchesPattern(claim, pattern)))
      const validClaimCount = claims.filter(claim => fixture.expectedClaimPatterns.some(pattern => matchesPattern(claim, pattern))).length
      const claimPrecision = claims.length === 0 ? fixture.expectedClaimPatterns.length === 0 ? 1 : 0 : validClaimCount / claims.length
      const claimRecall = fixture.expectedClaimPatterns.length === 0 ? 1 : matchedExpected.length / fixture.expectedClaimPatterns.length
      const claimF0_5 = fBeta(claimPrecision, claimRecall, 0.5)
      const noiseRejection = forbiddenMatches.length === 0 ? 1 : 0

      for (const pattern of fixture.expectedClaimPatterns.filter(pattern => !matchedExpected.includes(pattern))) failures.push(`missing expected claim pattern: ${pattern}`)
      for (const pattern of forbiddenMatches) failures.push(`forbidden claim pattern matched: ${pattern}`)
      metrics.push(metric('claim_precision', 'Claim Precision', clamp01(claimPrecision), fixture.minClaimPrecision ?? 0.90, `${validClaimCount}/${claims.length} extracted claims match expected durable facts`))
      metrics.push(metric('claim_recall', 'Claim Recall', clamp01(claimRecall), fixture.minClaimRecall ?? 0.85, `${matchedExpected.length}/${fixture.expectedClaimPatterns.length} expected durable facts extracted`))
      metrics.push(metric('claim_f0_5', 'Claim F0.5', clamp01(claimF0_5), fixture.minClaimF0_5 ?? 0.85, 'Precision-weighted claim extraction score'))
      metrics.push(metric('claim_noise_rejection', 'Claim Noise Rejection', noiseRejection, 1, `${forbiddenMatches.length} forbidden/noisy claim matches`))
      for (const item of metrics.filter(item => item.status === 'fail')) failures.push(`${item.label} below threshold: ${item.value}`)
      return {
        id: fixture.id,
        type: fixture.type,
        status: statusFromFailures(failures),
        score: average(metrics.map(item => item.status === 'pass' ? 100 : item.value * 100)),
        metrics,
        failures,
        tempPath: keepTemp ? tempPath : undefined,
      }
    })
  } finally {
    vault.shutdown()
    if (!keepTemp) rmSync(tempPath, { recursive: true, force: true })
  }
}

function evaluatePolicySafety(): BrainQualityFixtureResult {
  const policy = loadBrainPolicy()
  const requiredNeverAutoApply = [
    'merge_duplicates',
    'rename_note',
    'organize_referenz',
    'fix_broken_links',
    'apply_link_suggestions',
    'resolve_gap',
  ]
  const failures: string[] = []
  for (const action of requiredNeverAutoApply) {
    if (!policy.automation.neverAutoApply.includes(action)) failures.push(`missing neverAutoApply action: ${action}`)
  }
  if (policy.workingMemory.allowAutomaticRecall) failures.push('working memory automatic recall is enabled')
  const riskyTools = ['rename_note', 'merge_duplicates', 'fix_broken_links', 'apply_link_suggestions', 'resolve_gap']
  for (const tool of riskyTools) {
    const config = policy.tools[tool]
    if (!config?.requiresDryRunDefault) failures.push(`${tool} is not dry-run-first`)
  }
  const metrics = [
    metric('risky_auto_apply_violations', 'Risky Auto-Apply Violations', failures.length, 0, 'Risky operations must be blocked or dry-run-first', false),
  ]
  return {
    id: 'policy-safety',
    type: 'policy',
    status: statusFromFailures(failures),
    score: failures.length === 0 ? 100 : 0,
    metrics,
    failures,
  }
}

function average(values: number[]): number {
  if (values.length === 0) return 100
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function mkdirTemp(prefix: string): string {
  const path = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(path, { recursive: true })
  return path
}

async function evaluateWithVault<T>(vault: Vault, fn: () => Promise<T>): Promise<T> {
  await vault.init()
  return fn()
}

function summarize(fixtures: BrainQualityFixtureResult[]): BrainQualityResult['summary'] {
  return {
    pass: fixtures.filter(fixture => fixture.status === 'pass').length,
    warn: fixtures.filter(fixture => fixture.status === 'warn').length,
    fail: fixtures.filter(fixture => fixture.status === 'fail').length,
  }
}

export async function runBrainQualityHarness(options: BrainQualityOptions = {}): Promise<BrainQualityResult> {
  const fixturesDir = resolve(options.fixturesDir ?? DEFAULT_FIXTURES_DIR)
  const keepTemp = options.keepTemp === true
  const results: BrainQualityFixtureResult[] = [evaluatePolicySafety()]

  for (const fixtureFile of listFixtureFiles(fixturesDir)) {
    const fixture = readFixture(fixtureFile)
    if (fixture.type === 'harvester_update') results.push(evaluateHarvesterFixture(fixture, keepTemp))
    else if (fixture.type === 'retrieval') results.push(await evaluateRetrievalFixture(fixture, keepTemp))
    else if (fixture.type === 'surface_redaction') results.push(await evaluateSurfaceRedactionFixture(fixture, keepTemp))
    else if (fixture.type === 'promotion') results.push(await evaluatePromotionFixture(fixture, keepTemp))
    else if (fixture.type === 'review') results.push(await evaluateReviewFixture(fixture, keepTemp))
    else if (fixture.type === 'background') results.push(await evaluateBackgroundFixture(fixture, keepTemp))
    else if (fixture.type === 'claim_extraction') results.push(await evaluateClaimExtractionFixture(fixture, keepTemp))
  }

  const hardGateFailures = results.flatMap(result =>
    result.failures
      .filter(failure => /secret|risky|protected|auto-apply|idempotency|forbidden/i.test(failure))
      .map(failure => `${result.id}: ${failure}`),
  )
  const summary = summarize(results)
  const score = hardGateFailures.length > 0 ? 0 : average(results.map(result => result.score))
  const status: BrainQualityStatus = hardGateFailures.length > 0 || summary.fail > 0
    ? 'fail'
    : score >= 90
      ? 'pass'
      : score >= 80
        ? 'warn'
        : 'fail'

  return {
    status,
    score,
    generatedAt: new Date().toISOString(),
    fixturesDir,
    summary,
    hardGateFailures,
    fixtures: results,
  }
}

export function formatBrainQualityResult(result: BrainQualityResult): string {
  const fixtureLines = result.fixtures.map(fixture => {
    const metricLines = fixture.metrics.map(item => {
      const threshold = item.threshold === undefined ? '' : ` (threshold ${item.threshold})`
      return `  - ${item.status.padEnd(4)} ${item.label}: ${Number(item.value.toFixed(3))}${threshold} - ${item.detail}`
    }).join('\n')
    const failures = fixture.failures.length > 0
      ? `\n  Failures:\n${fixture.failures.map(failure => `  - ${failure}`).join('\n')}`
      : ''
    return `- ${fixture.status.padEnd(4)} ${fixture.id} [${fixture.type}] score=${Number(fixture.score.toFixed(1))}\n${metricLines}${failures}`
  }).join('\n')

  const hardGates = result.hardGateFailures.length > 0
    ? result.hardGateFailures.map(failure => `- ${failure}`).join('\n')
    : '- Keine Hard-Gate-Fehler'

  return [
    '# Brain Quality Harness',
    '',
    `Status: ${result.status}`,
    `Score: ${Number(result.score.toFixed(1))}`,
    `Fixtures: pass ${result.summary.pass}, warn ${result.summary.warn}, fail ${result.summary.fail}`,
    `Fixtures Dir: ${result.fixturesDir}`,
    '',
    '## Hard Gates',
    hardGates,
    '',
    '## Fixtures',
    fixtureLines || '- Keine Fixtures gefunden',
  ].join('\n')
}
