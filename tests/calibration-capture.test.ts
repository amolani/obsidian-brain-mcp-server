import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  CALIBRATION_CAPTURE_PRODUCER,
  CALIBRATION_CAPTURE_SCHEMA,
  LEGACY_CALIBRATION_CAPTURE_SCHEMA,
  calibrationCaptureIntegrity,
  calibrationObservationId,
  legacyCalibrationCaptureIntegrityV2,
  parseCalibrationCaptureBundle,
  serializeCalibrationReviewPayload,
  type CalibrationCaptureBundleInput,
} from '../services/calibration-capture.ts'

const FIRST = 'ks-11111111111111111111'
const SECOND = 'ks-22222222222222222222'

function captureFrontmatter(bundle: CalibrationCaptureBundleInput) {
  return {
    quelle: CALIBRATION_CAPTURE_PRODUCER,
    session_id: bundle.sessionId,
    importance_model: bundle.modelVersion,
    knowledge_fact_ids: bundle.selectedFactIds,
    calibration_capture_schema: CALIBRATION_CAPTURE_SCHEMA,
    calibration_capture_producer: CALIBRATION_CAPTURE_PRODUCER,
    calibration_capture_integrity: calibrationCaptureIntegrity(bundle),
    calibration_sample_seed: bundle.sampleSeed,
    calibration_candidate_universe_fact_ids: bundle.candidateUniverseFactIds,
    calibration_fact_map: bundle.factMap,
    calibration_snapshot_fingerprints: bundle.snapshotFingerprints,
    calibration_snapshot_payloads: bundle.snapshotPayloads,
    calibration_review_map: bundle.reviewMap,
    calibration_review_payloads: bundle.reviewPayloads,
  }
}

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
    candidateUniverseFactIds: [FIRST, SECOND],
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
  return captureFrontmatter(bundle)
}

