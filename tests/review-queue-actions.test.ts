import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('review queue actions', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Inbox/Needs Status.md',
      frontmatter: { tags: ['test'] },
      title: 'Needs Status',
      body: 'Review me.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('accept/reject/snooze support dry-run before writing review state', () => {
    const dryRun = vault.acceptReviewItem({
      itemId: 'frontmatter:Inbox/Needs_Status.md:status',
      reason: 'looks safe',
      dryRun: true,
    })
    assert.equal(dryRun.dryRun, true)
    assert.ok(!existsSync(join(vaultPath, '.review-queue-actions.json')))

    vault.acceptReviewItem({
      itemId: 'frontmatter:Inbox/Needs_Status.md:status',
      reason: 'looks safe',
      dryRun: false,
    })
    vault.rejectReviewItem({
      itemId: 'quality:Inbox/Needs_Status.md',
      reason: 'not useful',
      dryRun: false,
    })
    vault.snoozeReviewItem({
      itemId: 'lifecycle:Inbox/Needs_Status.md:archiviert',
      snoozedUntil: '2026-05-20',
      dryRun: false,
    })

    const state = JSON.parse(readFileSync(join(vaultPath, '.review-queue-actions.json'), 'utf-8'))
    assert.equal(state['frontmatter:Inbox/Needs_Status.md:status'].status, 'accepted')
    assert.equal(state['quality:Inbox/Needs_Status.md'].status, 'rejected')
    assert.equal(state['lifecycle:Inbox/Needs_Status.md:archiviert'].status, 'snoozed')
    assert.equal(state['lifecycle:Inbox/Needs_Status.md:archiviert'].snoozedUntil, '2026-05-20')

    const log = readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8')
    assert.match(log, /"tool":"accepted_review_item"/)
    assert.match(log, /"tool":"rejected_review_item"/)
    assert.match(log, /"tool":"snoozed_review_item"/)
  })

  test('apply_all_safe_fixes delegates to safe maintenance dry-run first', () => {
    const preview = vault.applyAllSafeFixes({ dryRun: true, steps: ['frontmatter'] })
    assert.equal(preview.dryRun, true)
    assert.ok(preview.totalChanged > 0)
    assert.doesNotMatch(readFileSync(join(vaultPath, 'Inbox/Needs Status.md'), 'utf-8'), /status: aktiv/)

    const applied = vault.applyAllSafeFixes({ dryRun: false, steps: ['frontmatter'] })
    assert.equal(applied.dryRun, false)
    assert.ok(applied.totalChanged > 0)
    assert.match(readFileSync(join(vaultPath, 'Inbox/Needs Status.md'), 'utf-8'), /status: aktiv/)
  })

  test('maintenance report includes review item ids', () => {
    const report = vault.runMaintenance()
    const raw = readFileSync(join(vaultPath, report.reportPath), 'utf-8')
    assert.match(raw, /frontmatter:Inbox\/Needs_Status.md:status/)
  })
})
