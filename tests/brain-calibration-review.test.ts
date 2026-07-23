import { createHash } from 'node:crypto'
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { TOOL_DEFINITIONS } from '../server-tools.ts'
import {
  BRAIN_CALIBRATION_PATH,
  calibrationSnapshotFingerprint,
  serializeCalibrationSnapshotCore,
  type BrainCalibrationSelectionStatus,
  type BrainCalibrationTargetSnapshot,
} from '../services/brain-calibration.ts'
import {
  BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV,
  BRAIN_CALIBRATION_VAULT_ID_ENV,
  closeBrainCalibrationCampaign,
  registerBrainCalibrationCampaign,
} from '../services/brain-calibration-campaign.ts'
import { brainCalibrationReviewBatch } from '../services/brain-calibration-review.ts'
import {
  CALIBRATION_CAPTURE_PRODUCER,
  CALIBRATION_CAPTURE_SCHEMA,
  CALIBRATION_EVALUATION_SAMPLE_SIZE,
  calibrationCaptureIntegrity,
  calibrationProjectGroupId,
  calibrationReviewToken,
  serializeCalibrationReviewPayload,
  type CalibrationCaptureBundleInput,
  type CalibrationReviewEvidence,
} from '../services/calibration-capture.ts'
import { scoreKnowledgeSalienceFactors } from '../services/knowledge-salience.ts'
import { createToolHandler } from '../tool-handlers.ts'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault } from './helpers.ts'

interface CaptureFactFixture {
  factId: string
  fingerprint: string
  selectionStatus: BrainCalibrationSelectionStatus
  evaluationSample: boolean
  samplingProbability: number
  reviewReference: string
  statement: string
  evidence: CalibrationReviewEvidence[]
}

interface CaptureFixture {
  path: string
  integrity: string
  facts: CaptureFactFixture[]
}

interface CaptureOptions {
  path: string
  sessionId: string
  generatedAt: string
  populationCount: number
  selectedEvaluationCount: number
  unselectedEvaluationCount: number
  selectedOutsideSampleCount?: number
  seedCharacter: string
}

const FACTORS = {
  taskRelevance: 0.8,
  decisionOutcomeUtility: 0.7,
  noveltyInformativeness: 0.6,
  reusability: 0.7,
  specificity: 0.8,
}

function factId(sessionId: string, index: number): string {
  return `ks-${createHash('sha256')
    .update(`calibration-review-test\0${sessionId}\0${index}`)
    .digest('hex')
    .slice(0, 20)}`
}

