import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import type { Vault } from '../vault.ts'
import {
  KNOWLEDGE_SALIENCE_MODEL,
  scoreKnowledgeSalienceFactors,
  type KnowledgeFactFactors,
  type KnowledgeFactKind,
  type KnowledgeSalienceFact,
  type KnowledgeProvenanceSource,
} from './knowledge-salience.ts'
import {
  applyEvidenceConflictCeiling,
  EVIDENCE_SCORING_MODEL,
  scoreEvidenceSummary,
  summarizeEvidence,
} from './evidence-scoring.ts'
import {
  calibrationObservationId,
  calibrationProjectGroupId,
  calibrationReviewToken,
  parseCalibrationCaptureBundle,
} from './calibration-capture.ts'
import { appendActionLog } from './action-log.ts'
import { atomicWriteJsonSync } from './atomic-file.ts'
import { parseFrontmatter } from './note-parser.ts'
import { isActivePath } from './note-scope.ts'
import { assertCanWriteTool } from './policy.ts'
import { redactSecrets } from './secret-redaction.ts'
import { assertSafeRelativePath, vaultJoin } from './vault-paths.ts'

export const BRAIN_CALIBRATION_PATH = '.brain-calibration.json'
export const BRAIN_CALIBRATION_LOCK_PATH = '.brain-calibration.lock'
export const BRAIN_CALIBRATION_SCHEMA_VERSION = 2 as const

export type BrainCalibrationLabel = 'useful' | 'supported' | 'still_valid'
export type BrainCalibrationSelectionStatus = 'selected' | 'sampled_unselected'
export type BrainCalibrationValidityClass =
  | 'historical_event'
  | 'durable_state'
  | 'operational_state'
  | 'ephemeral_state'

interface CalibrationSalienceModel {
  evidenceModelVersion: string
  score: (factors: KnowledgeFactFactors) => number
}

interface CalibrationEvidenceModel {
  score: (
    sourceTypes: readonly KnowledgeProvenanceSource[],
    independentUnitCount: number,
    conflict: boolean,
  ) => number
}

/**
 * Historical formulas must remain registered when a new current model is
 * added. Calibration reads fail closed only for versions absent from here.
 */
export const BRAIN_CALIBRATION_MODEL_REGISTRY: {
  salience: Readonly<Record<string, CalibrationSalienceModel>>
  evidence: Readonly<Record<string, CalibrationEvidenceModel>>
} = {
  salience: {
    [KNOWLEDGE_SALIENCE_MODEL.version]: {
      evidenceModelVersion: KNOWLEDGE_SALIENCE_MODEL.evidenceModelVersion,
      score: scoreKnowledgeSalienceFactors,
    },
  },
  evidence: {
    [EVIDENCE_SCORING_MODEL.version]: {
      score: (sourceTypes, independentUnitCount, conflict) => {
        const rawScore = scoreEvidenceSummary({ sourceTypes, independentUnitCount }) ?? 0
        return applyEvidenceConflictCeiling(rawScore, conflict)
      },
    },
  },
}

/**
 * Immutable model inputs captured at review time. Statements and evidence
 * excerpts are intentionally excluded: the calibration file only needs
 * numeric features, provenance classes, and bounded routing metadata.
 */
export interface BrainCalibrationTargetSnapshot {
  /** Salience/ranking model that produced salienceScore and factors. */
  modelVersion: string
  /** Independently versioned evidence model that produced evidenceScore. */
  evidenceModelVersion: string
  factId: string
  kind: KnowledgeFactKind
  salienceScore: number
  evidenceScore: number
  factors: KnowledgeFactFactors
  sourceTypes: KnowledgeProvenanceSource[]
  /** Canonical evidence-component count after hash/origin deduplication. */
  independentUnitCount: number
  evidenceConflict: boolean
  /** Exact harvester time used for chronological, leakage-safe splits. */
  generatedAt: string
  /** Whether the production selector retained this fact. */
  selectionStatus: BrainCalibrationSelectionStatus
  /** One-based production rank for selected facts; null for sampled rejects. */
  productionRank: number | null
  /** True only for the seeded uniform sample from the safe candidate universe. */
  evaluationSample: boolean
  /** Size of that session's safe, deduplicated candidate universe. */
  candidatePopulationCount: number
  /** Inclusion probability in the evaluation sample; zero outside it. */
  samplingProbability: number
  /** When the underlying state was observed; required for still_valid labels. */
  observedAt?: string
  /** Expected change regime; required for still_valid labels. */
  validityClass?: BrainCalibrationValidityClass
  sourcePath?: string
  sessionId?: string
  clientId?: string
  /** Pseudonymous, server-derived project/customer grouping key. */
  projectGroupId?: string
}

export interface BrainCalibrationEntry {
  /**
   * One reviewable observation. For useful/supported this is the stable scored
   * target; still_valid derives a temporal observation from that target.
   */
  observationId: string
  /** Stable scored target shared by all temporal rechecks of this occurrence. */
  baseObservationId?: string
  label: BrainCalibrationLabel
  value: boolean
  snapshot: BrainCalibrationTargetSnapshot
  recordedAt: string
  reviewer: string
}

export interface BrainCalibrationDataset {
  schemaVersion: typeof BRAIN_CALIBRATION_SCHEMA_VERSION
  entries: BrainCalibrationEntry[]
}

