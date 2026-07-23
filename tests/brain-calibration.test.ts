import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Vault } from '../vault.ts'
import { createToolHandler } from '../tool-handlers.ts'
import {
  BRAIN_CALIBRATION_PATH,
  BRAIN_CALIBRATION_LOCK_PATH,
  BRAIN_CALIBRATION_MODEL_REGISTRY,
  BRAIN_CALIBRATION_SCHEMA_VERSION,
  brainCalibrationSummary,
  calibrationSnapshotFingerprint,
  calibrationSnapshotFromFact,
  readBrainCalibrationDataset,
  recordCalibrationJudgement,
  recordCalibrationLabel,
  serializeCalibrationSnapshotCore,
  type BrainCalibrationTargetSnapshot,
  type RecordCalibrationLabelOptions,
} from '../services/brain-calibration.ts'
import { selectSalientKnowledge } from '../services/knowledge-salience.ts'
import { loadBrainPolicy } from '../services/policy.ts'
import {
  CALIBRATION_CAPTURE_PRODUCER,
  CALIBRATION_CAPTURE_SCHEMA,
  calibrationCaptureIntegrity,
  calibrationObservationId,
  calibrationProjectGroupId,
  calibrationReviewToken,
  serializeCalibrationReviewPayload,
} from '../services/calibration-capture.ts'
import { cleanupVault, createTempVault } from './helpers.ts'

const originalPolicyPath = process.env.BRAIN_POLICY_PATH
const basePolicy = structuredClone(loadBrainPolicy())

function snapshot(overrides: Partial<BrainCalibrationTargetSnapshot> = {}): BrainCalibrationTargetSnapshot {
  return {
    modelVersion: 'knowledge-salience-v1',
    evidenceModelVersion: 'evidence-scoring-v1',
    factId: 'ks-1234567890abcdef1234',
    kind: 'decision',
    salienceScore: 78,
    evidenceScore: 58,
    factors: {
      taskRelevance: 0.9,
      decisionOutcomeUtility: 0.8,
      noveltyInformativeness: 0.6,
      reusability: 0.7,
      specificity: 0.8,
    },
    sourceTypes: ['phase', 'error_fix'],
    independentUnitCount: 2,
    evidenceConflict: false,
    generatedAt: '2026-07-20T09:00:00.000Z',
    selectionStatus: 'selected',
    productionRank: 1,
    evaluationSample: true,
    candidatePopulationCount: 1,
    samplingProbability: 1,
    sourcePath: 'Kunden/Schule/Auto Capture.md',
    sessionId: 'session-2026-07-23',
    clientId: 'Schule',
    projectGroupId: calibrationProjectGroupId('Kunden/Schule/Auto Capture.md'),
    ...overrides,
  }
}

function labelOptions(overrides: Partial<RecordCalibrationLabelOptions> = {}): RecordCalibrationLabelOptions {
  return {
    sourcePath: 'Kunden/Schule/Auto Capture.md',
    factId: 'ks-1234567890abcdef1234',
    label: 'supported',
    value: true,
    reviewer: 'amo',
    recordedAt: '2026-07-23T10:00:00.000Z',
    ...overrides,
  }
}

function validityOptions(
  overrides: Partial<RecordCalibrationLabelOptions> = {},
): RecordCalibrationLabelOptions {
  return labelOptions({
    label: 'still_valid',
    observedAt: '2026-07-22T08:00:00.000Z',
    validityClass: 'operational_state',
    ...overrides,
  })
}