function writeCapture(vaultPath: string, options: CaptureOptions): CaptureFixture {
  const outsideSample = options.selectedOutsideSampleCount ?? 0
  const sampleSeed = `cs-${options.seedCharacter.repeat(32)}`
  const expectedSampleSize = Math.min(
    CALIBRATION_EVALUATION_SAMPLE_SIZE,
    options.populationCount,
  )
  assert.equal(
    options.selectedEvaluationCount + options.unselectedEvaluationCount,
    expectedSampleSize,
    'Fixture muss die vollständige Evaluationsstichprobe enthalten',
  )
  const candidateUniverseFactIds = Array.from(
    { length: options.populationCount },
    (_, index) => factId(options.sessionId, index),
  ).sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
  const sampledFactIds = [...candidateUniverseFactIds]
    .sort((left, right) => {
      const leftKey = createHash('sha256')
        .update(`${sampleSeed}\0${left}\0calibration-evaluation-v1`)
        .digest('hex')
      const rightKey = createHash('sha256')
        .update(`${sampleSeed}\0${right}\0calibration-evaluation-v1`)
        .digest('hex')
      return leftKey.localeCompare(rightKey, 'en')
        || left.localeCompare(right, 'en')
    })
    .slice(0, expectedSampleSize)
  const sampled = new Set(sampledFactIds)
  const selectedSampleFactIds = sampledFactIds.slice(
    0,
    options.selectedEvaluationCount,
  )
  const unselectedSampleFactIds = sampledFactIds.slice(
    options.selectedEvaluationCount,
  )
  const outsideSampleFactIds = candidateUniverseFactIds
    .filter(id => !sampled.has(id))
    .slice(0, outsideSample)
  assert.equal(
    outsideSampleFactIds.length,
    outsideSample,
    'Fixture braucht genug nicht gesampelte Kandidaten',
  )
  const selectedFactIds = [
    ...selectedSampleFactIds,
    ...outsideSampleFactIds,
  ]
  const samplingProbability = expectedSampleSize / options.populationCount
  const snapshots: BrainCalibrationTargetSnapshot[] = []

  for (const [index, selectedFactId] of selectedFactIds.entries()) {
    const evaluationSample = sampled.has(selectedFactId)
    snapshots.push({
      modelVersion: 'knowledge-salience-v1',
      evidenceModelVersion: 'evidence-scoring-v1',
      factId: selectedFactId,
      kind: 'decision',
      salienceScore: scoreKnowledgeSalienceFactors(FACTORS),
      evidenceScore: 50,
      factors: FACTORS,
      sourceTypes: ['phase'],
      independentUnitCount: 1,
      evidenceConflict: false,
      generatedAt: options.generatedAt,
      selectionStatus: 'selected',
      productionRank: index + 1,
      evaluationSample,
      candidatePopulationCount: options.populationCount,
      samplingProbability: evaluationSample ? samplingProbability : 0,
    })
  }
  for (const unselectedFactId of unselectedSampleFactIds) {
    snapshots.push({
      modelVersion: 'knowledge-salience-v1',
      evidenceModelVersion: 'evidence-scoring-v1',
      factId: unselectedFactId,
      kind: 'verification',
      salienceScore: scoreKnowledgeSalienceFactors(FACTORS),
      evidenceScore: 50,
      factors: FACTORS,
      sourceTypes: ['phase'],
      independentUnitCount: 1,
      evidenceConflict: false,
      generatedAt: options.generatedAt,
      selectionStatus: 'sampled_unselected',
      productionRank: null,
      evaluationSample: true,
      candidatePopulationCount: options.populationCount,
      samplingProbability,
    })
  }

  const selected = snapshots.filter(snapshot => snapshot.selectionStatus === 'selected')
  const factMap = snapshots.map((snapshot, index) =>
    snapshot.selectionStatus === 'selected'
      ? `F${snapshot.productionRank}:${snapshot.factId}`
      : `C${index - selected.length + 1}:${snapshot.factId}`)
  const snapshotFingerprints = snapshots.map(snapshot =>
    `${snapshot.factId}:${calibrationSnapshotFingerprint(snapshot)}`)
  const snapshotPayloads = snapshots.map(serializeCalibrationSnapshotCore)
  const reviewOrder = [...snapshots].sort((left, right) => {
    const leftKey = createHash('sha256')
      .update(`${sampleSeed}\0${left.factId}\0calibration-review-test-v1`)
      .digest('hex')
    const rightKey = createHash('sha256')
      .update(`${sampleSeed}\0${right.factId}\0calibration-review-test-v1`)
      .digest('hex')
    return leftKey.localeCompare(rightKey, 'en')
  })
  const fixtureByFact = new Map<string, CaptureFactFixture>()
  const reviewMap = reviewOrder.map((snapshot, index) => `R${index + 1}:${snapshot.factId}`)
  const reviewPayloads = reviewOrder.map((snapshot, index) => {
    const reviewReference = `R${index + 1}`
    const statement = `Verblindete Aussage ${snapshot.factId.slice(-8)}`
    const evidence = [{
      ref: `phase:review-${snapshot.factId.slice(-8)}`,
      hash: createHash('sha256').update(`evidence\0${snapshot.factId}`).digest('hex'),
      excerpt: `Attestierter Beleg ${snapshot.factId.slice(-8)}`,
    }]
    fixtureByFact.set(snapshot.factId, {
      factId: snapshot.factId,
      fingerprint: calibrationSnapshotFingerprint(snapshot),
      selectionStatus: snapshot.selectionStatus,
      evaluationSample: snapshot.evaluationSample,
      samplingProbability: snapshot.samplingProbability,
      reviewReference,
      statement,
      evidence,
    })
    return serializeCalibrationReviewPayload({
      reviewId: reviewReference,
      statement,
      evidence,
    })
  })
  const bundle = {
    sessionId: options.sessionId,
    modelVersion: 'knowledge-salience-v1',
    sampleSeed,
    candidateUniverseFactIds,
    selectedFactIds: selected.map(snapshot => snapshot.factId),
    factMap,
    snapshotFingerprints,
    snapshotPayloads,
    reviewMap,
    reviewPayloads,
  } satisfies CalibrationCaptureBundleInput
  const integrity = calibrationCaptureIntegrity(bundle)
  const yamlArray = (values: readonly string[]) =>
    values.map(value => `  - ${JSON.stringify(value)}`).join('\n')
  const fullPath = join(vaultPath, options.path)
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, [
    '---',
    'quelle: knowledge-harvester',
    `session_id: ${JSON.stringify(options.sessionId)}`,
    'importance_model: knowledge-salience-v1',
    `calibration_capture_schema: ${CALIBRATION_CAPTURE_SCHEMA}`,
    `calibration_capture_producer: ${CALIBRATION_CAPTURE_PRODUCER}`,
    `calibration_capture_integrity: ${integrity}`,
    `calibration_sample_seed: ${sampleSeed}`,
    'calibration_candidate_universe_fact_ids:',
    yamlArray(candidateUniverseFactIds),
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
    '# Attestierter Kalibrierungsrahmen',
    '',
  ].join('\n'), 'utf-8')

  return {
    path: options.path,
    integrity,
    facts: snapshots.map(snapshot => {
      const fixture = fixtureByFact.get(snapshot.factId)
      assert.ok(fixture)
      return fixture
    }),
  }
}