export interface RecordCalibrationLabelOptions {
  /** Preferred selector for blind review; never reveals the production path or fact id. */
  reviewToken?: string
  /** Internal/backward-compatible selector. Not exposed by the MCP review workflow. */
  sourcePath?: string
  /** Internal/backward-compatible selector. Not exposed by the MCP review workflow. */
  factId?: string
  label: BrainCalibrationLabel
  value: boolean
  reviewer: string
  recordedAt: string
  observedAt?: string
  validityClass?: BrainCalibrationValidityClass
  clientId?: string
  dryRun?: boolean
}

export interface BrainCalibrationLabelSummary {
  true: number
  false: number
  labeled: number
  /** Mean of Beta(true + 0.5, false + 0.5); descriptive, not a policy threshold. */
  jeffreysPosteriorMean: number
}

export interface BrainCalibrationSummary {
  totalEntries: number
  /** Stable scored targets, before temporal validity rechecks are expanded. */
  uniqueTargets: number
  /** Review observations, including distinct temporal validity rechecks. */
  uniqueObservations: number
  uniqueFacts: number
  byLabel: Record<BrainCalibrationLabel, BrainCalibrationLabelSummary>
}

export interface RecordCalibrationLabelResult {
  dryRun: boolean
  path: string
  operation: 'created' | 'updated'
  entry: BrainCalibrationEntry
  summary: BrainCalibrationSummary
}

export interface RecordCalibrationJudgementOptions {
  reviewToken: string
  useful: boolean
  supported: boolean
  reviewer: string
  recordedAt: string
  dryRun?: boolean
}

export interface RecordCalibrationJudgementResult {
  dryRun: boolean
  path: string
  operation: 'created' | 'completed' | 'unchanged'
  labels: {
    useful: boolean
    supported: boolean
  }
  reviewer: string
  summary: BrainCalibrationSummary
}

const LABELS = ['useful', 'supported', 'still_valid'] as const satisfies readonly BrainCalibrationLabel[]
const FACT_KINDS = new Set<KnowledgeFactKind>([
  'cause',
  'decision',
  'change',
  'verification',
  'result',
  'problem',
  'open_question',
  'constraint',
])
const SOURCE_TYPES = new Set<KnowledgeProvenanceSource>([
  'phase',
  'assistant_summary',
  'error_fix',
  'bash_pair',
])
const VALIDITY_CLASSES = new Set<BrainCalibrationValidityClass>([
  'historical_event',
  'durable_state',
  'operational_state',
  'ephemeral_state',
])
const SELECTION_STATUSES = new Set<BrainCalibrationSelectionStatus>([
  'selected',
  'sampled_unselected',
])
const FACTOR_KEYS = [
  'taskRelevance',
  'decisionOutcomeUtility',
  'noveltyInformativeness',
  'reusability',
  'specificity',
] as const satisfies readonly (keyof KnowledgeFactFactors)[]

const DATASET_KEYS = new Set(['schemaVersion', 'entries'])
const ENTRY_KEYS = new Set([
  'observationId',
  'baseObservationId',
  'label',
  'value',
  'snapshot',
  'recordedAt',
  'reviewer',
])
const SNAPSHOT_KEYS = new Set([
  'modelVersion',
  'evidenceModelVersion',
  'factId',
  'kind',
  'salienceScore',
  'evidenceScore',
  'factors',
  'sourceTypes',
  'independentUnitCount',
  'evidenceConflict',
  'generatedAt',
  'selectionStatus',
  'productionRank',
  'evaluationSample',
  'candidatePopulationCount',
  'samplingProbability',
  'observedAt',
  'validityClass',
  'sourcePath',
  'sessionId',
  'clientId',
  'projectGroupId',
])
const FACTORS_KEYS = new Set<string>(FACTOR_KEYS)
const MAX_ENTRIES = 100_000

interface CalibrationLock {
  descriptor: number
  path: string
}

function acquireCalibrationLock(vault: Vault): CalibrationLock {
  const path = vaultJoin(vault.vaultPath, BRAIN_CALIBRATION_LOCK_PATH)
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })}\n`, 'utf-8')
    return { descriptor, path }
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Preserve the acquisition error.
      }
      try {
        unlinkSync(path)
      } catch {
        // The incomplete lock may already be gone.
      }
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Kalibrierungsdataset ist gesperrt (${BRAIN_CALIBRATION_LOCK_PATH}); `
        + 'laufenden Writer oder stale Lock prüfen',
      )
    }
    throw error
  }
}

function releaseCalibrationLock(lock: CalibrationLock): void {
  try {
    closeSync(lock.descriptor)
  } finally {
    try {
      unlinkSync(lock.path)
    } catch {
      // Preserve a successful data write even if external cleanup removed the lock.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} muss ein Objekt sein`)
  return value
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} ist im Schema nicht erlaubt`)
  }
}

function boundedSingleLine(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${field} muss ein String sein`)
  const normalized = value.normalize('NFC')
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} darf keine Steuerzeichen oder Zeilenumbrüche enthalten`)
  }
  const trimmed = normalized.trim()
  if (!trimmed) throw new Error(`${field} darf nicht leer sein`)
  if (trimmed.length > maxLength) throw new Error(`${field} darf höchstens ${maxLength} Zeichen enthalten`)
  return trimmed
}

function opaqueIdentifier(value: unknown, field: string, maxLength: number): string {
  const text = boundedSingleLine(value, field, maxLength)
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:@-]*$/u.test(text)) {
    throw new Error(`${field} muss eine opake ID ohne Leer- oder Sonderzeichen sein`)
  }
  if (redactSecrets(text).count > 0) {
    throw new Error(`${field} darf kein Secret enthalten`)
  }
  return text
}

function boundedNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} muss eine endliche Zahl zwischen ${min} und ${max} sein`)
  }
  return value
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  const number = boundedNumber(value, field, min, max)
  if (!Number.isInteger(number)) throw new Error(`${field} muss eine Ganzzahl sein`)
  return number
}

