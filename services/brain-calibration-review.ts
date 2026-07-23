import { createHash } from 'node:crypto'
import type { Vault } from '../vault.ts'
import {
  calibrationObservationId,
  calibrationReviewToken,
  parseCalibrationCaptureBundle,
  type CalibrationReviewEvidence,
} from './calibration-capture.ts'
import {
  readBrainCalibrationDataset,
  type BrainCalibrationEntry,
  type BrainCalibrationLabel,
} from './brain-calibration.ts'
import { isActivePath } from './note-scope.ts'

const REVIEW_LABELS = ['useful', 'supported'] as const
const MAX_REVIEW_BATCH = 200

export interface BrainCalibrationReviewBatchOptions {
  limit?: number
  /** When set, only labels already supplied by this reviewer count as answered. */
  reviewer?: string
}

export interface BrainCalibrationReviewItem {
  /** Randomized, selection-blind reference attested by the capture bundle. */
  reviewReference: string
  statement: string
  evidence: CalibrationReviewEvidence[]
  missingLabels: Array<(typeof REVIEW_LABELS)[number]>
  recordArgs: {
    review_token: string
  }
  attestation: {
    schema: string
    integrity: string
  }
}

export interface BrainCalibrationResponseCoverage {
  sampledObservations: number
  anyLabel: number
  completeUsefulSupported: number
  useful: number
  supported: number
  overallRate: number | null
}

export interface BrainCalibrationReviewBatchResult {
  protocolVersion: 'brain-calibration-blind-review-v1'
  blindedFields: readonly [
    'selectionStatus',
    'productionRank',
    'salienceScore',
    'evidenceScore',
    'samplingProbability',
  ]
  reviewer: string | null
  items: BrainCalibrationReviewItem[]
  remaining: number
  coverage: BrainCalibrationResponseCoverage
  integrity: {
    validCaptures: number
    invalidCaptures: number
    datasetAvailable: boolean
    errors: Array<{ path: string; message: string }>
  }
  instructions: string[]
}

interface ReviewObservation {
  observationId: string
  reviewToken: string
  reviewReference: string
  statement: string
  evidence: CalibrationReviewEvidence[]
  schema: string
  integrity: string
  generatedAt: string
}

