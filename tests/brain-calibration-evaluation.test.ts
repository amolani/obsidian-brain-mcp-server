import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Vault } from '../vault.ts'
import {
  BRAIN_CALIBRATION_PATH,
  BRAIN_CALIBRATION_SCHEMA_VERSION,
  calibrationSnapshotFingerprint,
  serializeCalibrationSnapshotCore,
  type BrainCalibrationEntry,
  type BrainCalibrationTargetSnapshot,
} from '../services/brain-calibration.ts'
import {
  clusterBootstrapComparison,
  evaluateBrainCalibration,
  evaluateProbabilityPredictions,
  mnarBrierIdentificationInterval,
} from '../services/brain-calibration-evaluation.ts'
import {
  CALIBRATION_CAPTURE_PRODUCER,
  CALIBRATION_CAPTURE_SCHEMA,
  calibrationCaptureIntegrity,
  calibrationObservationId,
  calibrationProjectGroupId,
  serializeCalibrationReviewPayload,
} from '../services/calibration-capture.ts'
import { scoreKnowledgeSalienceFactors } from '../services/knowledge-salience.ts'
import { cleanupVault, createTempVault } from './helpers.ts'

function factId(index: number): string {
  return `ks-${createHash('sha256').update(`fact-${index}`).digest('hex').slice(0, 20)}`
}

function snapshot(index: number, generatedAt: string): BrainCalibrationTargetSnapshot {
  const variant = index % 5
  const factors = {
    taskRelevance: 0.35 + variant * 0.12,
    decisionOutcomeUtility: 0.3 + (index % 4) * 0.15,
    noveltyInformativeness: 0.25 + (index % 3) * 0.2,
    reusability: 0.4 + (index % 2) * 0.35,
    specificity: 0.45 + (index % 4) * 0.1,
  }
  const sourcePath = `Kunden/Projekt-${index}/Capture-${index}.md`
  return {
    modelVersion: 'knowledge-salience-v1',
    evidenceModelVersion: 'evidence-scoring-v1',
    factId: factId(index),
    kind: index % 2 === 0 ? 'decision' : 'verification',
    salienceScore: scoreKnowledgeSalienceFactors(factors),
    evidenceScore: 88,
    factors,
    sourceTypes: ['bash_pair'],
    independentUnitCount: 1,
    evidenceConflict: false,
    generatedAt,
    selectionStatus: 'selected',
    productionRank: 1,
    evaluationSample: true,
    candidatePopulationCount: 1,
    samplingProbability: 1,
    sourcePath,
    sessionId: `session-${index}`,
    projectGroupId: calibrationProjectGroupId(sourcePath),
  }
}

function entry(
  index: number,
  value: boolean,
  reviewer = 'reviewer-a',
): BrainCalibrationEntry {
  const day = new Date(Date.UTC(2026, 0, 1 + index))
  const generatedAt = day.toISOString()
  const target = snapshot(index, generatedAt)
  return entryForSnapshot(target, value, reviewer)
}

function entryForSnapshot(
  target: BrainCalibrationTargetSnapshot,
  value: boolean,
  reviewer = 'reviewer-a',
  label: BrainCalibrationEntry['label'] = 'useful',
): BrainCalibrationEntry {
  const observationId = calibrationObservationId(
    target.sessionId ?? '',
    target.factId,
    calibrationSnapshotFingerprint(target),
  )
  return {
    observationId,
    baseObservationId: observationId,
    label,
    value,
    snapshot: target,
    recordedAt: new Date(
      Date.parse(target.generatedAt) + 3_600_000,
    ).toISOString(),
    reviewer,
  }
}