function isoTimestamp(value: unknown, field: string): string {
  const text = boundedSingleLine(value, field, 64)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text)) {
    throw new Error(`${field} muss ein kanonischer UTC-Zeitstempel mit Millisekunden sein`)
  }
  const milliseconds = Date.parse(text)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    throw new Error(`${field} muss ein gültiger kanonischer UTC-Zeitstempel sein`)
  }
  return text
}

function sourcePath(value: unknown): string {
  const text = boundedSingleLine(value, 'snapshot.sourcePath', 512)
  if (text.includes('\\') || text.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error(`Unsicherer Vault-Pfad: ${text}`)
  }
  const safe = assertSafeRelativePath(text)
  if (safe !== text) throw new Error(`Unsicherer Vault-Pfad: ${text}`)
  if (!safe.endsWith('.md')) throw new Error('snapshot.sourcePath muss auf eine Markdown-Datei zeigen')
  if (redactSecrets(safe).count > 0) throw new Error('snapshot.sourcePath darf kein Secret enthalten')
  return safe
}

function parseFactors(value: unknown): KnowledgeFactFactors {
  const record = requireRecord(value, 'snapshot.factors')
  rejectUnknownKeys(record, FACTORS_KEYS, 'snapshot.factors')
  for (const key of FACTOR_KEYS) {
    if (!Object.hasOwn(record, key)) throw new Error(`snapshot.factors.${key} fehlt`)
  }
  return {
    taskRelevance: boundedNumber(record.taskRelevance, 'snapshot.factors.taskRelevance', 0, 1),
    decisionOutcomeUtility: boundedNumber(
      record.decisionOutcomeUtility,
      'snapshot.factors.decisionOutcomeUtility',
      0,
      1,
    ),
    noveltyInformativeness: boundedNumber(
      record.noveltyInformativeness,
      'snapshot.factors.noveltyInformativeness',
      0,
      1,
    ),
    reusability: boundedNumber(record.reusability, 'snapshot.factors.reusability', 0, 1),
    specificity: boundedNumber(record.specificity, 'snapshot.factors.specificity', 0, 1),
  }
}

function parseSourceTypes(value: unknown): KnowledgeProvenanceSource[] {
  if (!Array.isArray(value)) throw new Error('snapshot.sourceTypes muss ein Array sein')
  const parsed = value.map((source, index) => {
    if (typeof source !== 'string' || !SOURCE_TYPES.has(source as KnowledgeProvenanceSource)) {
      throw new Error(`snapshot.sourceTypes[${index}] ist ungültig`)
    }
    return source as KnowledgeProvenanceSource
  })
  if (new Set(parsed).size !== parsed.length) throw new Error('snapshot.sourceTypes darf keine Duplikate enthalten')
  return [...parsed].sort()
}