function writeSnapshotSource(
  vaultPath: string,
  snapshots: BrainCalibrationTargetSnapshot[],
): Map<string, string> {
  const first = snapshots[0]
  assert.ok(first?.sourcePath)
  assert.ok(first.sessionId)
  const fullPath = join(vaultPath, first.sourcePath)
  mkdirSync(dirname(fullPath), { recursive: true })
  const selected = snapshots.filter(item => item.selectionStatus === 'selected')
  const factIdValues = selected.map(item => item.factId)
  const factMapValues = snapshots.map((item, index) => item.selectionStatus === 'selected'
    ? `F${item.productionRank}:${item.factId}`
    : `C${index - selected.length + 1}:${item.factId}`)
  const fingerprintValues = snapshots
    .map(item => `${item.factId}:${calibrationSnapshotFingerprint(item)}`)
  const payloadValues = snapshots.map(item => serializeCalibrationSnapshotCore(item))
  const sampleSeed = `cs-${'a'.repeat(32)}`
  const reviewMapValues = snapshots.map((item, index) => `R${index + 1}:${item.factId}`)
  const reviewPayloadValues = snapshots.map((item, index) =>
    serializeCalibrationReviewPayload({
      reviewId: `R${index + 1}`,
      statement: `Attested review statement ${index + 1}`,
      evidence: item.sourceTypes.map((source, sourceIndex) => ({
        ref: `${source}:review-${index + 1}-${sourceIndex + 1}`,
        hash: `${((index + sourceIndex) % 10).toString(16)}`.repeat(64),
        excerpt: `Bounded review evidence ${index + 1}-${sourceIndex + 1}`,
      })),
    }))
  const integrity = calibrationCaptureIntegrity({
    sessionId: first.sessionId,
    modelVersion: first.modelVersion,
    sampleSeed,
    selectedFactIds: factIdValues,
    factMap: factMapValues,
    snapshotFingerprints: fingerprintValues,
    snapshotPayloads: payloadValues,
    reviewMap: reviewMapValues,
    reviewPayloads: reviewPayloadValues,
  })
  const factIds = factIdValues.map(item => `  - ${JSON.stringify(item)}`).join('\n')
  const factMap = factMapValues.map(item => `  - ${JSON.stringify(item)}`).join('\n')
  const fingerprints = fingerprintValues
    .map(item => `  - ${JSON.stringify(item)}`)
    .join('\n')
  const payloads = payloadValues
    .map(item => `  - ${JSON.stringify(item)}`)
    .join('\n')
  const reviewMap = reviewMapValues.map(item => `  - ${JSON.stringify(item)}`).join('\n')
  const reviewPayloads = reviewPayloadValues
    .map(item => `  - ${JSON.stringify(item)}`)
    .join('\n')
  writeFileSync(fullPath, [
    '---',
    'quelle: knowledge-harvester',
    `session_id: ${JSON.stringify(first.sessionId)}`,
    `importance_model: ${JSON.stringify(first.modelVersion)}`,
    `calibration_capture_schema: ${CALIBRATION_CAPTURE_SCHEMA}`,
    `calibration_capture_producer: ${CALIBRATION_CAPTURE_PRODUCER}`,
    `calibration_capture_integrity: ${integrity}`,
    `calibration_sample_seed: ${sampleSeed}`,
    'knowledge_fact_ids:',
    factIds,
    'calibration_fact_map:',
    factMap,
    'calibration_snapshot_fingerprints:',
    fingerprints,
    'calibration_snapshot_payloads:',
    payloads,
    'calibration_review_map:',
    reviewMap,
    'calibration_review_payloads:',
    reviewPayloads,
    '---',
    '',
    '# Test Capture',
    '',
  ].join('\n'), 'utf-8')
  return new Map(snapshots.map((item, index) => [
    item.factId,
    calibrationReviewToken(
      integrity,
      `R${index + 1}`,
      calibrationSnapshotFingerprint(item),
    ),
  ]))
}

