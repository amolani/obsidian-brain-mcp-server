import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { loadBrainPolicy } from '../services/policy.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('brain review orchestrator', () => {
  const originalPolicyPath = process.env.BRAIN_POLICY_PATH
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Technik/Netzwerk/DHCP.md',
      frontmatter: { status: 'aktiv', tags: ['dhcp', 'netzwerk'] },
      title: 'DHCP',
      body: 'DHCP laeuft auf der Firewall.',
    })
    writeNote(vaultPath, {
      path: 'Kunden/Schule/Projekt.md',
      frontmatter: { status: 'aktiv', tags: ['kunde'] },
      title: 'Projekt',
      body: 'Siehe [[Referenz/DHCP]] fuer Details.\n',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    if (originalPolicyPath === undefined) delete process.env.BRAIN_POLICY_PATH
    else process.env.BRAIN_POLICY_PATH = originalPolicyPath
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('brain_review aggregates action-backed housekeeping items', () => {
    const review = vault.brainReview({ includeLow: true })

    assert.ok(review.total >= 3)
    assert.ok(review.items.some(item => item.id === 'safe:broken_links' && item.action.kind === 'safe_maintenance'))
    assert.ok(review.items.some(item => item.id === 'knowledge_index:build'))
    assert.ok(review.items.some(item => item.id === 'hot_cache:update'))
    assert.ok(review.recommendedNextActions.length > 0)
  })

  test('brain_apply_review_item is dry-run-first and delegates safe actions', () => {
    const sourcePath = join(vaultPath, 'Kunden', 'Schule', 'Projekt.md')
    const before = readFileSync(sourcePath, 'utf-8')

    const preview = vault.brainApplyReviewItem({
      itemId: 'safe:broken_links',
      dryRun: true,
    })
    assert.equal(preview.dryRun, true)
    assert.equal(readFileSync(sourcePath, 'utf-8'), before)

    const applied = vault.brainApplyReviewItem({
      itemId: 'safe:broken_links',
      dryRun: false,
    })
    assert.equal(applied.dryRun, false)
    assert.match(readFileSync(sourcePath, 'utf-8'), /\[\[Technik\/Netzwerk\/DHCP\]\]/)
  })

  test('brain_apply_review_item can build the manual knowledge index', () => {
    const preview = vault.brainApplyReviewItem({
      itemId: 'knowledge_index:build',
      dryRun: true,
    })
    assert.equal(preview.dryRun, true)
    assert.ok(!existsSync(join(vaultPath, 'Knowledge', 'index.md')))

    vault.brainApplyReviewItem({
      itemId: 'knowledge_index:build',
      dryRun: false,
    })
    assert.ok(existsSync(join(vaultPath, 'Knowledge', 'index.md')))
  })

  test('wrapper policy blocks every apply branch but never blocks previews', () => {
    const policy = structuredClone(loadBrainPolicy())
    policy.tools.brain_apply_review_item.write = false
    const policyPath = join(vaultPath, 'review-policy.json')
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8')
    process.env.BRAIN_POLICY_PATH = policyPath

    assert.doesNotThrow(() => vault.brainApplyReviewItem({ itemId: 'safe:broken_links', dryRun: true }))
    assert.doesNotThrow(() => vault.brainApplyReviewItem({ itemId: 'knowledge_index:build', dryRun: true }))
    assert.throws(
      () => vault.brainApplyReviewItem({ itemId: 'safe:broken_links', dryRun: false }),
      /brain_apply_review_item ist laut Policy read-only/,
    )
    assert.throws(
      () => vault.brainApplyReviewItem({ itemId: 'knowledge_index:build', dryRun: false }),
      /brain_apply_review_item ist laut Policy read-only/,
    )
    assert.ok(!existsSync(join(vaultPath, 'Knowledge', 'index.md')))
  })

  test('open contradictions are surfaced as critical but not auto-applied', () => {
    const contradiction = vault.flagContradiction({
      title: 'DHCP Ort',
      claimA: 'DHCP laeuft auf linuxmuster.',
      claimB: 'DHCP laeuft auf der Firewall.',
      dryRun: false,
    })
    const review = vault.brainReview()
    const item = review.items.find(candidate => candidate.targets.includes(contradiction.path))

    assert.ok(item)
    assert.equal(item.severity, 'critical')
    assert.equal(item.action.kind, 'none')
    assert.throws(
      () => vault.brainApplyReviewItem({ itemId: item.id }),
      /keine automatische Aktion/,
    )
  })

  test('quarantines an unreadable calibration dataset without bricking general review', () => {
    writeFileSync(join(vaultPath, '.brain-calibration.json'), JSON.stringify({
      schemaVersion: 2,
      entries: [{
        observationId: 'ko-000000000000000000000000',
        label: 'useful',
        value: true,
        reviewer: 'reviewer',
        recordedAt: '2026-07-23T10:00:00.000Z',
        snapshot: { modelVersion: 'unknown-future-model' },
      }],
    }), 'utf-8')

    const review = vault.brainReview({ includeLow: true })
    const quarantine = review.items.find(item => item.id === 'calibration_dataset:quarantine')
    assert.ok(quarantine)
    assert.equal(quarantine.category, 'calibration_integrity')
    assert.ok(review.items.some(item => item.id === 'knowledge_index:build'))
  })
})