function parseSnapshot(value: unknown): BrainCalibrationTargetSnapshot {
  const record = requireRecord(value, 'snapshot')
  rejectUnknownKeys(record, SNAPSHOT_KEYS, 'snapshot')

  const kind = record.kind
  if (typeof kind !== 'string' || !FACT_KINDS.has(kind as KnowledgeFactKind)) {
    throw new Error('snapshot.kind ist ungültig')
  }
  if (typeof record.evidenceConflict !== 'boolean') {
    throw new Error('snapshot.evidenceConflict muss boolean sein')
  }
  if (
    typeof record.selectionStatus !== 'string'
    || !SELECTION_STATUSES.has(record.selectionStatus as BrainCalibrationSelectionStatus)
  ) {
    throw new Error('snapshot.selectionStatus ist ungültig')
  }
  if (typeof record.evaluationSample !== 'boolean') {
    throw new Error('snapshot.evaluationSample muss boolean sein')
  }

  const parsedSourceTypes = parseSourceTypes(record.sourceTypes)
  const independentUnitCount = boundedInteger(
    record.independentUnitCount,
    'snapshot.independentUnitCount',
    0,
    10_000,
  )
  if (parsedSourceTypes.length === 0 && independentUnitCount !== 0) {
    throw new Error('snapshot.independentUnitCount muss bei leeren sourceTypes 0 sein')
  }
  if (parsedSourceTypes.length > 0 && independentUnitCount < 1) {
    throw new Error('snapshot.independentUnitCount muss bei vorhandenen sourceTypes mindestens 1 sein')
  }
  if (independentUnitCount < parsedSourceTypes.length) {
    throw new Error(
      'snapshot.independentUnitCount darf nicht kleiner als die Zahl der sourceTypes sein',
    )
  }

  const parsed: BrainCalibrationTargetSnapshot = {
    modelVersion: boundedSingleLine(record.modelVersion, 'snapshot.modelVersion', 120),
    evidenceModelVersion: boundedSingleLine(
      record.evidenceModelVersion,
      'snapshot.evidenceModelVersion',
      120,
    ),
    factId: boundedSingleLine(record.factId, 'snapshot.factId', 180),
    kind: kind as KnowledgeFactKind,
    salienceScore: boundedInteger(record.salienceScore, 'snapshot.salienceScore', 0, 100),
    evidenceScore: boundedInteger(record.evidenceScore, 'snapshot.evidenceScore', 0, 100),
    factors: parseFactors(record.factors),
    sourceTypes: parsedSourceTypes,
    independentUnitCount,
    evidenceConflict: record.evidenceConflict,
    generatedAt: isoTimestamp(record.generatedAt, 'snapshot.generatedAt'),
    selectionStatus: record.selectionStatus as BrainCalibrationSelectionStatus,
    productionRank: record.productionRank === null
      ? null
      : boundedInteger(record.productionRank, 'snapshot.productionRank', 1, 10_000),
    evaluationSample: record.evaluationSample,
    candidatePopulationCount: boundedInteger(
      record.candidatePopulationCount,
      'snapshot.candidatePopulationCount',
      1,
      10_000,
    ),
    samplingProbability: boundedNumber(
      record.samplingProbability,
      'snapshot.samplingProbability',
      0,
      1,
    ),
  }
  if (!/^ks-[a-f0-9]{20}$/.test(parsed.factId)) {
    throw new Error('snapshot.factId muss eine kanonische ks-Fakt-ID sein')
  }
  if (parsed.selectionStatus === 'selected') {
    if (
      parsed.productionRank === null
      || parsed.productionRank > parsed.candidatePopulationCount
    ) {
      throw new Error('Ausgewählte Snapshots brauchen einen gültigen productionRank')
    }
  } else if (parsed.productionRank !== null) {
    throw new Error('Nicht ausgewählte Snapshots dürfen keinen productionRank tragen')
  }
  if (parsed.evaluationSample !== (parsed.samplingProbability > 0)) {
    throw new Error(
      'snapshot.samplingProbability muss genau für evaluationSample größer als null sein',
    )
  }

  if (record.observedAt !== undefined) {
    parsed.observedAt = isoTimestamp(record.observedAt, 'snapshot.observedAt')
  }
  if (record.validityClass !== undefined) {
    if (
      typeof record.validityClass !== 'string'
      || !VALIDITY_CLASSES.has(record.validityClass as BrainCalibrationValidityClass)
    ) {
      throw new Error('snapshot.validityClass ist ungültig')
    }
    parsed.validityClass = record.validityClass as BrainCalibrationValidityClass
  }
  if (record.sourcePath !== undefined) parsed.sourcePath = sourcePath(record.sourcePath)
  if (record.sessionId !== undefined) {
    parsed.sessionId = opaqueIdentifier(record.sessionId, 'snapshot.sessionId', 180)
  }
  if (record.clientId !== undefined) {
    parsed.clientId = opaqueIdentifier(record.clientId, 'snapshot.clientId', 120)
  }
  if (record.projectGroupId !== undefined) {
    const projectGroupId = boundedSingleLine(
      record.projectGroupId,
      'snapshot.projectGroupId',
      32,
    )
    if (!/^pg-[a-f0-9]{20}$/.test(projectGroupId)) {
      throw new Error('snapshot.projectGroupId muss eine pseudonyme pg-ID sein')
    }
    parsed.projectGroupId = projectGroupId
  }

  const salienceModel = BRAIN_CALIBRATION_MODEL_REGISTRY.salience[parsed.modelVersion]
  if (!salienceModel) {
    throw new Error(`snapshot.modelVersion wird nicht unterstützt: ${parsed.modelVersion}`)
  }
  const evidenceModel = BRAIN_CALIBRATION_MODEL_REGISTRY.evidence[parsed.evidenceModelVersion]
  if (!evidenceModel) {
    throw new Error(
      `snapshot.evidenceModelVersion wird nicht unterstützt: ${parsed.evidenceModelVersion}`,
    )
  }
  if (parsed.evidenceModelVersion !== salienceModel.evidenceModelVersion) {
    throw new Error(
      `snapshot.evidenceModelVersion muss für ${parsed.modelVersion} `
      + `${salienceModel.evidenceModelVersion} sein`,
    )
  }
  const expectedSalience = salienceModel.score(parsed.factors)
  if (parsed.salienceScore !== expectedSalience) {
    throw new Error(
      `snapshot.salienceScore ist für ${parsed.modelVersion} nicht reproduzierbar `
      + `(erwartet: ${expectedSalience})`,
    )
  }
  const expectedEvidence = evidenceModel.score(
    parsed.sourceTypes,
    parsed.independentUnitCount,
    parsed.evidenceConflict,
  )
  if (parsed.evidenceScore !== expectedEvidence) {
    throw new Error(
      `snapshot.evidenceScore ist für ${parsed.evidenceModelVersion} nicht reproduzierbar `
      + `(erwartet: ${expectedEvidence})`,
    )
  }
  return parsed
}

export interface BrainCalibrationSnapshotContext {
  generatedAt: string
  selectionStatus: BrainCalibrationSelectionStatus
  productionRank: number | null
  evaluationSample: boolean
  candidatePopulationCount: number
  samplingProbability: number
  sourcePath?: string
  sessionId?: string
  clientId?: string
  projectGroupId?: string
  observedAt?: string
  validityClass?: BrainCalibrationValidityClass
}

function modelSnapshotPayload(snapshot: BrainCalibrationTargetSnapshot): object {
  return {
    modelVersion: snapshot.modelVersion,
    evidenceModelVersion: snapshot.evidenceModelVersion,
    factId: snapshot.factId,
    kind: snapshot.kind,
    salienceScore: snapshot.salienceScore,
    evidenceScore: snapshot.evidenceScore,
    factors: snapshot.factors,
    sourceTypes: snapshot.sourceTypes,
    independentUnitCount: snapshot.independentUnitCount,
    evidenceConflict: snapshot.evidenceConflict,
    generatedAt: snapshot.generatedAt,
    selectionStatus: snapshot.selectionStatus,
    productionRank: snapshot.productionRank,
    evaluationSample: snapshot.evaluationSample,
    candidatePopulationCount: snapshot.candidatePopulationCount,
    samplingProbability: snapshot.samplingProbability,
  }
}

