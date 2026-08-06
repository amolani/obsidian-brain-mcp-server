import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  BRAIN_CALIBRATION_PATH,
  calibrationSnapshotFingerprint,
  serializeCalibrationSnapshotCore,
  type BrainCalibrationTargetSnapshot,
} from '../services/brain-calibration.ts'
import {
  BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV,
  BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH,
  BRAIN_CALIBRATION_CAMPAIGN_LOCK_PATH,
  BRAIN_CALIBRATION_CAMPAIGN_LOCK_STALE_AFTER_MS,
  BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH,
  BRAIN_CALIBRATION_CAMPAIGN_RESULT_PATH,
  BRAIN_CALIBRATION_VAULT_ID_ENV,
  acquireBrainCalibrationCampaignLock,
  assertBrainCalibrationCampaignCaptureWriteAccess,
  brainCalibrationCampaignHash,
  closeBrainCalibrationCampaign,
  evaluateSealedBrainCalibrationCampaign,
  getBrainCalibrationCampaignPhase,
  readBrainCalibrationCampaignRegistration,
  registerBrainCalibrationCampaign,
  releaseBrainCalibrationCampaignLock,
  resolveBrainCalibrationCampaignReviewTarget,
  type BrainCalibrationCampaignClosure,
  type BrainCalibrationCampaignRegistration,
} from '../services/brain-calibration-campaign.ts'
import { computeBrainCalibrationDataFingerprint } from '../services/brain-calibration-evaluation.ts'
import {
  CALIBRATION_CAPTURE_PRODUCER,
  CALIBRATION_CAPTURE_SCHEMA,
  calibrationCaptureIntegrity,
  serializeCalibrationReviewPayload,
  type CalibrationCaptureBundleInput,
} from '../services/calibration-capture.ts'
import { scoreKnowledgeSalienceFactors } from '../services/knowledge-salience.ts'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault } from './helpers.ts'

interface CampaignFixture {
  vault: Vault
  registration: BrainCalibrationCampaignRegistration
}

const FACTORS = {
  taskRelevance: 0.8,
  decisionOutcomeUtility: 0.7,
  noveltyInformativeness: 0.6,
  reusability: 0.7,
  specificity: 0.8,
}

const CAMPAIGN_OPTIONS = {
  campaignId: 'campaign-fixture-v1',
  reviewers: ['alice', 'bob'],
  groupBy: 'session' as const,
  bootstrapSamples: 100,
}

function factId(sessionId: string): string {
  return `ks-${createHash('sha256')
    .update(`campaign-test\0${sessionId}`)
    .digest('hex')
    .slice(0, 20)}`
}

function yamlArray(values: readonly string[]): string {
  return values.map(value => `  - ${JSON.stringify(value)}`).join('\n')
}

/**
 * Writes the smallest complete V3 sampling frame: one safe candidate which is
 * both selected and part of the deterministic evaluation sample.
 */