function evaluationFacts(capture: CaptureFixture): CaptureFactFixture[] {
  return capture.facts.filter(fact => fact.evaluationSample)
}

function assertClose(actual: number | null, expected: number): void {
  assert.notEqual(actual, null)
  assert.ok(Math.abs((actual ?? Number.NaN) - expected) < 1e-12)
}

describe('brain calibration blinded review batch', () => {
  let vaultPath: string
  let anchorPath: string
  let vault: Vault | null
  let previousAnchorDirectory: string | undefined
  let previousVaultId: string | undefined

  beforeEach(() => {
    vaultPath = createTempVault()
    anchorPath = createTempVault()
    vault = null
    previousAnchorDirectory =
      process.env[BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV]
    previousVaultId = process.env[BRAIN_CALIBRATION_VAULT_ID_ENV]
    process.env[BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV] = anchorPath
    process.env[BRAIN_CALIBRATION_VAULT_ID_ENV] =
      `review-test-${createHash('sha256').update(vaultPath).digest('hex').slice(0, 16)}`
  })

  afterEach(() => {
    vault?.shutdown()
    cleanupVault(vaultPath)
    cleanupVault(anchorPath)
    if (previousAnchorDirectory === undefined) {
      delete process.env[BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV]
    } else {
      process.env[BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV] =
        previousAnchorDirectory
    }
    if (previousVaultId === undefined) {
      delete process.env[BRAIN_CALIBRATION_VAULT_ID_ENV]
    } else {
      process.env[BRAIN_CALIBRATION_VAULT_ID_ENV] = previousVaultId
    }
  })

  async function initializeVault(): Promise<Vault> {
    vault = new Vault(vaultPath)
    await vault.init({ quiet: true })
    return vault
  }

  function recordJudgement(
    targetVault: Vault,
    capture: CaptureFixture,
    fact: CaptureFactFixture,
    useful: boolean,
    supported: boolean,
    reviewer: string,
    recordedAt = '2026-07-24T10:00:00.000Z',
  ): void {
    targetVault.recordCalibrationJudgement({
      reviewToken: calibrationReviewToken(
        capture.integrity,
        fact.reviewReference,
        fact.fingerprint,
      ),
      useful,
      supported,
      reviewer,
      recordedAt,
      dryRun: false,
    })
  }

  function writeCampaignFrame(): CaptureFixture[] {
    return [
      writeCapture(vaultPath, {
        path: 'Kunden/Review Campaign/Capture A.md',
        sessionId: 'review-campaign-a',
        generatedAt: '2026-07-20T08:00:00.000Z',
        populationCount: 6,
        selectedEvaluationCount: 3,
        unselectedEvaluationCount: 3,
        seedCharacter: 'a',
      }),
      writeCapture(vaultPath, {
        path: 'Kunden/Review Campaign/Capture B.md',
        sessionId: 'review-campaign-b',
        generatedAt: '2026-07-21T08:00:00.000Z',
        populationCount: 6,
        selectedEvaluationCount: 3,
        unselectedEvaluationCount: 3,
        seedCharacter: 'b',
      }),
    ]
  }

  function registerConfirmedCampaign(
    targetVault: Vault,
    campaignId: string,
  ) {
    const options = {
      campaignId,
      reviewers: ['alice'],
      groupBy: 'session' as const,
      bootstrapSamples: 100,
    }
    const preview = registerBrainCalibrationCampaign(targetVault, {
      ...options,
      dryRun: true,
    })
    return registerBrainCalibrationCampaign(targetVault, {
      ...options,
      expectedRegistrationRoot: preview.artifact.registrationRoot,
      expectedRegisteredAt: preview.artifact.registeredAt,
      dryRun: false,
    }).artifact
  }

  test('shows only evaluation-sample observations with individually blinded attested R payloads', async () => {
    const capture = writeCapture(vaultPath, {
      path: 'Kunden/Review/Blind A.md',
      sessionId: 'blind-session-a',
      generatedAt: '2026-07-20T08:00:00.000Z',
      populationCount: 12,
      selectedEvaluationCount: 3,
      unselectedEvaluationCount: 3,
      selectedOutsideSampleCount: 1,
      seedCharacter: '1',
    })
    const targetVault = await initializeVault()

    const result = brainCalibrationReviewBatch(targetVault, { limit: 200 })
    assert.equal(result.protocolVersion, 'brain-calibration-blind-review-v1')
    assert.deepEqual(result.blindedFields, [
      'selectionStatus',
      'productionRank',
      'salienceScore',
      'evidenceScore',
      'samplingProbability',
    ])
    assert.equal(result.items.length, 6)
    assert.equal(result.coverage.sampledObservations, 6)
    const outsideSample = capture.facts.find(fact => !fact.evaluationSample)
    assert.ok(outsideSample)
    assert.equal(
      result.items.some(item => item.reviewReference === outsideSample.reviewReference),
      false,
    )

    const serializedItems = JSON.stringify(result.items)
    for (const field of result.blindedFields) {
      assert.equal(serializedItems.includes(field), false, field)
    }
    assert.equal(serializedItems.includes('"selectionStatus"'), false)
    assert.equal(serializedItems.includes('"productionRank"'), false)
    assert.equal(serializedItems.includes('"salienceScore"'), false)
    assert.equal(serializedItems.includes('"evidenceScore"'), false)
    assert.equal(serializedItems.includes('"samplingProbability"'), false)
    assert.doesNotMatch(serializedItems, /\b(?:selected|sampled_unselected)\b/)
    assert.doesNotMatch(serializedItems, /(?:^|[^A-Za-z0-9])(?:F|C)[1-9]\d*(?:[^A-Za-z0-9]|$)/)
    assert.doesNotMatch(serializedItems, /\bks-[a-f0-9]{20}\b/)
    assert.equal(serializedItems.includes(capture.path), false)

    for (const item of result.items) {
      assert.match(item.reviewReference, /^R[1-9]\d*$/)
      assert.doesNotMatch(item.reviewReference, /^[FC]/)
      assert.match(item.recordArgs.review_token, /^brt-[a-f0-9]{32}$/)
      assert.deepEqual(Object.keys(item.recordArgs), ['review_token'])
      assert.deepEqual(Object.keys(item).sort(), [
        'attestation',
        'evidence',
        'missingLabels',
        'recordArgs',
        'reviewReference',
        'statement',
      ])
      const expected = capture.facts.find(fact =>
        fact.reviewReference === item.reviewReference)
      assert.ok(expected)
      assert.equal(expected.evaluationSample, true)
      assert.equal(item.reviewReference, expected.reviewReference)
      assert.equal(item.statement, expected.statement)
      assert.deepEqual(item.evidence, expected.evidence)
      assert.deepEqual(item.missingLabels, ['useful', 'supported'])
      assert.deepEqual(item.attestation, {
        schema: CALIBRATION_CAPTURE_SCHEMA,
        integrity: capture.integrity,
      })
    }
  })

  test('uses only the externally anchored archive during a registered campaign', async () => {
    const captures = writeCampaignFrame()
    const targetVault = await initializeVault()
    const registration = registerConfirmedCampaign(
      targetVault,
      'review-archive-fixture',
    )

    assert.throws(
      () => brainCalibrationReviewBatch(targetVault, { limit: 200 }),
      /Reviewer-ID/,
    )
    assert.throws(
      () => brainCalibrationReviewBatch(targetVault, {
        reviewer: 'mallory',
        limit: 200,
      }),
      /nicht registriert/,
    )

    const beforeMutation = brainCalibrationReviewBatch(targetVault, {
      reviewer: 'alice',
      limit: 200,
    })
    assert.equal(beforeMutation.items.length, registration.reviewArchive.length)
    assert.equal(beforeMutation.integrity.validCaptures, captures.length)
    assert.equal(beforeMutation.integrity.invalidCaptures, 0)
    assert.deepEqual(
      new Set(beforeMutation.items.map(item => item.statement)),
      new Set(registration.reviewArchive.map(item => item.review.statement)),
    )

    const livePath = join(vaultPath, captures[0].path)
    writeFileSync(
      livePath,
      readFileSync(livePath, 'utf8').replaceAll(
        'Verblindete Aussage',
        'Nach Registrierung manipulierte Aussage',
      ),
      'utf8',
    )
    targetVault.refreshIndex()

    const afterMutation = brainCalibrationReviewBatch(targetVault, {
      reviewer: 'alice',
      limit: 200,
    })
    assert.deepEqual(afterMutation, beforeMutation)
    assert.doesNotMatch(
      JSON.stringify(afterMutation.items),
      /Nach Registrierung manipulierte Aussage/,
    )
  })

  test('blocks new review batches after campaign closure', async () => {
    writeCampaignFrame()
    const targetVault = await initializeVault()
    const registration = registerConfirmedCampaign(
      targetVault,
      'review-closure-fixture',
    )
    const recordedAt = new Date(Math.max(
      Date.now(),
      Date.parse(registration.registeredAt),
    )).toISOString()
    for (const target of registration.reviewArchive) {
      targetVault.recordCalibrationJudgement({
        reviewToken: target.reviewToken,
        reviewer: 'alice',
        useful: true,
        supported: true,
        recordedAt,
        dryRun: false,
      })
    }
    closeBrainCalibrationCampaign(targetVault, { dryRun: false })

    assert.throws(
      () => brainCalibrationReviewBatch(targetVault, {
        reviewer: 'alice',
        limit: 200,
      }),
      /geschlossen/,
    )
  })

  test('computes pair-level pending work and response coverage for the requested reviewer', async () => {
    const capture = writeCapture(vaultPath, {
      path: 'Kunden/Review/Reviewer Scope.md',
      sessionId: 'reviewer-scope',
      generatedAt: '2026-07-20T08:00:00.000Z',
      populationCount: 6,
      selectedEvaluationCount: 3,
      unselectedEvaluationCount: 3,
      seedCharacter: '2',
    })
    const targetVault = await initializeVault()
    const target = evaluationFacts(capture)[0]
    recordJudgement(targetVault, capture, target, true, false, 'alice')

    const global = targetVault.brainCalibrationReviewBatch({ limit: 200 })
    const alice = targetVault.brainCalibrationReviewBatch({
      reviewer: 'alice',
      limit: 200,
    })
    const bob = targetVault.brainCalibrationReviewBatch({
      reviewer: 'bob',
      limit: 200,
    })
    assert.equal(
      global.items.some(item => item.reviewReference === target.reviewReference),
      false,
    )
    assert.deepEqual(
      bob.items.find(item =>
        item.reviewReference === target.reviewReference)?.missingLabels,
      ['useful', 'supported'],
    )
    assert.equal(
      alice.items.some(item => item.reviewReference === target.reviewReference),
      false,
    )
    assert.deepEqual(
      {
        any: global.coverage.anyLabel,
        useful: global.coverage.useful,
        supported: global.coverage.supported,
        complete: global.coverage.completeUsefulSupported,
      },
      { any: 1, useful: 1, supported: 1, complete: 1 },
    )
    assert.deepEqual(
      {
        any: alice.coverage.anyLabel,
        useful: alice.coverage.useful,
        supported: alice.coverage.supported,
        complete: alice.coverage.completeUsefulSupported,
      },
      { any: 1, useful: 1, supported: 1, complete: 1 },
    )
    assert.deepEqual(
      {
        any: bob.coverage.anyLabel,
        useful: bob.coverage.useful,
        supported: bob.coverage.supported,
        complete: bob.coverage.completeUsefulSupported,
      },
      { any: 0, useful: 0, supported: 0, complete: 0 },
    )
  })

  test('reports only unweighted overall coverage without blind-field side channels', async () => {
    const halfProbability = writeCapture(vaultPath, {
      path: 'Kunden/Review/Half Probability.md',
      sessionId: 'coverage-half',
      generatedAt: '2026-07-20T08:00:00.000Z',
      populationCount: 12,
      selectedEvaluationCount: 3,
      unselectedEvaluationCount: 3,
      seedCharacter: '3',
    })
    const fullProbability = writeCapture(vaultPath, {
      path: 'Kunden/Review/Full Probability.md',
      sessionId: 'coverage-full',
      generatedAt: '2026-07-21T08:00:00.000Z',
      populationCount: 6,
      selectedEvaluationCount: 3,
      unselectedEvaluationCount: 3,
      seedCharacter: '4',
    })
    const targetVault = await initializeVault()
    const halfSelected = evaluationFacts(halfProbability)
      .filter(fact => fact.selectionStatus === 'selected')
    const halfUnselected = evaluationFacts(halfProbability)
      .filter(fact => fact.selectionStatus === 'sampled_unselected')
    const fullUnselected = evaluationFacts(fullProbability)
      .filter(fact => fact.selectionStatus === 'sampled_unselected')
    const complete = [
      [halfProbability, halfSelected[0]],
      [halfProbability, halfSelected[1]],
      [halfProbability, halfUnselected[0]],
      [fullProbability, fullUnselected[0]],
    ] as const
    for (const [capture, fact] of complete) {
      recordJudgement(targetVault, capture, fact, true, true, 'alice')
    }

    const result = targetVault.brainCalibrationReviewBatch({
      reviewer: 'alice',
      limit: 200,
    })
    assert.equal(result.coverage.sampledObservations, 12)
    assert.equal(result.coverage.anyLabel, 4)
    assert.equal(result.coverage.useful, 4)
    assert.equal(result.coverage.supported, 4)
    assert.equal(result.coverage.completeUsefulSupported, 4)
    assertClose(result.coverage.overallRate, 1 / 3)
    assert.deepEqual(
      Object.keys(result.coverage).sort(),
      [
        'anyLabel',
        'completeUsefulSupported',
        'overallRate',
        'sampledObservations',
        'supported',
        'useful',
      ],
    )
    const serializedCoverage = JSON.stringify(result.coverage)
    assert.doesNotMatch(serializedCoverage, /selected|sampled_unselected/)
    assert.doesNotMatch(serializedCoverage, /weighted|samplingProbability/)
    assert.equal(result.items.length, 8)
    assert.equal(result.remaining, 0)
    assert.deepEqual(
      result.items.find(item =>
        item.reviewReference === halfSelected[2].reviewReference)?.missingLabels,
      ['useful', 'supported'],
    )
  })

  test('omits a damaged capture and reports its integrity error', async () => {
    const valid = writeCapture(vaultPath, {
      path: 'Kunden/Review/Valid.md',
      sessionId: 'integrity-valid',
      generatedAt: '2026-07-20T08:00:00.000Z',
      populationCount: 6,
      selectedEvaluationCount: 3,
      unselectedEvaluationCount: 3,
      seedCharacter: '5',
    })
    const invalid = writeCapture(vaultPath, {
      path: 'Kunden/Review/Invalid.md',
      sessionId: 'integrity-invalid',
      generatedAt: '2026-07-20T08:00:00.000Z',
      populationCount: 6,
      selectedEvaluationCount: 3,
      unselectedEvaluationCount: 3,
      seedCharacter: '6',
    })
    const invalidPath = join(vaultPath, invalid.path)
    writeFileSync(
      invalidPath,
      readFileSync(invalidPath, 'utf-8').replace(
        /calibration_capture_integrity: [a-f0-9]{64}/,
        `calibration_capture_integrity: ${'f'.repeat(64)}`,
      ),
      'utf-8',
    )
    const targetVault = await initializeVault()

    const result = targetVault.brainCalibrationReviewBatch({ limit: 200 })
    assert.equal(result.integrity.datasetAvailable, true)
    assert.equal(result.integrity.validCaptures, 1)
    assert.equal(result.integrity.invalidCaptures, 1)
    assert.equal(result.items.length, evaluationFacts(valid).length)
    assert.equal(
      result.items.some(item =>
        invalid.facts.some(fact => fact.statement === item.statement)),
      false,
    )
    assert.match(
      result.integrity.errors.find(error => error.path === invalid.path)?.message ?? '',
      /Attestation/,
    )
  })

  test('fails closed when the label dataset is damaged', async () => {
    writeCapture(vaultPath, {
      path: 'Kunden/Review/Valid With Broken Dataset.md',
      sessionId: 'dataset-broken',
      generatedAt: '2026-07-20T08:00:00.000Z',
      populationCount: 6,
      selectedEvaluationCount: 3,
      unselectedEvaluationCount: 3,
      seedCharacter: '7',
    })
    writeFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), '{ broken dataset', 'utf-8')
    const targetVault = await initializeVault()

    const result = targetVault.brainCalibrationReviewBatch({ limit: 200 })
    assert.equal(result.integrity.datasetAvailable, false)
    assert.equal(result.integrity.validCaptures, 1)
    assert.equal(result.items.length, 0)
    assert.equal(result.remaining, 0)
    assert.equal(result.coverage.sampledObservations, 6)
    assert.equal(result.coverage.completeUsefulSupported, 0)
    assert.match(
      result.integrity.errors.find(error =>
        error.path === BRAIN_CALIBRATION_PATH)?.message ?? '',
      /beschädigt/,
    )
  })

  test('is exposed consistently through the Vault method and MCP tool', async () => {
    writeCapture(vaultPath, {
      path: 'Kunden/Review/Tool Surface.md',
      sessionId: 'tool-surface',
      generatedAt: '2026-07-20T08:00:00.000Z',
      populationCount: 6,
      selectedEvaluationCount: 3,
      unselectedEvaluationCount: 3,
      seedCharacter: '8',
    })
    const targetVault = await initializeVault()
    const direct = brainCalibrationReviewBatch(targetVault, {
      reviewer: 'alice',
      limit: 2,
    })
    const throughVault = targetVault.brainCalibrationReviewBatch({
      reviewer: 'alice',
      limit: 2,
    })
    assert.deepEqual(throughVault, direct)

    const definition = TOOL_DEFINITIONS.find(tool =>
      tool.name === 'brain_calibration_review_batch')
    assert.ok(definition)
    assert.deepEqual(
      Object.keys(definition.inputSchema.properties).sort(),
      ['limit'],
    )
    assert.equal('required' in definition.inputSchema, false)

    const judgementDefinition = TOOL_DEFINITIONS.find(tool =>
      tool.name === 'record_calibration_judgement')
    assert.ok(judgementDefinition)
    assert.deepEqual(
      Object.keys(judgementDefinition.inputSchema.properties).sort(),
      ['dry_run', 'review_token', 'supported', 'useful'],
    )
    assert.deepEqual(
      judgementDefinition.inputSchema.required,
      ['review_token', 'useful', 'supported'],
    )

    const handler = createToolHandler(targetVault)
    const response = await handler({
      params: {
        name: 'brain_calibration_review_batch',
        arguments: { reviewer: 'alice', limit: 2 },
      },
    })
    assert.equal(response.isError, undefined)
    const text = response.content[0]?.text ?? ''
    assert.match(text, /Verblindeter Kalibrierungs-Review/)
    assert.match(text, /brain-calibration-blind-review-v1/)
    assert.match(text, /Reviewer: alice/)
    assert.match(text, /Batch: 2; danach offen: 4/)
    assert.match(text, /## 1\. R[1-9]\d*/)
    assert.match(text, /record_calibration_judgement/)
    assert.doesNotMatch(text, /salienceScore|evidenceScore|productionRank|samplingProbability/)
  })
})