/** SHA-256 of the numeric/model snapshot only; no fact prose is included. */
export function calibrationSnapshotFingerprint(
  snapshot: BrainCalibrationTargetSnapshot,
): string {
  return createHash('sha256').update(serializeCalibrationSnapshotCore(snapshot)).digest('hex')
}

export function serializeCalibrationSnapshotCore(
  snapshot: BrainCalibrationTargetSnapshot,
): string {
  const parsed = parseSnapshot(snapshot)
  return JSON.stringify(modelSnapshotPayload(parsed))
}

/**
 * Builds a calibration snapshot from a real selected fact so callers never
 * derive post-dedup evidence statistics from raw provenance by hand.
 */
export function calibrationSnapshotFromFact(
  fact: Omit<KnowledgeSalienceFact, 'selectionScore'>,
  context: BrainCalibrationSnapshotContext,
): BrainCalibrationTargetSnapshot {
  const summary = summarizeEvidence(fact.provenance)
  return parseSnapshot({
    modelVersion: fact.modelVersion,
    evidenceModelVersion: KNOWLEDGE_SALIENCE_MODEL.evidenceModelVersion,
    factId: fact.id,
    kind: fact.kind,
    salienceScore: fact.salienceScore,
    evidenceScore: fact.evidenceScore,
    factors: fact.factors,
    sourceTypes: summary?.sourceTypes ?? [],
    independentUnitCount: summary?.independentUnitCount ?? 0,
    evidenceConflict: fact.evidenceConflict === true,
    ...context,
  })
}

function snapshotFromCapture(
  vault: Vault,
  options: RecordCalibrationLabelOptions,
): { snapshot: BrainCalibrationTargetSnapshot; observationId: string } {
  const selector = resolveCalibrationTarget(vault, options)
  const safeSourcePath = sourcePath(selector.sourcePath)
  if (!/^ks-[a-f0-9]{20}$/.test(selector.factId)) {
    throw new Error('factId muss eine kanonische ks-Fakt-ID sein')
  }
  const fullPath = vaultJoin(vault.vaultPath, safeSourcePath)
  if (!existsSync(fullPath)) {
    throw new Error(`sourcePath existiert nicht: ${safeSourcePath}`)
  }
  const frontmatter = parseFrontmatter(readFileSync(fullPath, 'utf-8'))
  const bundle = parseCalibrationCaptureBundle(frontmatter)
  const capturedFact = bundle.facts.find(item => item.factId === selector.factId)
  if (!capturedFact) {
    throw new Error(`Capture enthält keinen attestierten Snapshot für factId ${selector.factId}`)
  }
  const snapshot = parseSnapshot({
    ...capturedFact.payload,
    sourcePath: safeSourcePath,
    sessionId: bundle.sessionId,
    observedAt: options.observedAt,
    validityClass: options.validityClass,
    clientId: options.clientId,
    projectGroupId: calibrationProjectGroupId(safeSourcePath),
  })
  if (bundle.modelVersion !== snapshot.modelVersion) {
    throw new Error('Snapshot-Modell stimmt nicht mit dem Capture überein')
  }
  if (calibrationSnapshotFingerprint(snapshot) !== capturedFact.fingerprint) {
    throw new Error('Kalibrierungs-Snapshot stimmt nicht mit dem Capture-Fingerprint überein')
  }
  return {
    snapshot,
    observationId: calibrationObservationId(
      bundle.sessionId,
      snapshot.factId,
      capturedFact.fingerprint,
    ),
  }
}

function resolveCalibrationTarget(
  vault: Vault,
  options: RecordCalibrationLabelOptions,
): { sourcePath: string; factId: string } {
  const hasToken = options.reviewToken !== undefined
  const hasDirectSelector = options.sourcePath !== undefined || options.factId !== undefined
  if (hasToken && hasDirectSelector) {
    throw new Error('reviewToken darf nicht mit sourcePath oder factId kombiniert werden')
  }
  if (!hasToken) {
    if (options.sourcePath === undefined || options.factId === undefined) {
      throw new Error('reviewToken oder sourcePath und factId sind erforderlich')
    }
    return {
      sourcePath: options.sourcePath,
      factId: options.factId,
    }
  }

  const token = boundedSingleLine(options.reviewToken, 'reviewToken', 36)
  if (!/^brt-[a-f0-9]{32}$/.test(token)) {
    throw new Error('reviewToken muss ein kanonischer opaker brt-Token sein')
  }
  let match: { sourcePath: string; factId: string } | null = null
  for (const note of vault.notes.values()) {
    if (!isActivePath(note.relativePath) || note.frontmatter.quelle !== 'knowledge-harvester') {
      continue
    }
    if (note.frontmatter.calibration_capture_schema === undefined) continue
    let bundle
    try {
      bundle = parseCalibrationCaptureBundle(note.frontmatter)
    } catch {
      continue
    }
    for (const fact of bundle.facts) {
      if (fact.payload.evaluationSample !== true) continue
      const candidate = calibrationReviewToken(
        bundle.integrity,
        fact.reviewReference,
        fact.fingerprint,
      )
      if (candidate !== token) continue
      if (match !== null) {
        throw new Error('reviewToken ist nicht eindeutig einem Capture zugeordnet')
      }
      match = { sourcePath: note.relativePath, factId: fact.factId }
    }
  }
  if (match === null) {
    throw new Error('reviewToken gehört zu keinem gültigen aktiven Evaluationssnapshot')
  }
  return match
}