function largerUniverseFrontmatter() {
  const sampleSeed = `cs-${'2'.repeat(32)}`
  const candidateUniverseFactIds = Array.from(
    { length: 8 },
    (_, index) => `ks-${(index + 1).toString(16).padStart(20, '0')}`,
  )
  const sampleKey = (factId: string) => createHash('sha256')
    .update(`${sampleSeed}\0${factId}\0calibration-evaluation-v1`)
    .digest('hex')
  const sampledFactIds = [...candidateUniverseFactIds]
    .sort((left, right) =>
      Buffer.compare(Buffer.from(sampleKey(left)), Buffer.from(sampleKey(right)))
      || Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .slice(0, 6)
  const sampled = new Set(sampledFactIds)
  const selectedFactId = candidateUniverseFactIds.find(factId => !sampled.has(factId))
  assert.ok(selectedFactId)
  const capturedFactIds = [selectedFactId, ...sampledFactIds]
  const snapshotPayloads = capturedFactIds.map((factId, index) => JSON.stringify({
    factId,
    modelVersion: 'knowledge-salience-v1',
    evidenceModelVersion: 'evidence-scoring-v1',
    generatedAt: '2026-07-23T08:00:00.000Z',
    sourceTypes: ['phase'],
    selectionStatus: index === 0 ? 'selected' : 'sampled_unselected',
    productionRank: index === 0 ? 1 : null,
    evaluationSample: index !== 0,
    candidatePopulationCount: candidateUniverseFactIds.length,
    samplingProbability: index === 0 ? 0 : 0.75,
  }))
  const bundle: CalibrationCaptureBundleInput = {
    sessionId: 'session-larger-universe',
    modelVersion: 'knowledge-salience-v1',
    sampleSeed,
    candidateUniverseFactIds,
    selectedFactIds: [selectedFactId],
    factMap: capturedFactIds.map((factId, index) =>
      index === 0 ? `F1:${factId}` : `C${index}:${factId}`),
    snapshotFingerprints: capturedFactIds.map((factId, index) =>
      `${factId}:${createHash('sha256').update(snapshotPayloads[index]).digest('hex')}`),
    snapshotPayloads,
    reviewMap: capturedFactIds.map((factId, index) => `R${index + 1}:${factId}`),
    reviewPayloads: capturedFactIds.map((factId, index) =>
      serializeCalibrationReviewPayload({
        reviewId: `R${index + 1}`,
        statement: `Verblindete Aussage ${index + 1}`,
        evidence: [{
          ref: `phase:test-${index + 1}`,
          hash: createHash('sha256').update(factId).digest('hex'),
          excerpt: `Beleg ${index + 1}`,
        }],
      })),
  }
  return {
    frontmatter: captureFrontmatter(bundle),
    sampledFactIds,
    selectedFactId,
  }
}

describe('attested calibration capture bundle', () => {
  test('accepts an exact F/C bijection and produces stable observation ids', () => {
    const parsed = parseCalibrationCaptureBundle(frontmatter())

    assert.deepEqual(parsed.facts.map(fact => fact.reference), ['F1', 'C1'])
    assert.deepEqual(parsed.facts.map(fact => fact.factId), [FIRST, SECOND])
    assert.deepEqual(parsed.facts.map(fact => fact.reviewReference), ['R2', 'R1'])
    assert.deepEqual(parsed.candidateUniverseFactIds, [FIRST, SECOND])
    assert.equal(
      calibrationObservationId(parsed.sessionId, FIRST, parsed.facts[0].fingerprint),
      calibrationObservationId(parsed.sessionId, FIRST, parsed.facts[0].fingerprint),
    )
  })

  test('binds a sorted, unique complete candidate universe and reconstructs the sample', () => {
    assert.throws(
      () => parseCalibrationCaptureBundle(frontmatter({
        candidateUniverseFactIds: [SECOND, FIRST],
      })),
      /byteweise sortiert/,
    )
    assert.throws(
      () => parseCalibrationCaptureBundle(frontmatter({
        candidateUniverseFactIds: [FIRST, FIRST],
      })),
      /keine Duplikate/,
    )
    assert.throws(
      () => parseCalibrationCaptureBundle(frontmatter({
        candidateUniverseFactIds: [SECOND],
      })),
      /Teilmenge des Kandidatenuniversums/,
    )
    assert.throws(
      () => parseCalibrationCaptureBundle(frontmatter({
        candidateUniverseFactIds: [
          FIRST,
          SECOND,
          'ks-33333333333333333333',
        ],
      })),
      /candidatePopulationCount stimmt nicht/,
    )

    const wrongSample = frontmatter()
    const firstPayload = JSON.parse(
      wrongSample.calibration_snapshot_payloads[0],
    ) as Record<string, unknown>
    firstPayload.evaluationSample = false
    firstPayload.samplingProbability = 0
    wrongSample.calibration_snapshot_payloads[0] = JSON.stringify(firstPayload)
    wrongSample.calibration_snapshot_fingerprints[0] =
      `${FIRST}:${createHash('sha256')
        .update(wrongSample.calibration_snapshot_payloads[0])
        .digest('hex')}`
    wrongSample.calibration_capture_integrity = calibrationCaptureIntegrity({
      sessionId: String(wrongSample.session_id),
      modelVersion: String(wrongSample.importance_model),
      sampleSeed: String(wrongSample.calibration_sample_seed),
      candidateUniverseFactIds:
        wrongSample.calibration_candidate_universe_fact_ids,
      selectedFactIds: wrongSample.knowledge_fact_ids,
      factMap: wrongSample.calibration_fact_map,
      snapshotFingerprints: wrongSample.calibration_snapshot_fingerprints,
      snapshotPayloads: wrongSample.calibration_snapshot_payloads,
      reviewMap: wrongSample.calibration_review_map,
      reviewPayloads: wrongSample.calibration_review_payloads,
    })
    assert.throws(
      () => parseCalibrationCaptureBundle(wrongSample),
      /nicht aus Seed und Kandidatenuniversum reproduzierbar/,
    )
  })

  test('requires every sampled reject while retaining a selected non-sample', () => {
    const fixture = largerUniverseFrontmatter()
    const parsed = parseCalibrationCaptureBundle(fixture.frontmatter)
    const selected = parsed.facts.find(fact => fact.factId === fixture.selectedFactId)
    assert.equal(selected?.payload.evaluationSample, false)
    assert.deepEqual(
      parsed.facts
        .filter(fact => fact.payload.evaluationSample === true)
        .map(fact => fact.factId)
        .sort(),
      [...fixture.sampledFactIds].sort(),
    )

    const missingReject = fixture.frontmatter
    missingReject.calibration_fact_map.pop()
    missingReject.calibration_snapshot_fingerprints.pop()
    missingReject.calibration_snapshot_payloads.pop()
    missingReject.calibration_review_map.pop()
    missingReject.calibration_review_payloads.pop()
    missingReject.calibration_capture_integrity = calibrationCaptureIntegrity({
      sessionId: missingReject.session_id,
      modelVersion: missingReject.importance_model,
      sampleSeed: missingReject.calibration_sample_seed,
      candidateUniverseFactIds:
        missingReject.calibration_candidate_universe_fact_ids,
      selectedFactIds: missingReject.knowledge_fact_ids,
      factMap: missingReject.calibration_fact_map,
      snapshotFingerprints: missingReject.calibration_snapshot_fingerprints,
      snapshotPayloads: missingReject.calibration_snapshot_payloads,
      reviewMap: missingReject.calibration_review_map,
      reviewPayloads: missingReject.calibration_review_payloads,
    })
    assert.throws(
      () => parseCalibrationCaptureBundle(missingReject),
      /Gesampelter nicht ausgewählter Fakt .* fehlt/,
    )
  })

  test('keeps legacy V2 captures read-only parseable without claiming a bound universe', () => {
    const legacy: Record<string, unknown> = frontmatter()
    legacy.calibration_capture_schema = LEGACY_CALIBRATION_CAPTURE_SCHEMA
    delete legacy.calibration_candidate_universe_fact_ids
    legacy.calibration_capture_integrity = legacyCalibrationCaptureIntegrityV2({
      sessionId: String(legacy.session_id),
      modelVersion: String(legacy.importance_model),
      sampleSeed: String(legacy.calibration_sample_seed),
      selectedFactIds: legacy.knowledge_fact_ids as string[],
      factMap: legacy.calibration_fact_map as string[],
      snapshotFingerprints: legacy.calibration_snapshot_fingerprints as string[],
      snapshotPayloads: legacy.calibration_snapshot_payloads as string[],
      reviewMap: legacy.calibration_review_map as string[],
      reviewPayloads: legacy.calibration_review_payloads as string[],
    })

    const parsed = parseCalibrationCaptureBundle(legacy)
    assert.equal(parsed.schema, LEGACY_CALIBRATION_CAPTURE_SCHEMA)
    assert.equal(parsed.candidateUniverseFactIds, null)
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