function reviewerId(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string') throw new Error('reviewer muss ein String sein')
  const normalized = value.normalize('NFC').trim()
  if (
    !normalized
    || normalized.length > 64
    || /[\u0000-\u001f\u007f]/.test(normalized)
    || !/^[\p{L}\p{N}][\p{L}\p{N}._:@-]*$/u.test(normalized)
  ) {
    throw new Error('reviewer ist keine gültige opake Reviewer-ID')
  }
  return normalized
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

function baseObservationId(entry: BrainCalibrationEntry): string {
  return entry.baseObservationId ?? entry.observationId
}

function answeredLabels(
  entries: readonly BrainCalibrationEntry[],
  reviewer: string | null,
): Map<string, Set<BrainCalibrationLabel>> {
  const byObservation = new Map<string, Set<BrainCalibrationLabel>>()
  for (const entry of entries) {
    if (reviewer !== null && entry.reviewer !== reviewer) continue
    if (entry.label === 'still_valid') continue
    const id = baseObservationId(entry)
    const labels = byObservation.get(id) ?? new Set<BrainCalibrationLabel>()
    labels.add(entry.label)
    byObservation.set(id, labels)
  }
  return byObservation
}

function coverage(
  observations: readonly ReviewObservation[],
  labels: ReadonlyMap<string, ReadonlySet<BrainCalibrationLabel>>,
): BrainCalibrationResponseCoverage {
  const complete = new Set<string>()
  let anyLabel = 0
  let useful = 0
  let supported = 0
  for (const observation of observations) {
    const answered = labels.get(observation.observationId) ?? new Set()
    if (answered.size > 0) anyLabel++
    if (answered.has('useful')) useful++
    if (answered.has('supported')) supported++
    if (REVIEW_LABELS.every(label => answered.has(label))) {
      complete.add(observation.observationId)
    }
  }

  return {
    sampledObservations: observations.length,
    anyLabel,
    completeUsefulSupported: complete.size,
    useful,
    supported,
    overallRate: rate(complete.size, observations.length),
  }
}

/**
 * Presents only the content needed for a human judgement. Individual
 * production status, rank and numeric scores remain internal so the reviewer
 * cannot infer whether a statement was selected or sampled as a reject.
 */
export function brainCalibrationReviewBatch(
  vault: Vault,
  options: BrainCalibrationReviewBatchOptions = {},
): BrainCalibrationReviewBatchResult {
  const limit = options.limit ?? 40
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REVIEW_BATCH) {
    throw new Error(`limit muss eine Ganzzahl zwischen 1 und ${MAX_REVIEW_BATCH} sein`)
  }
  const reviewer = reviewerId(options.reviewer)
  const errors: Array<{ path: string; message: string }> = []
  let entries: BrainCalibrationEntry[] = []
  let datasetAvailable = true
  try {
    entries = readBrainCalibrationDataset(vault).entries
  } catch (error) {
    datasetAvailable = false
    errors.push({
      path: '.brain-calibration.json',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const labels = answeredLabels(entries, reviewer)
  const observations: ReviewObservation[] = []
  let validCaptures = 0
  let invalidCaptures = 0

  for (const note of vault.notes.values()) {
    if (!isActivePath(note.relativePath) || note.frontmatter.quelle !== 'knowledge-harvester') {
      continue
    }
    if (note.frontmatter.calibration_capture_schema === undefined) continue
    try {
      const bundle = parseCalibrationCaptureBundle(note.frontmatter)
      validCaptures++
      for (const fact of bundle.facts) {
        if (fact.payload.evaluationSample !== true) continue
        const generatedAt = fact.payload.generatedAt
        if (typeof generatedAt !== 'string') {
          throw new Error(`Evaluationssnapshot ${fact.factId} ist unvollständig`)
        }
        observations.push({
          observationId: calibrationObservationId(
            bundle.sessionId,
            fact.factId,
            fact.fingerprint,
          ),
          reviewToken: calibrationReviewToken(
            bundle.integrity,
            fact.reviewReference,
            fact.fingerprint,
          ),
          reviewReference: fact.reviewReference,
          statement: fact.review.statement,
          evidence: fact.review.evidence,
          schema: bundle.schema,
          integrity: bundle.integrity,
          generatedAt,
        })
      }
    } catch (error) {
      invalidCaptures++
      errors.push({
        path: note.relativePath,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const pending = datasetAvailable
    ? observations
      .map(observation => {
        const answered = labels.get(observation.observationId) ?? new Set()
        const missingLabels = REVIEW_LABELS.filter(label => !answered.has(label))
        return { observation, missingLabels }
      })
      .filter(item => item.missingLabels.length > 0)
      .sort((left, right) =>
        left.observation.generatedAt.localeCompare(right.observation.generatedAt)
        || createHash('sha256')
          .update(`blind-review-order-v1\0${left.observation.observationId}`)
          .digest('hex')
          .localeCompare(
            createHash('sha256')
              .update(`blind-review-order-v1\0${right.observation.observationId}`)
              .digest('hex'),
          ))
    : []

  return {
    protocolVersion: 'brain-calibration-blind-review-v1',
    blindedFields: [
      'selectionStatus',
      'productionRank',
      'salienceScore',
      'evidenceScore',
      'samplingProbability',
    ],
    reviewer,
    items: pending.slice(0, limit).map(({ observation, missingLabels }) => ({
      reviewReference: observation.reviewReference,
      statement: observation.statement,
      evidence: observation.evidence,
      missingLabels,
      recordArgs: {
        review_token: observation.reviewToken,
      },
      attestation: {
        schema: observation.schema,
        integrity: observation.integrity,
      },
    })),
    remaining: Math.max(0, pending.length - limit),
    coverage: coverage(observations, labels),
    integrity: {
      validCaptures,
      invalidCaptures,
      datasetAvailable,
      errors: errors.slice(0, 50),
    },
    instructions: [
      'Aussage und Evidenz ohne Öffnen der Capture-Notiz beurteilen.',
      'useful bewertet den erwarteten Wiederverwendungsnutzen; supported bewertet ausschließlich die gezeigte Evidenz.',
      'useful und supported gemeinsam mit record_calibration_judgement und dem opaken review_token erfassen.',
      'Die R-Referenz verrät weder produktive Auswahl noch Rang oder Score.',
      'Die Reviewer-Rolle darf während der Bewertung keinen Zugriff auf Produktionsnotizen, Vault-Suche, semantische Suche oder den Evaluator haben.',
    ],
  }
}