function baseObservationIdFromSnapshot(snapshot: BrainCalibrationTargetSnapshot): string {
  if (!snapshot.sessionId) {
    throw new Error('snapshot.sessionId ist für die Observation-ID erforderlich')
  }
  return calibrationObservationId(
    snapshot.sessionId,
    snapshot.factId,
    calibrationSnapshotFingerprint(snapshot),
  )
}

function temporalObservationId(
  baseObservationId: string,
  observedAt: string,
  validityClass: BrainCalibrationValidityClass,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'calibration-validity-observation-v1',
      baseObservationId,
      observedAt,
      validityClass,
    ]))
    .digest('hex')
    .slice(0, 24)
  return `ko-${digest}`
}

function expectedEntryObservationId(entry: BrainCalibrationEntry): string {
  const baseObservationId = entry.baseObservationId
    ?? baseObservationIdFromSnapshot(entry.snapshot)
  if (entry.label !== 'still_valid') return baseObservationId
  if (!entry.snapshot.observedAt || !entry.snapshot.validityClass) {
    throw new Error('still_valid braucht observedAt und validityClass für die Observation-ID')
  }
  return temporalObservationId(
    baseObservationId,
    entry.snapshot.observedAt,
    entry.snapshot.validityClass,
  )
}

function parseEntry(value: unknown, index: number): BrainCalibrationEntry {
  const field = `entries[${index}]`
  const record = requireRecord(value, field)
  rejectUnknownKeys(record, ENTRY_KEYS, field)

  if (typeof record.label !== 'string' || !LABELS.includes(record.label as BrainCalibrationLabel)) {
    throw new Error(`${field}.label ist ungültig`)
  }
  if (typeof record.value !== 'boolean') throw new Error(`${field}.value muss boolean sein`)

  const entry: BrainCalibrationEntry = {
    observationId: opaqueIdentifier(record.observationId, `${field}.observationId`, 32),
    baseObservationId: record.baseObservationId === undefined
      ? undefined
      : opaqueIdentifier(record.baseObservationId, `${field}.baseObservationId`, 32),
    label: record.label as BrainCalibrationLabel,
    value: record.value,
    snapshot: parseSnapshot(record.snapshot),
    recordedAt: isoTimestamp(record.recordedAt, `${field}.recordedAt`),
    reviewer: opaqueIdentifier(record.reviewer, `${field}.reviewer`, 64),
  }
  if (!/^ko-[a-f0-9]{24}$/.test(entry.observationId)) {
    throw new Error(`${field}.observationId muss eine kanonische ko-ID sein`)
  }
  if (!entry.snapshot.sourcePath || !entry.snapshot.sessionId || !entry.snapshot.projectGroupId) {
    throw new Error(`${field}.snapshot braucht sourcePath, sessionId und projectGroupId`)
  }
  const expectedBaseObservationId = baseObservationIdFromSnapshot(entry.snapshot)
  if (
    entry.baseObservationId !== undefined
    && !/^ko-[a-f0-9]{24}$/.test(entry.baseObservationId)
  ) {
    throw new Error(`${field}.baseObservationId muss eine kanonische ko-ID sein`)
  }
  if (
    entry.baseObservationId !== undefined
    && entry.baseObservationId !== expectedBaseObservationId
  ) {
    throw new Error(`${field}.baseObservationId stimmt nicht mit dem Snapshot überein`)
  }
  const hadExplicitBaseObservationId = entry.baseObservationId !== undefined
  entry.baseObservationId = expectedBaseObservationId
  validateEntry(entry, field)
  const expectedObservationId = expectedEntryObservationId(entry)
  const isLegacyTemporalObservation = entry.label === 'still_valid'
    && !hadExplicitBaseObservationId
    && entry.observationId === expectedBaseObservationId
  if (entry.observationId !== expectedObservationId && !isLegacyTemporalObservation) {
    throw new Error(`${field}.observationId stimmt nicht mit dem Snapshot überein`)
  }
  // Schema-V2 datasets written before temporal observation IDs used the base
  // ID for still_valid. Normalize in memory and persist the explicit base ID
  // on the next successful write.
  entry.observationId = expectedObservationId
  return entry
}

function validateEntry(entry: BrainCalibrationEntry, field = 'entry'): void {
  if (Date.parse(entry.snapshot.generatedAt) > Date.parse(entry.recordedAt)) {
    throw new Error(`${field}.recordedAt darf nicht vor snapshot.generatedAt liegen`)
  }
  validateTemporalLabel(entry)
}

function validateTemporalLabel(entry: BrainCalibrationEntry): void {
  if (entry.label !== 'still_valid') return
  if (!entry.snapshot.observedAt) {
    throw new Error('snapshot.observedAt ist für still_valid erforderlich')
  }
  if (!entry.snapshot.validityClass) {
    throw new Error('snapshot.validityClass ist für still_valid erforderlich')
  }
  if (Date.parse(entry.snapshot.observedAt) > Date.parse(entry.recordedAt)) {
    throw new Error('snapshot.observedAt darf nicht nach recordedAt liegen')
  }
}