function writeV3Capture(
  vaultPath: string,
  options: {
    path: string
    sessionId: string
    generatedAt: string
    seedCharacter: string
  },
): void {
  const id = factId(options.sessionId)
  const sampleSeed = `cs-${options.seedCharacter.repeat(32)}`
  const snapshot: BrainCalibrationTargetSnapshot = {
    modelVersion: 'knowledge-salience-v1',
    evidenceModelVersion: 'evidence-scoring-v1',
    factId: id,
    kind: 'decision',
    salienceScore: scoreKnowledgeSalienceFactors(FACTORS),
    evidenceScore: 50,
    factors: FACTORS,
    sourceTypes: ['phase'],
    independentUnitCount: 1,
    evidenceConflict: false,
    generatedAt: options.generatedAt,
    selectionStatus: 'selected',
    productionRank: 1,
    evaluationSample: true,
    candidatePopulationCount: 1,
    samplingProbability: 1,
  }
  const snapshotPayload = serializeCalibrationSnapshotCore(snapshot)
  const snapshotFingerprint = calibrationSnapshotFingerprint(snapshot)
  const reviewPayload = serializeCalibrationReviewPayload({
    reviewId: 'R1',
    statement: `Verblindete Kampagnenaussage ${id.slice(-8)}`,
    evidence: [{
      ref: `phase:campaign-${id.slice(-8)}`,
      hash: createHash('sha256').update(`campaign-evidence\0${id}`).digest('hex'),
      excerpt: `Attestierter Kampagnenbeleg ${id.slice(-8)}`,
    }],
  })
  const bundle: CalibrationCaptureBundleInput = {
    sessionId: options.sessionId,
    modelVersion: 'knowledge-salience-v1',
    sampleSeed,
    candidateUniverseFactIds: [id],
    selectedFactIds: [id],
    factMap: [`F1:${id}`],
    snapshotFingerprints: [`${id}:${snapshotFingerprint}`],
    snapshotPayloads: [snapshotPayload],
    reviewMap: [`R1:${id}`],
    reviewPayloads: [reviewPayload],
  }
  const integrity = calibrationCaptureIntegrity(bundle)
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
    yamlArray(bundle.candidateUniverseFactIds),
    'knowledge_fact_ids:',
    yamlArray(bundle.selectedFactIds),
    'calibration_fact_map:',
    yamlArray(bundle.factMap),
    'calibration_snapshot_fingerprints:',
    yamlArray(bundle.snapshotFingerprints),
    'calibration_snapshot_payloads:',
    yamlArray(bundle.snapshotPayloads),
    'calibration_review_map:',
    yamlArray(bundle.reviewMap),
    'calibration_review_payloads:',
    yamlArray(bundle.reviewPayloads),
    '---',
    '',
    '# Versiegelte Kampagnen-Fixture',
    '',
  ].join('\n'), 'utf8')
}

function writeInitialFrame(vaultPath: string): void {
  writeV3Capture(vaultPath, {
    path: 'Kunden/Alpha/Capture A.md',
    sessionId: 'campaign-session-a',
    generatedAt: '2026-07-20T08:00:00.000Z',
    seedCharacter: '1',
  })
  writeV3Capture(vaultPath, {
    path: 'Kunden/Beta/Capture B.md',
    sessionId: 'campaign-session-b',
    generatedAt: '2026-07-21T08:00:00.000Z',
    seedCharacter: '2',
  })
}

function nextReviewTimestamp(registration: BrainCalibrationCampaignRegistration): string {
  return new Date(Math.max(
    Date.now(),
    Date.parse(registration.registeredAt),
  )).toISOString()
}

async function terminatedProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  })
  const pid = child.pid
  assert.equal(typeof pid, 'number')
  await once(child, 'exit')
  return pid as number
}

function staleLockTimestamp(): Date {
  return new Date(
    Date.now() - BRAIN_CALIBRATION_CAMPAIGN_LOCK_STALE_AFTER_MS - 60_000,
  )
}

function writeLockFixture(
  vaultPath: string,
  metadata: unknown,
  modifiedAt = new Date(),
): string {
  const path = join(vaultPath, BRAIN_CALIBRATION_CAMPAIGN_LOCK_PATH)
  writeFileSync(path, `${JSON.stringify(metadata)}\n`, 'utf8')
  utimesSync(path, modifiedAt, modifiedAt)
  return path
}

function recordReviewerMatrix(
  fixture: CampaignFixture,
  reviewers = CAMPAIGN_OPTIONS.reviewers,
): string {
  const recordedAt = nextReviewTimestamp(fixture.registration)
  for (const [targetIndex, target] of fixture.registration.reviewArchive.entries()) {
    for (const [reviewerIndex, reviewer] of reviewers.entries()) {
      fixture.vault.recordCalibrationJudgement({
        reviewToken: target.reviewToken,
        useful: (targetIndex + reviewerIndex) % 2 === 0,
        supported: (targetIndex + reviewerIndex) % 3 !== 0,
        reviewer,
        recordedAt,
        dryRun: false,
      })
    }
  }
  return recordedAt
}