describe('brain calibration dataset', () => {
  let vaultPath: string
  let vault: Vault
  let policyPath: string

  beforeEach(() => {
    vaultPath = createTempVault()
    writeSnapshotSource(vaultPath, [snapshot()])
    vault = new Vault(vaultPath)
    policyPath = join(vaultPath, 'test-policy.json')
    const policy = structuredClone(basePolicy)
    policy.tools.record_calibration_label = {
      write: true,
      risk: 'low',
      requiresDryRunDefault: true,
    }
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8')
    process.env.BRAIN_POLICY_PATH = policyPath
  })

  test('keeps supported salience and evidence formulas in an explicit registry', () => {
    assert.deepEqual(Object.keys(BRAIN_CALIBRATION_MODEL_REGISTRY.salience), [
      'knowledge-salience-v1',
    ])
    assert.deepEqual(Object.keys(BRAIN_CALIBRATION_MODEL_REGISTRY.evidence), [
      'evidence-scoring-v1',
    ])
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
    if (originalPolicyPath === undefined) delete process.env.BRAIN_POLICY_PATH
    else process.env.BRAIN_POLICY_PATH = originalPolicyPath
  })

  test('is dry-run-first and previews Jeffreys summaries without writing', () => {
    const result = recordCalibrationLabel(vault, validityOptions())

    assert.equal(result.dryRun, true)
    assert.equal(result.operation, 'created')
    assert.equal(result.summary.totalEntries, 1)
    assert.equal(result.summary.uniqueTargets, 1)
    assert.equal(result.summary.uniqueObservations, 1)
    assert.deepEqual(result.summary.byLabel.still_valid, {
      true: 1,
      false: 0,
      labeled: 1,
      jeffreysPosteriorMean: 0.75,
    })
    assert.equal(result.summary.byLabel.useful.jeffreysPosteriorMean, 0.5)
    assert.equal(result.summary.byLabel.supported.jeffreysPosteriorMean, 0.5)
    assert.equal(existsSync(join(vaultPath, BRAIN_CALIBRATION_PATH)), false)
    assert.equal(existsSync(join(vaultPath, '.action-log.jsonl')), false)
  })

  test('previews an atomic blind judgement through MCP without leaking diagnostics', async () => {
    await vault.init({ quiet: true })
    const reviewItem = vault.brainCalibrationReviewBatch({ limit: 1 }).items[0]
    assert.ok(reviewItem)
    const handler = createToolHandler(vault)
    const response = await handler({
      params: {
        name: 'record_calibration_judgement',
        arguments: {
          review_token: reviewItem.recordArgs.review_token,
          useful: false,
          supported: true,
          reviewer: 'amo',
          recorded_at: '2026-07-23T10:00:00.000Z',
        },
      },
    })

    assert.equal(response.isError, undefined)
    assert.match(response.content[0].text, /Dry-Run: true/)
    assert.match(response.content[0].text, /useful: false/)
    assert.match(response.content[0].text, /supported: true/)
    assert.doesNotMatch(response.content[0].text, /Jeffreys|true 1|false 0/)
    assert.doesNotMatch(response.content[0].text, /ks-[a-f0-9]{20}|Auto Capture\.md/)
    assert.equal(existsSync(join(vaultPath, BRAIN_CALIBRATION_PATH)), false)
  })

  test('stores useful and supported atomically and freezes divergent token replays', async () => {
    await vault.init({ quiet: true })
    const reviewToken = vault
      .brainCalibrationReviewBatch({ limit: 1 })
      .items[0]?.recordArgs.review_token
    assert.ok(reviewToken)
    const options = {
      reviewToken,
      useful: false,
      supported: true,
      reviewer: 'amo',
      recordedAt: '2026-07-23T10:00:00.000Z',
    }

    const preview = recordCalibrationJudgement(vault, options)
    assert.equal(preview.dryRun, true)
    assert.equal(preview.operation, 'created')
    assert.equal(preview.summary.totalEntries, 2)
    assert.equal(existsSync(join(vaultPath, BRAIN_CALIBRATION_PATH)), false)

    const created = recordCalibrationJudgement(vault, { ...options, dryRun: false })
    assert.equal(created.operation, 'created')
    assert.equal(readBrainCalibrationDataset(vault).entries.length, 2)

    const replay = recordCalibrationJudgement(vault, {
      ...options,
      dryRun: false,
    })
    assert.equal(replay.operation, 'unchanged')
    assert.equal(readBrainCalibrationDataset(vault).entries.length, 2)

    assert.throws(
      () => recordCalibrationJudgement(vault, {
        ...options,
        useful: true,
        recordedAt: '2026-07-23T11:00:00.000Z',
        dryRun: false,
      }),
      /eingefroren und unveränderlich/,
    )
    assert.throws(
      () => recordCalibrationLabel(vault, {
        reviewToken,
        label: 'supported',
        value: true,
        reviewer: 'amo',
        recordedAt: '2026-07-23T10:00:00.000Z',
        dryRun: false,
      }),
      /atomar mit record_calibration_judgement/,
    )
  })

  test('completes a consistent legacy partial pair but writes nothing on conflict', async () => {
    const legacySnapshot = snapshot({ clientId: undefined })
    const observationId = calibrationObservationId(
      legacySnapshot.sessionId ?? '',
      legacySnapshot.factId,
      calibrationSnapshotFingerprint(legacySnapshot),
    )
    writeFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), JSON.stringify({
      schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
      entries: [{
        observationId,
        baseObservationId: observationId,
        label: 'supported',
        value: true,
        snapshot: legacySnapshot,
        reviewer: 'amo',
        recordedAt: '2026-07-23T10:00:00.000Z',
      }],
    }), 'utf-8')
    await vault.init({ quiet: true })
    const reviewToken = vault
      .brainCalibrationReviewBatch({ reviewer: 'amo', limit: 1 })
      .items[0]?.recordArgs.review_token
    assert.ok(reviewToken)

    assert.throws(
      () => recordCalibrationJudgement(vault, {
        reviewToken,
        useful: false,
        supported: false,
        reviewer: 'amo',
        recordedAt: '2026-07-23T11:00:00.000Z',
        dryRun: false,
      }),
      /eingefroren und unveränderlich/,
    )
    assert.deepEqual(
      readBrainCalibrationDataset(vault).entries.map(entry => entry.label),
      ['supported'],
    )

    const completed = recordCalibrationJudgement(vault, {
      reviewToken,
      useful: false,
      supported: true,
      reviewer: 'amo',
      recordedAt: '2026-07-23T11:00:00.000Z',
      dryRun: false,
    })
    assert.equal(completed.operation, 'completed')
    assert.deepEqual(
      readBrainCalibrationDataset(vault).entries
        .map(entry => entry.label)
        .sort(),
      ['supported', 'useful'],
    )
  })

  test('surfaces reference-only calibration work in brain_review until both core labels exist', async () => {
    await vault.init({ quiet: true })
    const initial = vault.brainReview({ includeLow: true, limit: 200 })
    const item = initial.items.find(candidate => candidate.category === 'calibration')
    assert.ok(item)
    assert.match(item.title, /R1/)
    assert.doesNotMatch(item.title, /[FC]1/)
    assert.equal(item.action.kind, 'none')
    assert.equal(item.action.tool, 'record_calibration_judgement')
    assert.match(String(item.action.args?.review_token), /^brt-[a-f0-9]{32}$/)
    assert.deepEqual(Object.keys(item.action.args ?? {}), ['review_token'])
    assert.deepEqual(item.targets, [])
    assert.equal(JSON.stringify(item).includes('calibration_snapshot_payloads'), false)
    assert.equal(JSON.stringify(item).includes('"factors"'), false)

    recordCalibrationJudgement(vault, {
      reviewToken: String(item.action.args?.review_token),
      useful: true,
      supported: true,
      reviewer: 'amo',
      recordedAt: '2026-07-23T10:00:00.000Z',
      dryRun: false,
    })
    const complete = vault.brainReview({ includeLow: true, limit: 200 })
    assert.equal(complete.items.some(candidate => candidate.id === item.id), false)
  })

  test('builds and round-trips a canonical snapshot from a real selected fact', async () => {
    const selection = selectSalientKnowledge({
      sessionId: 'session-real-fact',
      task: 'Verify that the web service recovered',
      bashEvidence: [{
        id: 'web-service-check',
        command: 'systemctl is-active linuxmuster-webui.service',
        result: 'active',
        exitCode: 0,
      }],
    })
    assert.equal(selection.facts.length, 1)
    const fact = selection.facts[0]
    const sourcePath = 'Technik/Linuxmuster/Recovery.md'
    const factSnapshot = calibrationSnapshotFromFact(fact, {
      generatedAt: '2026-07-20T09:00:00.000Z',
      selectionStatus: 'selected',
      productionRank: 1,
      evaluationSample: true,
      candidatePopulationCount: 1,
      samplingProbability: 1,
      sourcePath,
      sessionId: selection.sessionId,
      projectGroupId: calibrationProjectGroupId(sourcePath),
    })
    assert.deepEqual(factSnapshot.sourceTypes, ['bash_pair'])
    assert.equal(factSnapshot.independentUnitCount, 1)
    assert.equal(factSnapshot.evidenceScore, 88)
    const tokens = writeSnapshotSource(vaultPath, [factSnapshot])
    await vault.init({ quiet: true })
    recordCalibrationJudgement(vault, {
      reviewToken: tokens.get(factSnapshot.factId) ?? '',
      useful: true,
      supported: true,
      reviewer: 'amo',
      recordedAt: '2026-07-23T10:00:00.000Z',
      dryRun: false,
    })
    const stored = readBrainCalibrationDataset(vault).entries[0]?.snapshot
    assert.deepEqual(stored, factSnapshot)
  })

  test('writes atomically without fact text and emits a minimal action log', async () => {
    await vault.init({ quiet: true })
    const reviewToken = vault
      .brainCalibrationReviewBatch({ limit: 1 })
      .items[0]?.recordArgs.review_token
    assert.ok(reviewToken)
    const result = recordCalibrationJudgement(vault, {
      reviewToken,
      useful: true,
      supported: true,
      reviewer: 'amo',
      recordedAt: '2026-07-23T10:00:00.000Z',
      dryRun: false,
    })

    assert.equal(result.dryRun, false)
    const raw = readFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), 'utf-8')
    assert.equal(raw.includes('statement'), false)
    assert.equal(raw.includes('excerpt'), false)
    assert.equal(readdirSync(vaultPath).some(name => name.startsWith(`${BRAIN_CALIBRATION_PATH}.tmp-`)), false)

    const dataset = readBrainCalibrationDataset(vault)
    assert.equal(dataset.schemaVersion, BRAIN_CALIBRATION_SCHEMA_VERSION)
    assert.equal(dataset.entries.length, 2)
    assert.equal(dataset.entries[0]?.snapshot.salienceScore, 78)
    assert.equal(Object.hasOwn(dataset.entries[0]?.snapshot ?? {}, 'statement'), false)

    const log = readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8')
    assert.match(log, /"tool":"record_calibration_judgement"/)
    assert.equal(log.includes('"snapshot"'), false)
  })

  test('retains independent frozen judgement pairs from separate reviewers', async () => {
    await vault.init({ quiet: true })
    const reviewToken = vault
      .brainCalibrationReviewBatch({ limit: 1 })
      .items[0]?.recordArgs.review_token
    assert.ok(reviewToken)
    recordCalibrationJudgement(vault, {
      reviewToken,
      useful: true,
      supported: false,
      reviewer: 'amo',
      recordedAt: '2026-07-23T10:00:00.000Z',
      dryRun: false,
    })
    recordCalibrationJudgement(vault, {
      reviewToken,
      useful: false,
      supported: true,
      reviewer: 'second-reviewer',
      recordedAt: '2026-07-23T11:00:00.000Z',
      dryRun: false,
    })

    const dataset = readBrainCalibrationDataset(vault)
    assert.equal(dataset.entries.length, 4)
    const firstReview = dataset.entries.find(entry =>
      entry.label === 'supported' && entry.reviewer === 'amo')
    assert.equal(firstReview?.value, false)
    assert.equal(firstReview?.snapshot.evidenceScore, 58)
    assert.equal(firstReview?.recordedAt, '2026-07-23T10:00:00.000Z')

    const summary = brainCalibrationSummary(vault)
    assert.deepEqual(summary.byLabel.supported, {
      true: 1,
      false: 1,
      labeled: 2,
      jeffreysPosteriorMean: 0.5,
    })
    assert.deepEqual(summary.byLabel.useful, {
      true: 1,
      false: 1,
      labeled: 2,
      jeffreysPosteriorMean: 0.5,
    })
    assert.equal(summary.byLabel.still_valid.labeled, 0)
  })

  test('rejects every single-writer bypass for useful and supported', () => {
    assert.throws(
      () => recordCalibrationLabel(vault, labelOptions({
        label: 'supported',
        dryRun: false,
      })),
      /ausnahmslos atomar mit record_calibration_judgement/,
    )
    assert.throws(
      () => recordCalibrationLabel(vault, labelOptions({
        label: 'useful',
        dryRun: true,
      })),
      /ausnahmslos atomar mit record_calibration_judgement/,
    )
    assert.equal(existsSync(join(vaultPath, BRAIN_CALIBRATION_PATH)), false)
  })

  test('keeps the same semantic fact as separate observations across sessions', async () => {
    const first = snapshot()
    const firstTokens = writeSnapshotSource(vaultPath, [first])
    const secondPath = 'Kunden/Schule/Second Capture.md'
    const second = snapshot({
      sourcePath: secondPath,
      sessionId: 'session-2026-07-24',
      generatedAt: '2026-07-21T09:00:00.000Z',
      projectGroupId: calibrationProjectGroupId(secondPath),
    })
    const secondTokens = writeSnapshotSource(vaultPath, [second])
    await vault.init({ quiet: true })
    for (const reviewToken of [
      firstTokens.get(first.factId),
      secondTokens.get(second.factId),
    ]) {
      assert.ok(reviewToken)
      recordCalibrationJudgement(vault, {
        reviewToken,
        useful: true,
        supported: true,
        reviewer: 'amo',
        recordedAt: '2026-07-23T10:00:00.000Z',
        dryRun: false,
      })
    }

    const dataset = readBrainCalibrationDataset(vault)
    assert.equal(dataset.entries.length, 4)
    assert.equal(new Set(dataset.entries.map(entry => entry.snapshot.factId)).size, 1)
    assert.equal(new Set(dataset.entries.map(entry => entry.observationId)).size, 2)
    assert.equal(brainCalibrationSummary(vault).uniqueTargets, 2)
    assert.equal(brainCalibrationSummary(vault).uniqueFacts, 1)
  })

  test('keeps the original feature snapshot immutable in temporal corrections', () => {
    recordCalibrationLabel(vault, validityOptions({
      value: true,
      dryRun: false,
    }))
    assert.throws(
      () => recordCalibrationLabel(vault, validityOptions({
        value: false,
        clientId: 'OtherClient',
        recordedAt: '2026-07-23T11:00:00.000Z',
        dryRun: false,
      })),
      /ursprünglichen Snapshot nicht ersetzen/,
    )
    const dataset = readBrainCalibrationDataset(vault)
    assert.equal(dataset.entries[0]?.value, true)
    assert.equal(dataset.entries[0]?.snapshot.evidenceScore, 58)
  })

  test('requires observation time and a validity class for still-valid labels', () => {
    assert.throws(
      () => recordCalibrationLabel(vault, labelOptions({ label: 'still_valid' })),
      /observedAt ist für still_valid erforderlich/,
    )
    assert.throws(
      () => recordCalibrationLabel(vault, labelOptions({
        label: 'still_valid',
        recordedAt: undefined as unknown as string,
        observedAt: '2026-07-22T08:00:00.000Z',
        validityClass: 'operational_state',
      })),
      /recordedAt muss ein String sein/,
    )
    assert.doesNotThrow(() => recordCalibrationLabel(vault, labelOptions({
      label: 'still_valid',
      observedAt: '2026-07-22T08:00:00.000Z',
      validityClass: 'operational_state',
    })))
    assert.throws(
      () => recordCalibrationLabel(vault, labelOptions({
        label: 'still_valid',
        observedAt: '2026-07-24T08:00:00.000Z',
        validityClass: 'operational_state',
      })),
      /observedAt darf nicht nach recordedAt liegen/,
    )
    assert.throws(
      () => recordCalibrationLabel(vault, labelOptions({
        label: 'still_valid',
        observedAt: '2026-02-31T08:00:00.000Z',
        validityClass: 'operational_state',
      })),
      /gültiger kanonischer UTC-Zeitstempel/,
    )
    assert.throws(
      () => recordCalibrationLabel(vault, validityOptions({
        recordedAt: '2026-07-19T08:00:00.000Z',
        observedAt: '2026-07-19T07:00:00.000Z',
      })),
      /recordedAt darf nicht vor snapshot.generatedAt liegen/,
    )
  })

  test('keeps repeated validity rechecks as separate temporal observations', () => {
    recordCalibrationLabel(vault, labelOptions({
      label: 'still_valid',
      value: true,
      observedAt: '2026-07-22T08:00:00.000Z',
      validityClass: 'operational_state',
      recordedAt: '2026-07-23T10:00:00.000Z',
      dryRun: false,
    }))
    recordCalibrationLabel(vault, labelOptions({
      label: 'still_valid',
      value: false,
      observedAt: '2026-07-23T08:00:00.000Z',
      validityClass: 'operational_state',
      recordedAt: '2026-07-24T10:00:00.000Z',
      dryRun: false,
    }))

    const entries = readBrainCalibrationDataset(vault).entries
    assert.equal(entries.length, 2)
    assert.equal(new Set(entries.map(entry => entry.baseObservationId)).size, 1)
    assert.equal(new Set(entries.map(entry => entry.observationId)).size, 2)
    assert.ok(entries.every(entry => entry.observationId !== entry.baseObservationId))
    const summary = brainCalibrationSummary(vault)
    assert.equal(summary.uniqueTargets, 1)
    assert.equal(summary.uniqueObservations, 2)
    assert.deepEqual(brainCalibrationSummary(vault).byLabel.still_valid, {
      true: 1,
      false: 1,
      labeled: 2,
      jeffreysPosteriorMean: 0.5,
    })
  })

  test('rejects a stale correction of the same temporal validity event', () => {
    const initial = recordCalibrationLabel(vault, labelOptions({
      label: 'still_valid',
      value: true,
      observedAt: '2026-07-22T08:00:00.000Z',
      validityClass: 'operational_state',
      recordedAt: '2026-07-23T10:00:00.000Z',
      dryRun: false,
    }))
    const updated = recordCalibrationLabel(vault, labelOptions({
      label: 'still_valid',
      value: false,
      observedAt: '2026-07-22T08:00:00.000Z',
      validityClass: 'operational_state',
      recordedAt: '2026-07-24T10:00:00.000Z',
      dryRun: false,
    }))
    assert.equal(updated.operation, 'updated')
    assert.equal(updated.entry.observationId, initial.entry.observationId)
    assert.equal(updated.entry.baseObservationId, initial.entry.baseObservationId)

    assert.throws(
      () => recordCalibrationLabel(vault, labelOptions({
        label: 'still_valid',
        value: true,
        observedAt: '2026-07-22T08:00:00.000Z',
        validityClass: 'operational_state',
        recordedAt: '2026-07-23T11:00:00.000Z',
        dryRun: false,
      })),
      /älteres recordedAt.*nicht zurückrollen/,
    )

    const entry = readBrainCalibrationDataset(vault).entries[0]
    assert.equal(entry?.value, false)
    assert.equal(entry?.recordedAt, '2026-07-24T10:00:00.000Z')
  })

  test('normalizes legacy still-valid rows to a temporal id and retains their stable base id', () => {
    const temporalSnapshot = snapshot({
      observedAt: '2026-07-22T08:00:00.000Z',
      validityClass: 'operational_state',
    })
    const baseObservationId = calibrationObservationId(
      temporalSnapshot.sessionId ?? '',
      temporalSnapshot.factId,
      calibrationSnapshotFingerprint(temporalSnapshot),
    )
    writeFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), JSON.stringify({
      schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
      entries: [{
        observationId: baseObservationId,
        label: 'still_valid',
        value: true,
        snapshot: temporalSnapshot,
        reviewer: 'amo',
        recordedAt: '2026-07-23T10:00:00.000Z',
      }],
    }), 'utf-8')

    const dataset = readBrainCalibrationDataset(vault)
    assert.equal(dataset.entries[0]?.baseObservationId, baseObservationId)
    assert.notEqual(dataset.entries[0]?.observationId, baseObservationId)
    const summary = brainCalibrationSummary(vault)
    assert.equal(summary.uniqueTargets, 1)
    assert.equal(summary.uniqueObservations, 1)
  })

  test('fails closed for malformed, unknown-version, duplicate, and data-leaking JSON', () => {
    const path = join(vaultPath, BRAIN_CALIBRATION_PATH)
    writeFileSync(path, '{ invalid json', 'utf-8')
    assert.throws(() => readBrainCalibrationDataset(vault), /Kalibrierungsdataset ist beschädigt/)

    writeFileSync(path, JSON.stringify({ schemaVersion: 1, entries: [] }), 'utf-8')
    assert.throws(() => readBrainCalibrationDataset(vault), /schemaVersion muss 2 sein/)

    const cleanSnapshot = snapshot()
    const observationId = calibrationObservationId(
      cleanSnapshot.sessionId ?? '',
      cleanSnapshot.factId,
      calibrationSnapshotFingerprint(cleanSnapshot),
    )
    const entry = {
      observationId,
      label: 'supported',
      value: true,
      snapshot: {
        ...cleanSnapshot,
        statement: 'Dieser sensible Fakt darf nicht gespeichert werden.',
      },
      reviewer: 'amo',
      recordedAt: '2026-07-23T10:00:00.000Z',
    }
    writeFileSync(path, JSON.stringify({
      schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
      entries: [entry],
    }), 'utf-8')
    assert.throws(() => readBrainCalibrationDataset(vault), /snapshot\.statement ist im Schema nicht erlaubt/)

    const cleanEntry = {
      observationId,
      label: entry.label,
      value: entry.value,
      snapshot: cleanSnapshot,
      reviewer: entry.reviewer,
      recordedAt: entry.recordedAt,
    }
    writeFileSync(path, JSON.stringify({
      schemaVersion: BRAIN_CALIBRATION_SCHEMA_VERSION,
      entries: [cleanEntry, cleanEntry],
    }), 'utf-8')
    assert.throws(() => readBrainCalibrationDataset(vault), /Doppeltes Label/)
  })

  test('validates scores, complete factors, provenance, IDs, and vault-relative paths', () => {
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({ salienceScore: 101 })),
      /salienceScore/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({ salienceScore: 78.5 })),
      /salienceScore muss eine Ganzzahl sein/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({ salienceScore: 77 })),
      /salienceScore ist .* nicht reproduzierbar/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({ evidenceScore: 57 })),
      /evidenceScore ist .* nicht reproduzierbar/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({
        evidenceModelVersion: 'evidence-scoring-v0',
      })),
      /evidenceModelVersion wird nicht unterstützt/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({
        modelVersion: 'knowledge-salience-v0',
      })),
      /modelVersion wird nicht unterstützt/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({
        factors: undefined as unknown as BrainCalibrationTargetSnapshot['factors'],
      })),
      /snapshot\.factors muss ein Objekt sein/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({
        factors: {
          taskRelevance: 0.9,
          decisionOutcomeUtility: 0.8,
          noveltyInformativeness: 0.6,
          reusability: 0.7,
        } as BrainCalibrationTargetSnapshot['factors'],
      })),
      /specificity fehlt/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({ sourceTypes: ['phase', 'phase'] })),
      /keine Duplikate/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({
        sourceTypes: [],
        independentUnitCount: 1,
      })),
      /bei leeren sourceTypes 0/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({
        sourceTypes: ['phase'],
        independentUnitCount: 0,
      })),
      /mindestens 1/,
    )
    assert.throws(
      () => calibrationSnapshotFingerprint(snapshot({
        sourceTypes: ['phase', 'error_fix'],
        independentUnitCount: 1,
      })),
      /nicht kleiner als die Zahl der sourceTypes/,
    )
    assert.throws(
      () => recordCalibrationLabel(vault, validityOptions({ sourcePath: '../outside.md' })),
      /Unsicherer Vault-Pfad/,
    )
    assert.throws(
      () => recordCalibrationLabel(vault, validityOptions({ factId: 'not-a-canonical-fact' })),
      /kanonische ks-Fakt-ID/,
    )
    assert.throws(
      () => recordCalibrationLabel(vault, validityOptions({ reviewer: 'amo reviewer prose' })),
      /opake ID/,
    )
    const emptySnapshot = snapshot({
      sourceTypes: [],
      independentUnitCount: 0,
      evidenceScore: 0,
    })
    assert.doesNotThrow(() => calibrationSnapshotFingerprint(emptySnapshot))
  })

  test('loads model features only from the registered harvester snapshot', () => {
    const source = snapshot()
    const sourceFile = join(vaultPath, source.sourcePath ?? '')
    const raw = readFileSync(sourceFile, 'utf-8')
    writeFileSync(
      sourceFile,
      raw.replace(calibrationSnapshotFingerprint(source), '0'.repeat(64)),
      'utf-8',
    )
    assert.throws(
      () => recordCalibrationLabel(vault, validityOptions()),
      /Attestation|Snapshot-Fingerprint/,
    )
    writeSnapshotSource(vaultPath, [source])
    assert.throws(
      () => recordCalibrationLabel(vault, validityOptions({
        factId: 'ks-aaaaaaaaaaaaaaaaaaaa',
      })),
      /keinen attestierten Snapshot/,
    )
  })

  test('serializes writers with a vault-local lock while previews remain available', () => {
    writeFileSync(join(vaultPath, BRAIN_CALIBRATION_LOCK_PATH), 'busy\n', 'utf-8')
    assert.doesNotThrow(() => recordCalibrationLabel(vault, validityOptions({ dryRun: true })))
    assert.throws(
      () => recordCalibrationLabel(vault, validityOptions({ dryRun: false })),
      /Kalibrierungsdataset ist gesperrt/,
    )
    assert.equal(existsSync(join(vaultPath, BRAIN_CALIBRATION_PATH)), false)
  })

  test('policy blocks apply but never blocks a preview', () => {
    const policy = structuredClone(basePolicy)
    policy.tools.record_calibration_label = {
      write: false,
      risk: 'low',
      requiresDryRunDefault: true,
    }
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8')

    assert.doesNotThrow(() => recordCalibrationLabel(vault, validityOptions({ dryRun: true })))
    assert.throws(
      () => recordCalibrationLabel(vault, validityOptions({ dryRun: false })),
      /record_calibration_label ist laut Policy read-only/,
    )
    assert.equal(existsSync(join(vaultPath, BRAIN_CALIBRATION_PATH)), false)
    assert.equal(existsSync(join(vaultPath, '.action-log.jsonl')), false)
  })
})