function parseDataset(value: unknown): BrainCalibrationDataset {
  const record = requireRecord(value, 'dataset')
  rejectUnknownKeys(record, DATASET_KEYS, 'dataset')
  if (record.schemaVersion !== BRAIN_CALIBRATION_SCHEMA_VERSION) {
    throw new Error(
      `schemaVersion muss ${BRAIN_CALIBRATION_SCHEMA_VERSION} sein (erhalten: ${String(record.schemaVersion)})`,
    )
  }
  if (!Array.isArray(record.entries)) throw new Error('dataset.entries muss ein Array sein')
  if (record.entries.length > MAX_ENTRIES) {
    throw new Error(`dataset.entries darf höchstens ${MAX_ENTRIES} Einträge enthalten`)
  }

  const entries = record.entries.map(parseEntry)
  const keys = new Set<string>()
  for (const entry of entries) {
    const key = entryKey(entry)
    if (keys.has(key)) {
      throw new Error(
        `Doppeltes Label für factId=${entry.snapshot.factId}, label=${entry.label}, reviewer=${entry.reviewer}`,
      )
    }
    keys.add(key)
  }
  return { schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION, entries }
}

function entryKey(entry: BrainCalibrationEntry): string {
  return JSON.stringify([
    entry.observationId,
    entry.label,
    entry.reviewer,
  ])
}

function emptyLabelSummary(): BrainCalibrationLabelSummary {
  return {
    true: 0,
    false: 0,
    labeled: 0,
    jeffreysPosteriorMean: 0.5,
  }
}

function summarize(entries: readonly BrainCalibrationEntry[]): BrainCalibrationSummary {
  const byLabel: BrainCalibrationSummary['byLabel'] = {
    useful: emptyLabelSummary(),
    supported: emptyLabelSummary(),
    still_valid: emptyLabelSummary(),
  }
  for (const entry of entries) {
    const label = byLabel[entry.label]
    label[entry.value ? 'true' : 'false']++
    label.labeled++
  }
  for (const label of LABELS) {
    const item = byLabel[label]
    item.jeffreysPosteriorMean = (item.true + 0.5) / (item.labeled + 1)
  }
  return {
    totalEntries: entries.length,
    uniqueTargets: new Set(entries.map(entry =>
      entry.baseObservationId ?? baseObservationIdFromSnapshot(entry.snapshot))).size,
    uniqueObservations: new Set(entries.map(entry => entry.observationId)).size,
    uniqueFacts: new Set(entries.map(entry => entry.snapshot.factId)).size,
    byLabel,
  }
}