function writeCaptureFrame(
  vaultPath: string,
  sourcePath: string,
  snapshots: BrainCalibrationTargetSnapshot[],
): void {
  const first = snapshots[0]
  assert.ok(first?.sessionId)
  const selected = snapshots.filter(item => item.selectionStatus === 'selected')
  const factMap = snapshots.map((item, index) => item.selectionStatus === 'selected'
    ? `F${item.productionRank}:${item.factId}`
    : `C${index - selected.length + 1}:${item.factId}`)
  const snapshotFingerprints = snapshots.map(
    item => `${item.factId}:${calibrationSnapshotFingerprint(item)}`,
  )
  const snapshotPayloads = snapshots.map(serializeCalibrationSnapshotCore)
  const reviewMap = snapshots.map((item, index) => `R${index + 1}:${item.factId}`)
  const reviewPayloads = snapshots.map((item, index) =>
    serializeCalibrationReviewPayload({
      reviewId: `R${index + 1}`,
      statement: `Blind review statement ${index + 1}`,
      evidence: [...new Set(item.sourceTypes)].map((source, sourceIndex) => ({
        ref: `${source}:frame-${index + 1}-${sourceIndex + 1}`,
        hash: `${(index + sourceIndex + 1) % 10}`.repeat(64),
        excerpt: `Attested evidence ${index + 1}-${sourceIndex + 1}`,
      })),
    }))
  const sampleSeed = `cs-${'b'.repeat(32)}`
  const bundle = {
    sessionId: first.sessionId,
    modelVersion: first.modelVersion,
    sampleSeed,
    selectedFactIds: selected.map(item => item.factId),
    factMap,
    snapshotFingerprints,
    snapshotPayloads,
    reviewMap,
    reviewPayloads,
  }
  const yamlArray = (values: readonly string[]) =>
    values.map(value => `  - ${JSON.stringify(value)}`).join('\n')
  const fullPath = join(vaultPath, sourcePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, [
    '---',
    'quelle: knowledge-harvester',
    `session_id: ${JSON.stringify(first.sessionId)}`,
    `importance_model: ${JSON.stringify(first.modelVersion)}`,
    `calibration_capture_schema: ${CALIBRATION_CAPTURE_SCHEMA}`,
    `calibration_capture_producer: ${CALIBRATION_CAPTURE_PRODUCER}`,
    `calibration_capture_integrity: ${calibrationCaptureIntegrity(bundle)}`,
    `calibration_sample_seed: ${sampleSeed}`,
    'knowledge_fact_ids:',
    yamlArray(bundle.selectedFactIds),
    'calibration_fact_map:',
    yamlArray(factMap),
    'calibration_snapshot_fingerprints:',
    yamlArray(snapshotFingerprints),
    'calibration_snapshot_payloads:',
    yamlArray(snapshotPayloads),
    'calibration_review_map:',
    yamlArray(reviewMap),
    'calibration_review_payloads:',
    yamlArray(reviewPayloads),
    '---',
    '',
    '# Calibration frame',
    '',
  ].join('\n'), 'utf-8')
}

