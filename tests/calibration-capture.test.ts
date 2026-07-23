import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  CALIBRATION_CAPTURE_PRODUCER,
  CALIBRATION_CAPTURE_SCHEMA,
  calibrationCaptureIntegrity,
  calibrationObservationId,
  parseCalibrationCaptureBundle,
  serializeCalibrationReviewPayload,
  type CalibrationCaptureBundleInput,
} from '../services/calibration-capture.ts'

const FIRST = 'ks-11111111111111111111'
const SECOND = 'ks-22222222222222222222'

function frontmatter(overrides: Partial<CalibrationCaptureBundleInput> = {}) {
  const snapshotPayloads = [
    JSON.stringify({
      factId: FIRST,
      modelVersion: 'knowledge-salience-v1',
      evidenceModelVersion: 'evidence-scoring-v1',
      generatedAt: '2026-07-23T08:00:00.000Z',
      sourceTypes: ['phase'],
      selectionStatus: 'selected',
      productionRank: 1,
      evaluationSample: true,
      candidatePopulationCount: 2,
      samplingProbability: 1,
    }),
    JSON.stringify({
      factId: SECOND,
      modelVersion: 'knowledge-salience-v1',
      evidenceModelVersion: 'evidence-scoring-v1',
      generatedAt: '2026-07-23T08:00:00.000Z',
      sourceTypes: ['assistant_summary'],
      selectionStatus: 'sampled_unselected',
      productionRank: null,
      evaluationSample: true,
      candidatePopulationCount: 2,
      samplingProbability: 1,
    }),
  ]
  const base: CalibrationCaptureBundleInput = {
    sessionId: 'session-attested',
    modelVersion: 'knowledge-salience-v1',
    sampleSeed: `cs-${'1'.repeat(32)}`,
    selectedFactIds: [FIRST],
    factMap: [`F1:${FIRST}`, `C1:${SECOND}`],
    snapshotFingerprints: [
      `${FIRST}:${createHash('sha256').update(snapshotPayloads[0]).digest('hex')}`,
      `${SECOND}:${createHash('sha256').update(snapshotPayloads[1]).digest('hex')}`,
    ],
    snapshotPayloads,
    reviewMap: [`R1:${SECOND}`, `R2:${FIRST}`],
    reviewPayloads: [
      serializeCalibrationReviewPayload({
        reviewId: 'R1',
        statement: 'Nicht ausgewählte, verblindete Aussage',
        evidence: [{
          ref: 'assistant_summary:a2',
          hash: 'c'.repeat(64),
          excerpt: 'Beleg für die zweite Aussage',
        }],
      }),
      serializeCalibrationReviewPayload({
        reviewId: 'R2',
        statement: 'Ausgewählte, verblindete Aussage',
        evidence: [{
          ref: 'phase:p1',
          hash: 'd'.repeat(64),
          excerpt: 'Beleg für die erste Aussage',
        }],
      }),
    ],
  }
  const bundle = {
    ...base,
    ...overrides,
  } as CalibrationCaptureBundleInput
  return {
    quelle: CALIBRATION_CAPTURE_PRODUCER,
    session_id: bundle.sessionId,
    importance_model: bundle.modelVersion,
    knowledge_fact_ids: bundle.selectedFactIds,
    calibration_capture_schema: CALIBRATION_CAPTURE_SCHEMA,
    calibration_capture_producer: CALIBRATION_CAPTURE_PRODUCER,
    calibration_capture_integrity: calibrationCaptureIntegrity(bundle),
    calibration_sample_seed: bundle.sampleSeed,
    calibration_fact_map: bundle.factMap,
    calibration_snapshot_fingerprints: bundle.snapshotFingerprints,
    calibration_snapshot_payloads: bundle.snapshotPayloads,
    calibration_review_map: bundle.reviewMap,
    calibration_review_payloads: bundle.reviewPayloads,
  }
}

describe('attested calibration capture bundle', () => {
  test('accepts an exact F/C bijection and produces stable observation ids', () => {
    const parsed = parseCalibrationCaptureBundle(frontmatter())

    assert.deepEqual(parsed.facts.map(fact => fact.reference), ['F1', 'C1'])
    assert.deepEqual(parsed.facts.map(fact => fact.factId), [FIRST, SECOND])
    assert.deepEqual(parsed.facts.map(fact => fact.reviewReference), ['R2', 'R1'])
    assert.equal(
      calibrationObservationId(parsed.sessionId, FIRST, parsed.facts[0].fingerprint),
      calibrationObservationId(parsed.sessionId, FIRST, parsed.facts[0].fingerprint),
    )
  })

  test('rejects swapped, duplicate, missing, additional, and tampered mappings', () => {
    assert.throws(
      () => parseCalibrationCaptureBundle(frontmatter({
        selectedFactIds: [FIRST, SECOND],
        factMap: [`F1:${SECOND}`, `F2:${FIRST}`],
      })),
      /exakte Bijektion/,
    )
    assert.throws(
      () => parseCalibrationCaptureBundle(frontmatter({
        factMap: [`F1:${FIRST}`, `C1:${SECOND}`, `C2:${SECOND}`],
        snapshotFingerprints: [
          ...frontmatter().calibration_snapshot_fingerprints,
          frontmatter().calibration_snapshot_fingerprints[1],
        ],
        snapshotPayloads: [
          ...frontmatter().calibration_snapshot_payloads,
          frontmatter().calibration_snapshot_payloads[1],
        ],
        reviewMap: [`R1:${SECOND}`, `R2:${FIRST}`, `R3:${SECOND}`],
        reviewPayloads: [
          ...frontmatter().calibration_review_payloads,
          frontmatter().calibration_review_payloads[0],
        ],
      })),
      /duplizieren/,
    )
    assert.throws(
      () => parseCalibrationCaptureBundle(frontmatter({
        snapshotPayloads: [JSON.stringify({ factId: FIRST })],
      })),
      /gleich lang/,
    )

    const tampered = frontmatter()
    tampered.calibration_snapshot_fingerprints[0] = `${FIRST}:${'c'.repeat(64)}`
    assert.throws(
      () => parseCalibrationCaptureBundle(tampered),
      /nicht reproduzierbar/,
    )

    const tamperedReview = frontmatter()
    tamperedReview.calibration_review_payloads[0] =
      tamperedReview.calibration_review_payloads[0].replace(
        'Nicht ausgewählte',
        'Manipulierte',
      )
    assert.throws(
      () => parseCalibrationCaptureBundle(tamperedReview),
      /Attestation/,
    )
  })

  test('rejects review evidence that does not match the numeric provenance classes', () => {
    const mismatchedReview = serializeCalibrationReviewPayload({
      reviewId: 'R2',
      statement: 'Ausgewählte, verblindete Aussage',
      evidence: [{
        ref: 'bash_pair:wrong-source',
        hash: 'e'.repeat(64),
        excerpt: 'Inhaltlich attestiert, aber falsche Provenienzklasse',
      }],
    })
    assert.throws(
      () => parseCalibrationCaptureBundle(frontmatter({
        reviewPayloads: [
          frontmatter().calibration_review_payloads[0],
          mismatchedReview,
        ],
      })),
      /Review-Evidenz und numerische Provenienzklassen/,
    )
  })
})