export function readBrainCalibrationDataset(vault: Vault): BrainCalibrationDataset {
  const path = vaultJoin(vault.vaultPath, BRAIN_CALIBRATION_PATH)
  if (!existsSync(path)) {
    return { schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION, entries: [] }
  }
  try {
    return parseDataset(JSON.parse(readFileSync(path, 'utf-8')) as unknown)
  } catch (error) {
    throw new Error(
      `Kalibrierungsdataset ist beschädigt (${BRAIN_CALIBRATION_PATH}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

export function brainCalibrationSummary(vault: Vault): BrainCalibrationSummary {
  return summarize(readBrainCalibrationDataset(vault).entries)
}

export function recordCalibrationLabel(
  vault: Vault,
  options: RecordCalibrationLabelOptions,
): RecordCalibrationLabelResult {
  const dryRun = options.dryRun ?? true
  if (typeof dryRun !== 'boolean') throw new Error('dryRun muss boolean sein')
  if (typeof options.label !== 'string' || !LABELS.includes(options.label as BrainCalibrationLabel)) {
    throw new Error('label muss useful, supported oder still_valid sein')
  }
  if (options.label === 'useful' || options.label === 'supported') {
    throw new Error(
      'useful/supported-Urteile müssen ausnahmslos atomar mit '
      + 'record_calibration_judgement erfasst werden',
    )
  }
  if (typeof options.value !== 'boolean') throw new Error('value muss boolean sein')

  const captured = snapshotFromCapture(vault, options)
  const entry: BrainCalibrationEntry = {
    observationId: captured.observationId,
    baseObservationId: captured.observationId,
    label: options.label,
    value: options.value,
    snapshot: captured.snapshot,
    recordedAt: isoTimestamp(options.recordedAt, 'recordedAt'),
    reviewer: opaqueIdentifier(options.reviewer, 'reviewer', 64),
  }
  validateEntry(entry)
  entry.observationId = expectedEntryObservationId(entry)

  if (!dryRun) {
    assertCanWriteTool(
      'record_calibration_label',
      [BRAIN_CALIBRATION_PATH, BRAIN_CALIBRATION_LOCK_PATH],
    )
  }
  const lock = dryRun ? null : acquireCalibrationLock(vault)
  try {
    const dataset = readBrainCalibrationDataset(vault)
    const key = entryKey(entry)
    const existingIndex = dataset.entries.findIndex(existing => entryKey(existing) === key)
    const operation = existingIndex === -1 ? 'created' : 'updated'
    const entries = [...dataset.entries]
    if (existingIndex === -1) entries.push(entry)
    else {
      const existing = entries[existingIndex]
      if (Date.parse(entry.recordedAt) < Date.parse(existing.recordedAt)) {
        throw new Error(
          'Ein älteres recordedAt darf eine neuere Bewertung desselben logischen Events nicht zurückrollen',
        )
      }
      if (
        entry.recordedAt === existing.recordedAt
        && entry.value !== existing.value
      ) {
        throw new Error(
          'Widersprüchliche Werte mit identischem recordedAt sind nicht deterministisch auflösbar',
        )
      }
      if (JSON.stringify(existing.snapshot) !== JSON.stringify(entry.snapshot)) {
        throw new Error(
          'Ein vorhandenes Kalibrierungslabel darf seinen ursprünglichen Snapshot nicht ersetzen',
        )
      }
      entries[existingIndex] = entry
    }
    if (entries.length > MAX_ENTRIES) {
      throw new Error(`dataset.entries darf höchstens ${MAX_ENTRIES} Einträge enthalten`)
    }

    if (!dryRun) {
      atomicWriteJsonSync(vaultJoin(vault.vaultPath, BRAIN_CALIBRATION_PATH), {
        schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
        entries,
      } satisfies BrainCalibrationDataset)
      appendActionLog(vault.vaultPath, {
        tool: 'record_calibration_label',
        mode: 'apply',
        targets: [BRAIN_CALIBRATION_PATH],
        summary: `Kalibrierungslabel gespeichert: ${entry.snapshot.factId} -> ${entry.label}=${entry.value}`,
        meta: {
          schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
          operation,
          observationId: entry.observationId,
          baseObservationId: entry.baseObservationId,
          factId: entry.snapshot.factId,
          label: entry.label,
          value: entry.value,
          reviewer: entry.reviewer,
        },
      })
    }

    return {
      dryRun,
      path: BRAIN_CALIBRATION_PATH,
      operation,
      entry,
      summary: summarize(entries),
    }
  } finally {
    if (lock) releaseCalibrationLock(lock)
  }
}

/**
 * Stores the two primary review outcomes as one append-only judgement. The
 * complete (observation, reviewer) pair is the freeze marker: identical
 * retries are no-ops and a different value can never overwrite it.
 */
export function recordCalibrationJudgement(
  vault: Vault,
  options: RecordCalibrationJudgementOptions,
): RecordCalibrationJudgementResult {
  const dryRun = options.dryRun ?? true
  if (typeof dryRun !== 'boolean') throw new Error('dryRun muss boolean sein')
  if (typeof options.useful !== 'boolean') throw new Error('useful muss boolean sein')
  if (typeof options.supported !== 'boolean') throw new Error('supported muss boolean sein')
  const reviewer = opaqueIdentifier(options.reviewer, 'reviewer', 64)
  const recordedAt = isoTimestamp(options.recordedAt, 'recordedAt')
  const captured = snapshotFromCapture(vault, {
    reviewToken: options.reviewToken,
    label: 'useful',
    value: options.useful,
    reviewer,
    recordedAt,
    dryRun,
  })
  const proposed = ([
    ['useful', options.useful],
    ['supported', options.supported],
  ] as const).map(([label, value]) => {
    const entry: BrainCalibrationEntry = {
      observationId: captured.observationId,
      baseObservationId: captured.observationId,
      label,
      value,
      snapshot: captured.snapshot,
      recordedAt,
      reviewer,
    }
    validateEntry(entry)
    entry.observationId = expectedEntryObservationId(entry)
    return entry
  })

  if (!dryRun) {
    assertCanWriteTool(
      'record_calibration_judgement',
      [BRAIN_CALIBRATION_PATH, BRAIN_CALIBRATION_LOCK_PATH],
    )
  }
  const lock = dryRun ? null : acquireCalibrationLock(vault)
  try {
    const dataset = readBrainCalibrationDataset(vault)
    const entries = [...dataset.entries]
    let existingCount = 0
    for (const entry of proposed) {
      const index = entries.findIndex(existing => entryKey(existing) === entryKey(entry))
      if (index === -1) continue
      existingCount++
      const existing = entries[index]
      if (JSON.stringify(existing.snapshot) !== JSON.stringify(entry.snapshot)) {
        throw new Error(
          'Ein vorhandenes Kalibrierungsurteil stimmt nicht mit dem attestierten Snapshot überein',
        )
      }
      if (existing.value !== entry.value) {
        throw new Error(
          'Das atomare useful/supported-Urteil ist bereits eingefroren und unveränderlich',
        )
      }
    }

    for (const entry of proposed) {
      if (!entries.some(existing => entryKey(existing) === entryKey(entry))) {
        entries.push(entry)
      }
    }
    if (entries.length > MAX_ENTRIES) {
      throw new Error(`dataset.entries darf höchstens ${MAX_ENTRIES} Einträge enthalten`)
    }
    const operation = existingCount === 0
      ? 'created'
      : existingCount === proposed.length
        ? 'unchanged'
        : 'completed'

    if (!dryRun && operation !== 'unchanged') {
      atomicWriteJsonSync(vaultJoin(vault.vaultPath, BRAIN_CALIBRATION_PATH), {
        schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
        entries,
      } satisfies BrainCalibrationDataset)
      appendActionLog(vault.vaultPath, {
        tool: 'record_calibration_judgement',
        mode: 'apply',
        targets: [BRAIN_CALIBRATION_PATH],
        summary: `Atomare Kalibrierungsbewertung gespeichert (${operation})`,
        meta: {
          schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
          operation,
          observationId: captured.observationId,
          labels: {
            useful: options.useful,
            supported: options.supported,
          },
          reviewer,
        },
      })
    }

    return {
      dryRun,
      path: BRAIN_CALIBRATION_PATH,
      operation,
      labels: {
        useful: options.useful,
        supported: options.supported,
      },
      reviewer,
      summary: summarize(entries),
    }
  } finally {
    if (lock) releaseCalibrationLock(lock)
  }
}