describe('irreversible brain calibration campaign', () => {
  let vaultPath: string
  let anchorPath: string
  let vault: Vault | null
  let previousAnchorDirectory: string | undefined
  let previousVaultId: string | undefined

  beforeEach(() => {
    vaultPath = createTempVault()
    anchorPath = mkdtempSync(join(tmpdir(), 'obsidian-campaign-anchor-'))
    vault = null
    previousAnchorDirectory =
      process.env[BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV]
    previousVaultId = process.env[BRAIN_CALIBRATION_VAULT_ID_ENV]
    process.env[BRAIN_CALIBRATION_ANCHOR_DIRECTORY_ENV] = anchorPath
    process.env[BRAIN_CALIBRATION_VAULT_ID_ENV] =
      `campaign-test-vault-${createHash('sha256')
        .update(vaultPath)
        .digest('hex')
        .slice(0, 16)}`
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

  async function initializeFrame(): Promise<Vault> {
    writeInitialFrame(vaultPath)
    vault = new Vault(vaultPath)
    await vault.init({ quiet: true })
    return vault
  }

  async function registerFixture(): Promise<CampaignFixture> {
    const targetVault = await initializeFrame()
    const preview = registerBrainCalibrationCampaign(targetVault, {
      ...CAMPAIGN_OPTIONS,
      dryRun: true,
    })
    const result = registerBrainCalibrationCampaign(targetVault, {
      ...CAMPAIGN_OPTIONS,
      expectedRegistrationRoot: preview.artifact.registrationRoot,
      expectedRegisteredAt: preview.artifact.registeredAt,
      dryRun: false,
    })
    assert.equal(result.operation, 'created')
    assert.equal(result.externalAnchor, 'written')
    return { vault: targetVault, registration: result.artifact }
  }

  test('registration is dry-run-first, create-only and idempotently anchored', async () => {
    const targetVault = await initializeFrame()

    const preview = registerBrainCalibrationCampaign(targetVault, {
      ...CAMPAIGN_OPTIONS,
      dryRun: true,
    })
    assert.equal(preview.dryRun, true)
    assert.equal(preview.operation, 'created')
    assert.equal(preview.externalAnchor, 'pending')
    assert.equal(preview.artifact.frame.targets.length, 2)
    assert.equal(preview.artifact.captureArchives.length, 2)
    assert.equal(preview.artifact.reviewArchive.length, 2)
    assert.notEqual(preview.artifact.plan.cutoffAt, null)
    assert.ok(preview.artifact.plan.sourceBindings.some(binding =>
      binding.path === 'hooks/knowledge-harvester.ts'))
    assert.ok(preview.artifact.plan.sourceBindings.some(binding =>
      binding.path === 'server.ts'))
    assert.ok(preview.artifact.plan.sourceBindings.some(binding =>
      binding.path === 'tool-handlers.ts'))
    assert.ok(preview.artifact.plan.sourceBindings.some(binding =>
      binding.path === 'services/secret-redaction.ts'))
    assert.match(preview.artifact.plan.runtime.execPathSha256, /^[a-f0-9]{64}$/)
    assert.match(preview.artifact.plan.runtime.execArgvSha256, /^[a-f0-9]{64}$/)
    assert.equal(
      preview.artifact.plan.assuranceProfile.reviewerIdentity,
      'process-bound-pseudonym-without-cryptographic-signature-v1',
    )
    assert.equal(
      preview.artifact.plan.splitPlan.targets.length,
      preview.artifact.frame.targets.length,
    )
    assert.equal(
      preview.artifact.plan.splitPlan.cutoffAt,
      preview.artifact.plan.cutoffAt,
    )
    assert.equal(
      existsSync(join(vaultPath, BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH)),
      false,
    )
    assert.deepEqual(readdirSync(anchorPath), [])

    const created = registerBrainCalibrationCampaign(targetVault, {
      ...CAMPAIGN_OPTIONS,
      expectedRegistrationRoot: preview.artifact.registrationRoot,
      expectedRegisteredAt: preview.artifact.registeredAt,
      dryRun: false,
    })
    assert.equal(created.dryRun, false)
    assert.equal(created.operation, 'created')
    assert.equal(created.externalAnchor, 'written')
    assert.equal(getBrainCalibrationCampaignPhase(targetVault), 'registered')
    assert.equal(
      existsSync(join(vaultPath, BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH)),
      true,
    )
    assert.equal(readdirSync(anchorPath).length, 1)

    const replay = registerBrainCalibrationCampaign(targetVault, {
      ...CAMPAIGN_OPTIONS,
      expectedRegistrationRoot: created.artifact.registrationRoot,
      expectedRegisteredAt: created.artifact.registeredAt,
      dryRun: false,
    })
    assert.equal(replay.operation, 'unchanged')
    assert.equal(replay.externalAnchor, 'verified')
    assert.deepEqual(replay.artifact, created.artifact)
    assert.equal(readdirSync(anchorPath).length, 1)
  })

  test('binds registration apply to the exact reviewed dry-run artifact', async () => {
    const targetVault = await initializeFrame()
    const preview = registerBrainCalibrationCampaign(targetVault, {
      ...CAMPAIGN_OPTIONS,
      dryRun: true,
    })

    assert.throws(
      () => registerBrainCalibrationCampaign(targetVault, {
        ...CAMPAIGN_OPTIONS,
        dryRun: false,
      }),
      /expectedRegisteredAt/,
    )

    writeV3Capture(vaultPath, {
      path: 'Kunden/Gamma/Capture C.md',
      sessionId: 'campaign-session-c',
      generatedAt: '2026-07-22T08:00:00.000Z',
      seedCharacter: '3',
    })
    assert.throws(
      () => registerBrainCalibrationCampaign(targetVault, {
        ...CAMPAIGN_OPTIONS,
        expectedRegistrationRoot: preview.artifact.registrationRoot,
        expectedRegisteredAt: preview.artifact.registeredAt,
        dryRun: false,
      }),
      /Registrierungs-Vorschau ist gedriftet/,
    )
    assert.equal(
      existsSync(join(vaultPath, BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH)),
      false,
    )
    assert.deepEqual(readdirSync(anchorPath), [])
  })

  test('requires explicit confirmation at the service boundary', async () => {
    const targetVault = await initializeFrame()
    assert.throws(
      () => evaluateSealedBrainCalibrationCampaign(
        targetVault,
        undefined as never,
      ),
      /confirm.*true/,
    )
  })

  test('keeps the general brain review usable without entering the campaign archive', async () => {
    const fixture = await registerFixture()
    const review = fixture.vault.brainReview({ includeLow: true })
    assert.equal(
      review.items.some(item =>
        item.category === 'calibration'
        || item.category === 'calibration_integrity'),
      false,
    )
  })

  test('serializes exploratory reads and preserves a replaced lock', async () => {
    const targetVault = await initializeFrame()
    const lock = acquireBrainCalibrationCampaignLock(targetVault)
    try {
      assert.throws(
        () => targetVault.brainCalibrationSummary(),
        /kampagne ist gesperrt/i,
      )
      assert.throws(
        () => targetVault.evaluateBrainCalibration({ bootstrapSamples: 100 }),
        /kampagne ist gesperrt/i,
      )
      assert.throws(
        () => targetVault.brainCalibrationReviewBatch({ reviewer: 'alice' }),
        /kampagne ist gesperrt/i,
      )

      unlinkSync(lock.path)
      writeFileSync(lock.path, 'replacement-lock\n', 'utf8')
      assert.throws(
        () => releaseBrainCalibrationCampaignLock(lock),
        /Lock wurde.*ersetzt/,
      )
      assert.equal(readFileSync(lock.path, 'utf8'), 'replacement-lock\n')
    } finally {
      if (existsSync(lock.path)) unlinkSync(lock.path)
    }
  })

  test('never reclaims an old lock whose owner process is alive', async () => {
    const targetVault = await initializeFrame()
    const old = staleLockTimestamp()
    const path = writeLockFixture(vaultPath, {
      acquiredAt: old.toISOString(),
      hostname: hostname(),
      pid: process.pid,
    }, old)

    assert.throws(
      () => acquireBrainCalibrationCampaignLock(targetVault),
      /kampagne ist gesperrt/i,
    )
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid)
  })

  test('keeps a recent lock even after its owner process exited', async () => {
    const targetVault = await initializeFrame()
    const deadPid = await terminatedProcessPid()
    const path = writeLockFixture(vaultPath, {
      acquiredAt: new Date().toISOString(),
      hostname: hostname(),
      pid: deadPid,
    })

    assert.throws(
      () => acquireBrainCalibrationCampaignLock(targetVault),
      /kampagne ist gesperrt/i,
    )
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, deadPid)
  })

  test('reclaims an old local lock after its owner process exited', async () => {
    const targetVault = await initializeFrame()
    const deadPid = await terminatedProcessPid()
    const old = staleLockTimestamp()
    const path = writeLockFixture(vaultPath, {
      acquiredAt: old.toISOString(),
      hostname: hostname(),
      pid: deadPid,
    }, old)

    const lock = acquireBrainCalibrationCampaignLock(targetVault)
    try {
      const replacement = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(replacement.pid, process.pid)
      assert.equal(typeof replacement.hostname, 'string')
      assert.notEqual(replacement.hostname.trim(), '')
    } finally {
      releaseBrainCalibrationCampaignLock(lock)
    }
    assert.equal(existsSync(path), false)
    assert.equal(existsSync(`${path}.reclaim`), false)
  })

  test('does not race another stale-lock reclaimer', async () => {
    const targetVault = await initializeFrame()
    const deadPid = await terminatedProcessPid()
    const old = staleLockTimestamp()
    const path = writeLockFixture(vaultPath, {
      acquiredAt: old.toISOString(),
      hostname: hostname(),
      pid: deadPid,
    }, old)
    writeFileSync(`${path}.reclaim`, 'another-reclaimer\n', 'utf8')

    assert.throws(
      () => acquireBrainCalibrationCampaignLock(targetVault),
      /kampagne ist gesperrt/i,
    )
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, deadPid)
    assert.equal(
      readFileSync(`${path}.reclaim`, 'utf8'),
      'another-reclaimer\n',
    )
  })

  test('does not reclaim old foreign-host, legacy, or malformed locks', async () => {
    const targetVault = await initializeFrame()
    const deadPid = await terminatedProcessPid()
    const old = staleLockTimestamp()
    const path = writeLockFixture(vaultPath, {
      acquiredAt: old.toISOString(),
      hostname: 'foreign-host.invalid',
      pid: deadPid,
    }, old)

    assert.throws(
      () => acquireBrainCalibrationCampaignLock(targetVault),
      /kampagne ist gesperrt/i,
    )
    unlinkSync(path)
    writeLockFixture(vaultPath, {
      acquiredAt: old.toISOString(),
      pid: deadPid,
    }, old)
    assert.throws(
      () => acquireBrainCalibrationCampaignLock(targetVault),
      /kampagne ist gesperrt/i,
    )
    unlinkSync(path)
    writeFileSync(path, 'damaged-lock\n', 'utf8')
    utimesSync(path, old, old)
    assert.throws(
      () => acquireBrainCalibrationCampaignLock(targetVault),
      /kampagne ist gesperrt/i,
    )
    assert.equal(readFileSync(path, 'utf8'), 'damaged-lock\n')
  })

  test('enforces the registered reviewer roster and requires the complete matrix', async () => {
    const fixture = await registerFixture()
    const first = fixture.registration.reviewArchive[0]
    assert.ok(first)

    assert.throws(
      () => resolveBrainCalibrationCampaignReviewTarget(fixture.vault, {
        reviewToken: first.reviewToken,
        reviewer: 'mallory',
      }),
      /nicht registriert/,
    )

    recordReviewerMatrix(fixture, ['alice'])
    assert.equal(
      JSON.parse(
        readFileSync(join(vaultPath, BRAIN_CALIBRATION_PATH), 'utf8'),
      ).entries.length,
      fixture.registration.frame.targets.length * 2,
    )
    assert.throws(
      () => closeBrainCalibrationCampaign(fixture.vault, { dryRun: true }),
      /exakt .* primäre Einträge|unvollständig/,
    )
    assert.equal(getBrainCalibrationCampaignPhase(fixture.vault), 'registered')
    assert.equal(
      existsSync(join(vaultPath, BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH)),
      false,
    )
  })

  test('closes a complete reviewer matrix and replays the sealed result exactly', async () => {
    const fixture = await registerFixture()
    assert.throws(
      () => fixture.vault.brainCalibrationSummary(),
      /Explorative Auswertung/,
    )
    assert.throws(
      () => fixture.vault.evaluateBrainCalibration(),
      /Explorative Auswertung/,
    )
    assert.throws(
      () => assertBrainCalibrationCampaignCaptureWriteAccess(fixture.vault),
      /Captures.*eingefroren/,
    )
    assert.throws(
      () => fixture.vault.recordCalibrationLabel({
        reviewToken: fixture.registration.reviewArchive[0].reviewToken,
        label: 'still_valid',
        value: true,
        reviewer: 'alice',
        recordedAt: nextReviewTimestamp(fixture.registration),
        observedAt: fixture.registration.frame.targets[0].generatedAt,
        validityClass: 'durable_state',
        dryRun: true,
      }),
      /still_valid-Labels.*eingefroren/,
    )
    const recordedAt = recordReviewerMatrix(fixture)

    const closurePreview = closeBrainCalibrationCampaign(
      fixture.vault,
      { dryRun: true },
    )
    assert.equal(closurePreview.dryRun, true)
    assert.equal(closurePreview.operation, 'created')
    assert.equal(closurePreview.externalAnchor, 'pending')
    assert.equal(
      closurePreview.artifact.entries.length,
      fixture.registration.frame.targets.length
        * CAMPAIGN_OPTIONS.reviewers.length
        * 2,
    )
    assert.equal(
      existsSync(join(vaultPath, BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH)),
      false,
    )

    const closure = closeBrainCalibrationCampaign(
      fixture.vault,
      { dryRun: false },
    )
    assert.equal(closure.operation, 'created')
    assert.equal(closure.externalAnchor, 'written')
    assert.equal(getBrainCalibrationCampaignPhase(fixture.vault), 'closed')

    const closureReplay = closeBrainCalibrationCampaign(
      fixture.vault,
      { dryRun: false },
    )
    assert.equal(closureReplay.operation, 'unchanged')
    assert.equal(closureReplay.externalAnchor, 'verified')
    assert.deepEqual(closureReplay.artifact, closure.artifact)

    const exactJudgementRetry = fixture.vault.recordCalibrationJudgement({
      reviewToken: fixture.registration.reviewArchive[0].reviewToken,
      useful: true,
      supported: false,
      reviewer: 'alice',
      recordedAt,
      dryRun: false,
    })
    assert.equal(exactJudgementRetry.operation, 'unchanged')
    assert.throws(
      () => fixture.vault.recordCalibrationJudgement({
        reviewToken: fixture.registration.reviewArchive[0].reviewToken,
        useful: false,
        supported: false,
        reviewer: 'alice',
        recordedAt,
        dryRun: false,
      }),
      /unveränderlich/,
    )

    const evaluated = evaluateSealedBrainCalibrationCampaign(
      fixture.vault,
      { confirm: true },
    )
    assert.equal(evaluated.operation, 'created')
    assert.equal(evaluated.externalAnchor, 'written')
    assert.equal(getBrainCalibrationCampaignPhase(fixture.vault), 'evaluated')
    assert.equal(evaluated.artifact.evaluation.releaseDecisionAllowed, false)
    assert.equal(evaluated.artifact.evaluation.activeWeightsChanged, false)
    assert.equal(
      evaluated.artifact.evaluation.dataFingerprint,
      closure.artifact.dataFingerprint,
    )
    assert.equal(
      existsSync(join(vaultPath, BRAIN_CALIBRATION_CAMPAIGN_RESULT_PATH)),
      true,
    )

    const replay = evaluateSealedBrainCalibrationCampaign(
      fixture.vault,
      { confirm: true },
    )
    assert.equal(replay.operation, 'unchanged')
    assert.equal(replay.externalAnchor, 'verified')
    assert.deepEqual(replay.artifact, evaluated.artifact)
    assert.equal(replay.artifact.resultRoot, evaluated.artifact.resultRoot)
    assert.equal(replay.artifact.evaluatedAt, evaluated.artifact.evaluatedAt)
    assert.equal(
      replay.artifact.evaluation.generatedAt,
      evaluated.artifact.evaluation.generatedAt,
    )
    assert.equal(readdirSync(anchorPath).length, 3)
    assert.doesNotThrow(() => fixture.vault.brainCalibrationSummary())
    assert.doesNotThrow(() => fixture.vault.evaluateBrainCalibration({
      bootstrapSamples: 100,
    }))
    assert.doesNotThrow(
      () => assertBrainCalibrationCampaignCaptureWriteAccess(fixture.vault),
    )
  })

  test('blocks closure when the live capture frame drifts after registration', async () => {
    const fixture = await registerFixture()
    writeV3Capture(vaultPath, {
      path: 'Kunden/Gamma/Capture C.md',
      sessionId: 'campaign-session-c',
      generatedAt: '2026-07-22T08:00:00.000Z',
      seedCharacter: '3',
    })

    assert.throws(
      () => closeBrainCalibrationCampaign(fixture.vault, { dryRun: true }),
      /Capture-Frame.*gedriftet/,
    )
    assert.equal(getBrainCalibrationCampaignPhase(fixture.vault), 'registered')
    assert.equal(
      existsSync(join(vaultPath, BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH)),
      false,
    )
  })

  test('rejects reviewer timestamps after the attempted closure time', async () => {
    const fixture = await registerFixture()
    for (const target of fixture.registration.reviewArchive) {
      for (const reviewer of CAMPAIGN_OPTIONS.reviewers) {
        fixture.vault.recordCalibrationJudgement({
          reviewToken: target.reviewToken,
          useful: true,
          supported: true,
          reviewer,
          recordedAt: '2999-01-01T00:00:00.000Z',
          dryRun: false,
        })
      }
    }
    assert.throws(
      () => closeBrainCalibrationCampaign(fixture.vault, { dryRun: false }),
      /zwischen Registrierung\/Capture und Closure/,
    )
    assert.equal(
      existsSync(join(vaultPath, BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH)),
      false,
    )
  })

  test('never anchors an unanchored local closure even when forged live labels agree', async () => {
    const fixture = await registerFixture()
    recordReviewerMatrix(fixture)
    closeBrainCalibrationCampaign(fixture.vault, { dryRun: false })

    const closureReceipt = readdirSync(anchorPath).find(name =>
      name.endsWith('.closure.json'))
    assert.ok(closureReceipt)
    unlinkSync(join(anchorPath, closureReceipt))

    const closurePath = join(
      vaultPath,
      BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH,
    )
    const closure = JSON.parse(
      readFileSync(closurePath, 'utf8'),
    ) as BrainCalibrationCampaignClosure
    assert.ok(closure.entries[0])
    closure.entries[0].value = !closure.entries[0].value

    const datasetPath = join(vaultPath, BRAIN_CALIBRATION_PATH)
    const dataset = JSON.parse(
      readFileSync(datasetPath, 'utf8'),
    ) as {
      schemaVersion: number
      entries: Array<{
        observationId: string
        reviewer?: string
        label: string
        value: boolean
      }>
    }
    const forgedEntry = closure.entries[0]
    const liveEntry = dataset.entries.find(entry =>
      entry.observationId === forgedEntry.observationId
      && entry.reviewer === forgedEntry.reviewer
      && entry.label === forgedEntry.label)
    assert.ok(liveEntry)
    liveEntry.value = forgedEntry.value
    writeFileSync(datasetPath, `${JSON.stringify(dataset)}\n`, 'utf8')

    closure.dataFingerprint = computeBrainCalibrationDataFingerprint(
      closure.entries,
      fixture.registration.frame,
    )
    const { closureRoot: _oldRoot, ...payload } = closure
    closure.closureRoot = brainCalibrationCampaignHash('closure-root-v1', payload)
    writeFileSync(closurePath, `${JSON.stringify(closure)}\n`, 'utf8')

    assert.throws(
      () => closeBrainCalibrationCampaign(fixture.vault, { dryRun: false }),
      /Nicht verankerte lokale Closure wird nicht nachträglich extern signiert/,
    )
    assert.equal(
      readdirSync(anchorPath).some(name => name.endsWith('.closure.json')),
      false,
    )
  })

  test('recovers only from an already anchored closure root', async () => {
    const fixture = await registerFixture()
    recordReviewerMatrix(fixture)
    const closed = closeBrainCalibrationCampaign(fixture.vault, { dryRun: false })
    const closurePath = join(
      vaultPath,
      BRAIN_CALIBRATION_CAMPAIGN_CLOSURE_PATH,
    )
    const original = readFileSync(closurePath, 'utf8')
    const receiptCount = readdirSync(anchorPath)
      .filter(name => name.endsWith('.closure.json')).length
    assert.equal(receiptCount, 1)

    unlinkSync(closurePath)
    const preview = closeBrainCalibrationCampaign(fixture.vault, { dryRun: true })
    assert.equal(preview.dryRun, true)
    assert.equal(preview.externalAnchor, 'verified')
    assert.equal(preview.artifact.closureRoot, closed.artifact.closureRoot)
    assert.equal(existsSync(closurePath), false)

    const recovered = closeBrainCalibrationCampaign(fixture.vault, { dryRun: false })
    assert.equal(recovered.operation, 'created')
    assert.equal(recovered.externalAnchor, 'verified')
    assert.equal(readFileSync(closurePath, 'utf8'), original)
    assert.equal(
      readdirSync(anchorPath).filter(name => name.endsWith('.closure.json')).length,
      1,
    )
  })

  test('requires the closure receipt to bind the exact closedAt timestamp', async () => {
    const fixture = await registerFixture()
    recordReviewerMatrix(fixture)
    closeBrainCalibrationCampaign(fixture.vault, { dryRun: false })

    const receiptName = readdirSync(anchorPath).find(name =>
      name.endsWith('.closure.json'))
    assert.ok(receiptName)
    const receiptPath = join(anchorPath, receiptName)
    const receipt = JSON.parse(
      readFileSync(receiptPath, 'utf8'),
    ) as Record<string, unknown>
    receipt.anchoredAt = new Date(
      Date.parse(String(receipt.anchoredAt)) + 1_000,
    ).toISOString()
    const { receiptRoot: _oldRoot, ...payload } = receipt
    receipt.receiptRoot = brainCalibrationCampaignHash(
      'external-anchor-receipt-v1',
      payload,
    )
    chmodSync(receiptPath, 0o600)
    writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, 'utf8')

    assert.throws(
      () => closeBrainCalibrationCampaign(fixture.vault, { dryRun: true }),
      /gebundenen Artefaktzeitpunkt/,
    )
  })

  test('detects local rollback while the external registration anchor remains', async () => {
    const fixture = await registerFixture()
    unlinkSync(join(vaultPath, BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH))

    assert.throws(
      () => registerBrainCalibrationCampaign(fixture.vault, {
        ...CAMPAIGN_OPTIONS,
        dryRun: true,
      }),
      /Rollback erkannt/,
    )
  })

  test('fails closed when the external registration anchor is missing or corrupted', async () => {
    const fixture = await registerFixture()
    const receiptName = readdirSync(anchorPath).find(name =>
      name.endsWith('.registration.json'))
    assert.ok(receiptName)
    const receiptPath = join(anchorPath, receiptName)
    const original = readFileSync(receiptPath, 'utf8')

    unlinkSync(receiptPath)
    assert.throws(
      () => resolveBrainCalibrationCampaignReviewTarget(fixture.vault, {
        reviewToken: fixture.registration.reviewArchive[0].reviewToken,
        reviewer: 'alice',
      }),
      /registration-Anchor fehlt/,
    )

    writeFileSync(receiptPath, original, { encoding: 'utf8', mode: 0o444 })
    chmodSync(receiptPath, 0o600)
    const corrupted = JSON.parse(original) as Record<string, unknown>
    corrupted.root = '0'.repeat(64)
    writeFileSync(receiptPath, `${JSON.stringify(corrupted)}\n`, 'utf8')
    assert.throws(
      () => resolveBrainCalibrationCampaignReviewTarget(fixture.vault, {
        reviewToken: fixture.registration.reviewArchive[0].reviewToken,
        reviewer: 'alice',
      }),
      /Anchor-Receipt-Root ist ungültig|stimmt nicht/,
    )
  })

  test('rejects local registration mutation through its content root', async () => {
    const fixture = await registerFixture()
    const registrationPath = join(
      vaultPath,
      BRAIN_CALIBRATION_CAMPAIGN_REGISTRATION_PATH,
    )
    const registration = JSON.parse(
      readFileSync(registrationPath, 'utf8'),
    ) as Record<string, unknown>
    registration.campaignId = 'campaign-mutated'
    writeFileSync(registrationPath, `${JSON.stringify(registration)}\n`, 'utf8')

    assert.throws(
      () => readBrainCalibrationCampaignRegistration(fixture.vault),
      /registrationRoot ist nicht reproduzierbar/,
    )
  })
})