describe('brain calibration scientific evaluation', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(() => {
    vaultPath = createTempVault()
    vault = new Vault(vaultPath)
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('computes probability metrics without accepting ordinal scores implicitly', () => {
    const perfect = evaluateProbabilityPredictions([
      { target: 1, probability: 0.999999, groupId: 'a' },
      { target: 0, probability: 0.000001, groupId: 'b' },
    ], 0.5)
    const wrong = evaluateProbabilityPredictions([
      { target: 1, probability: 0.000001, groupId: 'a' },
      { target: 0, probability: 0.999999, groupId: 'b' },
    ], 0.5)

    assert.ok(perfect.brier < 0.000001)
    assert.ok(perfect.logLoss < 0.00001)
    assert.ok(wrong.brier > 0.99)
    assert.ok(wrong.logLoss > 10)
    assert.throws(
      () => evaluateProbabilityPredictions([
        { target: 1, probability: 78, groupId: 'ordinal-is-not-probability' },
      ], 0.5),
      /Vorhersage/,
    )
  })

  test('uses Hájek inverse-probability weights for probability metrics', () => {
    const weighted = evaluateProbabilityPredictions([
      {
        target: 1,
        probability: 0.9,
        groupId: 'small-session',
        samplingWeight: 1,
      },
      {
        target: 0,
        probability: 0.9,
        groupId: 'large-session',
        samplingWeight: 9,
      },
    ], 0.5)

    assert.equal(weighted.count, 2)
    assert.equal(weighted.weightedCount, 10)
    assert.equal(weighted.effectiveSampleSize, 1.219512)
    assert.equal(weighted.brier, 0.73)
    assert.equal(weighted.falsePromotionRate, 0.9)
    assert.equal(weighted.falsePositiveRate, 1)
    assert.equal(weighted.promotionCoverage, 1)
  })

  test('widens Brier uncertainty conservatively for arbitrary MNAR outcomes', () => {
    assert.deepEqual(
      mnarBrierIdentificationInterval({ low: -0.1, high: -0.05 }, 0.8),
      { low: -0.28, high: 0.16 },
    )
    assert.deepEqual(
      mnarBrierIdentificationInterval({ low: -0.1, high: -0.05 }, 1),
      { low: -0.1, high: -0.05 },
    )
    assert.throws(
      () => mnarBrierIdentificationInterval({ low: -0.1, high: -0.05 }, 1.1),
      /weightedResponseRate/,
    )
  })

  test('uses a deterministic paired cluster bootstrap', () => {
    const rows = [
      { target: 1 as const, baseline: 0.6, candidate: 0.6, groupId: 'session-a' },
      { target: 0 as const, baseline: 0.4, candidate: 0.4, groupId: 'session-b' },
      { target: 1 as const, baseline: 0.7, candidate: 0.7, groupId: 'session-c' },
    ]
    const first = clusterBootstrapComparison(rows, 200, 'fixed-seed')
    const second = clusterBootstrapComparison(rows, 200, 'fixed-seed')

    assert.deepEqual(first, second)
    assert.equal(first.deltaBrier, 0)
    assert.equal(first.deltaLogLoss, 0)
    assert.deepEqual(first.brier95, { low: 0, high: 0 })
    assert.equal(first.falsePromotion95, null)
    assert.equal(first.baselinePromotedCount, 0)
    assert.equal(first.candidatePromotedCount, 0)
  })

  test('bootstraps false-promotion, false-positive, and coverage deltas by cluster', () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      target: index % 2 as 0 | 1,
      baseline: 0.8,
      candidate: 0.8,
      groupId: `session-${index}`,
      samplingWeight: index < 30 ? 1 : 3,
    }))
    const result = clusterBootstrapComparison(rows, 300, 'promotion-intervals')

    assert.deepEqual(result.falsePromotion95, { low: 0, high: 0 })
    assert.deepEqual(result.falsePositiveRate95, { low: 0, high: 0 })
    assert.deepEqual(result.promotionCoverage95, { low: 0, high: 0 })
    assert.equal(result.baselinePromotedCount, 60)
    assert.equal(result.candidatePromotedCount, 60)
    assert.equal(result.falsePromotionBootstrapSamples, 300)
  })

  test('abstains on reviewer ties and never mutates active weights', () => {
    const tied = entry(1, true, 'reviewer-a')
    const opposite: BrainCalibrationEntry = {
      ...tied,
      value: false,
      reviewer: 'reviewer-b',
    }
    writeFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), JSON.stringify({
      schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
      entries: [tied, opposite, entry(2, true)],
    }), 'utf-8')

    const result = evaluateBrainCalibration(vault, {
      label: 'useful',
      bootstrapSamples: 100,
    })
    assert.equal(result.activeWeightsChanged, false)
    assert.equal(result.reports[0]?.status, 'collecting')
    assert.equal(result.reports[0]?.split.abstainedTies, 1)
    assert.equal(result.reports[0]?.shadowCandidate, null)
  })

  test('fits train-only probability models but keeps a small holdout exploratory', () => {
    const entries = Array.from({ length: 120 }, (_, index) =>
      entry(index, index % 2 === 0))
    writeFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), JSON.stringify({
      schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
      entries,
    }), 'utf-8')

    const result = evaluateBrainCalibration(vault, {
      label: 'useful',
      groupBy: 'session',
      bootstrapSamples: 200,
    })
    const report = result.reports[0]
    assert.ok(report)
    assert.equal(report.status, 'exploratory')
    assert.equal(report.recommendation, 'continue_shadow')
    assert.ok(report.calibratedProductionScore)
    assert.ok(report.shadowCandidate)
    assert.ok(report.comparison)
    assert.equal(report.comparison?.clusterBootstrap, true)
    assert.equal(report.comparison?.pairedCoverage, 1)
    assert.equal(report.weightChangeAllowed, false)
    assert.equal(report.releaseDecisionAllowed, false)
    assert.equal(report.calibratedProductionScore?.monotonicOrdinalScore, true)
    assert.ok(
      report.calibratedProductionScore?.standardizedCoefficients.every(
        coefficient => coefficient >= 0,
      ),
    )
    assert.ok(
      report.reasons.some(reason => reason.includes('positive Vorhersagen')),
    )
    assert.equal(result.releaseDecisionAllowed, false)
    assert.equal(JSON.stringify(result).includes('release_gate_eligible'), false)
    assert.equal(JSON.stringify(result).includes('candidate_promising'), false)
    assert.equal(JSON.stringify(result).includes('Kunden/Projekt-'), false)
    assert.equal(JSON.stringify(result).includes('reviewer-a'), false)
  })

  test('embargoes leakage groups spanning the cutoff and keeps train strictly before test', () => {
    const spanningFactId = factId(9_000)
    const dates = Array.from(
      { length: 10 },
      (_, index) => new Date(Date.UTC(2026, index + 1, 1)).toISOString(),
    )
    const uniqueEntries = dates.map((generatedAt, index) => {
      const target = snapshot(1_000 + index, generatedAt)
      return entryForSnapshot(target, index % 2 === 0)
    })
    const spanningEntries = [
      { index: 8_000, generatedAt: '2026-01-01T00:00:00.000Z' },
      { index: 8_001, generatedAt: '2026-12-31T00:00:00.000Z' },
    ].map(({ index, generatedAt }) => {
      const original = snapshot(index, generatedAt)
      const target: BrainCalibrationTargetSnapshot = {
        ...original,
        factId: spanningFactId,
      }
      return entryForSnapshot(target, index % 2 === 0)
    })
    writeFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), JSON.stringify({
      schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
      entries: [...uniqueEntries, ...spanningEntries],
    }), 'utf-8')

    const result = evaluateBrainCalibration(vault, {
      label: 'useful',
      groupBy: 'session',
      bootstrapSamples: 100,
    })
    const split = result.reports[0]?.split
    assert.ok(split)
    assert.equal(split.embargoedTargets, 2)
    assert.equal(split.embargoedGroups, 1)
    assert.equal(split.strictTemporalOrder, true)
    assert.ok(split.trainLatestAt)
    assert.ok(split.testEarliestAt)
    assert.ok(Date.parse(split.trainLatestAt) < Date.parse(split.testEarliestAt))
  })

  test('reports response coverage from attested captures instead of label-only denominators', async () => {
    const sourcePath = 'Kunden/Coverage/Capture.md'
    const generatedAt = '2026-07-20T09:00:00.000Z'
    const sessionId = 'coverage-session'
    const selectedBase = snapshot(7_000, generatedAt)
    const selected: BrainCalibrationTargetSnapshot = {
      ...selectedBase,
      sourcePath,
      sessionId,
      projectGroupId: calibrationProjectGroupId(sourcePath),
      candidatePopulationCount: 2,
      samplingProbability: 1,
      selectionStatus: 'selected',
      productionRank: 1,
    }
    const unselectedBase = snapshot(7_001, generatedAt)
    const unselected: BrainCalibrationTargetSnapshot = {
      ...unselectedBase,
      sourcePath,
      sessionId,
      projectGroupId: calibrationProjectGroupId(sourcePath),
      candidatePopulationCount: 2,
      samplingProbability: 1,
      selectionStatus: 'sampled_unselected',
      productionRank: null,
    }
    writeCaptureFrame(vaultPath, sourcePath, [selected, unselected])
    writeFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), JSON.stringify({
      schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
      entries: [
        entryForSnapshot(selected, true, 'reviewer-a', 'useful'),
        entryForSnapshot(selected, true, 'reviewer-a', 'supported'),
        entryForSnapshot(unselected, true, 'reviewer-a', 'supported'),
      ],
    }), 'utf-8')
    await vault.init({ quiet: true })

    const result = evaluateBrainCalibration(vault, {
      label: 'all',
      bootstrapSamples: 100,
    })
    const useful = result.reports.find(report => report.label === 'useful')
    const supported = result.reports.find(report => report.label === 'supported')
    assert.ok(useful)
    assert.ok(supported)
    assert.equal(useful.responseCoverage.eligibleTargets, 2)
    assert.equal(useful.responseCoverage.labeledTargets, 1)
    assert.equal(useful.responseCoverage.responseRate, 0.5)
    assert.equal(useful.responseCoverage.weightedEligibleTargets, 2)
    assert.equal(useful.responseCoverage.weightedLabeledTargets, 1)
    assert.equal(useful.responseCoverage.weightedResponseRate, 0.5)
    assert.equal(useful.responseCoverage.selected.responseRate, 1)
    assert.equal(useful.responseCoverage.sampledUnselected.responseRate, 0)
    assert.equal(useful.responseCoverage.completeUsefulSupportedTargets, 1)
    assert.equal(useful.responseCoverage.completeUsefulSupportedRate, 0.5)
    assert.equal(
      useful.responseCoverage.weightedCompleteUsefulSupportedRate,
      0.5,
    )
    assert.equal(useful.responseCoverage.mnarIdentifiable, false)
    assert.equal(
      useful.responseCoverage.assessment,
      'coverage_below_validation_gate',
    )
    assert.equal(supported.responseCoverage.responseRate, 1)
    assert.equal(supported.responseCoverage.invalidCaptureBundles, 0)
    assert.equal(supported.responseCoverage.labelsOutsideFrame, 0)
  })

  test('uses IPW response coverage when sessions have unequal sampling probabilities', async () => {
    const smallPath = 'Kunden/Coverage/Small.md'
    const largePath = 'Kunden/Coverage/Large.md'
    const generatedAt = '2026-07-20T09:00:00.000Z'
    const smallBase = snapshot(7_100, generatedAt)
    const small: BrainCalibrationTargetSnapshot = {
      ...smallBase,
      sourcePath: smallPath,
      sessionId: 'coverage-small',
      projectGroupId: calibrationProjectGroupId(smallPath),
      candidatePopulationCount: 1,
      samplingProbability: 1,
      productionRank: 1,
    }
    const large = Array.from({ length: 6 }, (_, index) => {
      const target = snapshot(7_200 + index, generatedAt)
      return {
        ...target,
        sourcePath: largePath,
        sessionId: 'coverage-large',
        projectGroupId: calibrationProjectGroupId(largePath),
        candidatePopulationCount: 12,
        samplingProbability: 0.5,
        selectionStatus: 'selected' as const,
        productionRank: index + 1,
      }
    })
    writeCaptureFrame(vaultPath, smallPath, [small])
    writeCaptureFrame(vaultPath, largePath, large)
    writeFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), JSON.stringify({
      schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
      entries: [entryForSnapshot(small, true)],
    }), 'utf-8')
    await vault.init({ quiet: true })

    const result = evaluateBrainCalibration(vault, {
      label: 'useful',
      bootstrapSamples: 100,
    })
    const coverage = result.reports[0]?.responseCoverage
    assert.ok(coverage)
    assert.equal(coverage.eligibleTargets, 7)
    assert.equal(coverage.labeledTargets, 1)
    assert.equal(coverage.responseRate, 0.142857)
    assert.equal(coverage.weightedEligibleTargets, 13)
    assert.equal(coverage.weightedLabeledTargets, 1)
    assert.equal(coverage.weightedResponseRate, 0.076923)
    assert.equal(coverage.selected.weightedResponseRate, 0.076923)
    assert.equal(coverage.assessment, 'coverage_below_validation_gate')
  })

  test('separates holdout-era coverage and reports score and population-size bands', async () => {
    const entries: BrainCalibrationEntry[] = []
    for (let index = 0; index < 10; index++) {
      const generatedAt = new Date(Date.UTC(2026, index, 1)).toISOString()
      const sourcePath = `Kunden/Coverage-Era/Capture-${index}.md`
      const sessionId = `coverage-era-${index}`
      const selectedBase = snapshot(7_300 + index * 2, generatedAt)
      const selected: BrainCalibrationTargetSnapshot = {
        ...selectedBase,
        sourcePath,
        sessionId,
        projectGroupId: calibrationProjectGroupId(sourcePath),
        candidatePopulationCount: 2,
        samplingProbability: 1,
        selectionStatus: 'selected',
        productionRank: 1,
      }
      const unselectedBase = snapshot(7_301 + index * 2, generatedAt)
      const unselected: BrainCalibrationTargetSnapshot = {
        ...unselectedBase,
        sourcePath,
        sessionId,
        projectGroupId: calibrationProjectGroupId(sourcePath),
        candidatePopulationCount: 2,
        samplingProbability: 1,
        selectionStatus: 'sampled_unselected',
        productionRank: null,
      }
      writeCaptureFrame(vaultPath, sourcePath, [selected, unselected])
      if (index < 9) {
        entries.push(
          entryForSnapshot(selected, index % 2 === 0),
          entryForSnapshot(unselected, index % 2 !== 0),
        )
      }
    }
    writeFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), JSON.stringify({
      schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
      entries,
    }), 'utf-8')
    await vault.init({ quiet: true })

    const result = evaluateBrainCalibration(vault, {
      label: 'useful',
      bootstrapSamples: 100,
    })
    const coverage = result.reports[0]?.responseCoverage
    assert.ok(coverage)
    assert.equal(coverage.responseRate, 0.9)
    assert.equal(coverage.weightedResponseRate, 0.9)
    assert.equal(coverage.assessment, 'coverage_gate_met_mnar_unresolved')
    assert.ok(coverage.holdoutEra.startsAt)
    assert.equal(coverage.holdoutEra.eligibleTargets, 6)
    assert.equal(coverage.holdoutEra.labeledTargets, 4)
    assert.equal(coverage.holdoutEra.weightedResponseRate, 0.666667)
    assert.equal(coverage.holdoutEra.selected.weightedResponseRate, 0.666667)
    assert.equal(
      coverage.holdoutEra.sampledUnselected.weightedResponseRate,
      0.666667,
    )
    assert.equal(
      coverage.holdoutEra.assessment,
      'coverage_below_validation_gate',
    )
    assert.equal(
      coverage.scoreBands.reduce((sum, band) => sum + band.eligibleTargets, 0),
      20,
    )
    assert.equal(
      coverage.candidatePopulationBands.find(band => band.band === '1-6')
        ?.eligibleTargets,
      20,
    )
  })

  test('counts invalid calibration captures without exposing their paths', async () => {
    const invalidPath = join(vaultPath, 'Inbox', 'Invalid Calibration.md')
    mkdirSync(dirname(invalidPath), { recursive: true })
    writeFileSync(invalidPath, [
      '---',
      'quelle: knowledge-harvester',
      `calibration_capture_schema: ${CALIBRATION_CAPTURE_SCHEMA}`,
      '---',
      '',
      '# Invalid calibration capture',
    ].join('\n'), 'utf-8')
    await vault.init({ quiet: true })

    const result = evaluateBrainCalibration(vault, {
      label: 'useful',
      bootstrapSamples: 100,
    })
    const coverage = result.reports[0]?.responseCoverage
    assert.ok(coverage)
    assert.equal(coverage.invalidCaptureBundles, 1)
    assert.equal(coverage.assessment, 'frame_unavailable')
    assert.equal(JSON.stringify(result).includes('Invalid Calibration.md'), false)
  })

  test('binds unlabeled response-frame changes into the data fingerprint and run id', async () => {
    const before = evaluateBrainCalibration(vault, {
      label: 'useful',
      bootstrapSamples: 100,
    })
    const sourcePath = 'Kunden/Fingerprint/Unlabeled.md'
    const generatedAt = '2026-07-20T09:00:00.000Z'
    const base = snapshot(7_900, generatedAt)
    const target: BrainCalibrationTargetSnapshot = {
      ...base,
      sourcePath,
      sessionId: 'fingerprint-unlabeled',
      projectGroupId: calibrationProjectGroupId(sourcePath),
    }
    writeCaptureFrame(vaultPath, sourcePath, [target])
    await vault.init({ quiet: true })

    const after = evaluateBrainCalibration(vault, {
      label: 'useful',
      bootstrapSamples: 100,
    })
    assert.notEqual(after.dataFingerprint, before.dataFingerprint)
    assert.notEqual(after.runId, before.runId)
    assert.equal(after.reports[0]?.responseCoverage.eligibleTargets, 1)
    assert.equal(after.reports[0]?.responseCoverage.labeledTargets, 0)
  })
})
