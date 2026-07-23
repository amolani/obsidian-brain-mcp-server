import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { TOOL_DEFINITIONS } from '../server-tools.ts'
import { createToolHandler } from '../tool-handlers.ts'
import {
  KNOWLEDGE_INBOX_STATE_FILE,
  knowledgeInboxItemId,
  readKnowledgeInboxState,
} from '../services/knowledge-inbox-actions.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('knowledge inbox lifecycle', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/Schule/Review Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture', 'prozedur'],
        quelle: 'knowledge-harvester',
        kunde: 'Schule',
        client_match_method: 'fuzzy_cwd',
        client_match_alias: 'Schule',
        client_match_candidate: 'schulle',
        runbook_readiness: 70,
        source_stage: 'stop_capture',
        session_intent: 'implementation',
        intent_confidence: 'high',
      },
      title: 'Review Capture',
      body: '## Durchgeführte Befehle\n\n1. `systemctl restart dhcpd`',
    })
    writeNote(vaultPath, {
      path: 'Knowledge/Claims/DHCP Claim.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['claim', 'evidence'],
        quelle: 'Kunden/Schule/Review Capture.md',
        claim_status: 'provisional',
      },
      title: 'Claim: DHCP Claim',
      body: 'DHCP läuft auf der Firewall.',
    })
    writeNote(vaultPath, {
      path: 'Maintenance/Session Impact/Review Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['session-impact', 'maintenance'],
        quelle: 'session-impact-report',
      },
      title: 'Session Impact: Review Capture',
      body: '## Was wurde geschrieben?\n\nNoch nichts; Review erforderlich.',
    })
    writeFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), `${JSON.stringify({
      version: 1,
      sources: {
        'Kunden/Schule/Review Capture.md': {
          plan: [{
            action: 'promote_runbook',
            title: 'Runbook Promotion',
            quality: 'skip',
            reason: 'Validierung fehlt',
          }],
        },
      },
    }, null, 2)}\n`, 'utf-8')
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('is dry-run-first and persists one atomic low-risk batch with an action log', () => {
    const aliasId = knowledgeInboxItemId('review_client_alias', 'Kunden/Schule/Review Capture.md')
    const runbookId = knowledgeInboxItemId('runbook_preview', 'Kunden/Schule/Review Capture.md')

    const preview = vault.brainReviewInboxItems({
      itemIds: [aliasId, runbookId],
      status: 'accepted',
    })
    assert.equal(preview.dryRun, true)
    assert.equal(preview.changes.length, 2)
    assert.ok(!existsSync(join(vaultPath, KNOWLEDGE_INBOX_STATE_FILE)))

    const applied = vault.brainReviewInboxItems({
      itemIds: [aliasId, runbookId],
      status: 'accepted',
      reason: 'Vorschauen geprüft',
      dryRun: false,
    })
    assert.equal(applied.dryRun, false)
    const state = readKnowledgeInboxState(vault)
    assert.equal(state.items[aliasId]?.status, 'accepted')
    assert.equal(state.items[runbookId]?.status, 'accepted')
    assert.equal(state.items[aliasId]?.reason, 'Vorschauen geprüft')
    assert.ok(!readdirSync(vaultPath).some(file => file.includes(`${KNOWLEDGE_INBOX_STATE_FILE}.tmp-`)))

    const inbox = vault.buildKnowledgeInbox({ dryRun: true })
    assert.equal(inbox.uncertainClientCount, 0)
    assert.equal(inbox.runbookCandidateCount, 0)
    assert.match(inbox.content, /Akzeptiert: 2/)
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"brain_review_inbox_items"/)
  })

  test('exposes the lifecycle through the MCP schema and keeps the handler dry-run-first', async () => {
    const definition = TOOL_DEFINITIONS.find(tool => tool.name === 'brain_review_inbox_items')
    assert.ok(definition)
    assert.deepEqual(definition.inputSchema.required, ['item_ids', 'status'])
    const aliasId = knowledgeInboxItemId('review_client_alias', 'Kunden/Schule/Review Capture.md')
    const handler = createToolHandler(vault)

    const response = await handler({
      params: {
        name: 'brain_review_inbox_items',
        arguments: { item_ids: [aliasId], status: 'accepted' },
      },
    })

    assert.equal(response.isError, undefined)
    assert.match(response.content[0].text, /Dry-Run: true/)
    assert.ok(!existsSync(join(vaultPath, KNOWLEDGE_INBOX_STATE_FILE)))
  })

  test('supports reject, snooze, automatic snooze expiry, supersede, and explicit reopen', () => {
    const aliasId = knowledgeInboxItemId('review_client_alias', 'Kunden/Schule/Review Capture.md')
    const future = new Date(Date.now() + 86_400_000).toISOString()

    vault.brainReviewInboxItems({ itemIds: [aliasId], status: 'rejected', dryRun: false })
    assert.equal(readKnowledgeInboxState(vault).items[aliasId]?.status, 'rejected')

    vault.brainReviewInboxItems({ itemIds: [aliasId], status: 'open', dryRun: false })
    assert.match(vault.buildKnowledgeInbox({ dryRun: true }).content, new RegExp(aliasId))

    vault.brainReviewInboxItems({ itemIds: [aliasId], status: 'snoozed', snoozedUntil: future, dryRun: false })
    assert.doesNotMatch(vault.buildKnowledgeInbox({ dryRun: true }).content, new RegExp(aliasId))
    const statePath = join(vaultPath, KNOWLEDGE_INBOX_STATE_FILE)
    const expired = JSON.parse(readFileSync(statePath, 'utf-8'))
    expired.items[aliasId].snoozedUntil = new Date(Date.now() - 1_000).toISOString()
    writeFileSync(statePath, `${JSON.stringify(expired, null, 2)}\n`, 'utf-8')
    assert.match(vault.buildKnowledgeInbox({ dryRun: true }).content, new RegExp(aliasId))

    vault.brainReviewInboxItems({ itemIds: [aliasId], status: 'superseded', dryRun: false })
    assert.doesNotMatch(vault.buildKnowledgeInbox({ dryRun: true }).content, new RegExp(aliasId))
    vault.brainReviewInboxItems({ itemIds: [aliasId], status: 'open', dryRun: false })
    assert.match(vault.buildKnowledgeInbox({ dryRun: true }).content, new RegExp(aliasId))
  })

  test('gives auto-build skips and impact reports stable low-risk ids that can be cleared in a batch', () => {
    const skipId = knowledgeInboxItemId(
      'review_auto_build_skip',
      'Kunden/Schule/Review Capture.md#promote_runbook',
    )
    const impactId = knowledgeInboxItemId(
      'review_impact_report',
      'Maintenance/Session Impact/Review Capture.md',
    )
    const before = vault.buildKnowledgeInbox({ dryRun: true })
    assert.equal(before.skippedAutoBuildCount, 1)
    assert.equal(before.impactReportCount, 1)
    assert.match(before.content, new RegExp(skipId))
    assert.match(before.content, new RegExp(impactId))

    const applied = vault.brainReviewInboxItems({
      itemIds: [skipId, impactId],
      status: 'accepted',
      dryRun: false,
    })
    assert.ok(applied.changes.every(change => change.item.risk === 'low'))

    const after = vault.buildKnowledgeInbox({ dryRun: true })
    assert.equal(after.skippedAutoBuildCount, 0)
    assert.equal(after.impactReportCount, 0)
    assert.doesNotMatch(after.content, new RegExp(skipId))
    assert.doesNotMatch(after.content, new RegExp(impactId))
  })

  test('reopens a resolved item when its source fingerprint changes', () => {
    const aliasId = knowledgeInboxItemId('review_client_alias', 'Kunden/Schule/Review Capture.md')
    vault.brainReviewInboxItems({ itemIds: [aliasId], status: 'accepted', dryRun: false })
    assert.doesNotMatch(vault.buildKnowledgeInbox({ dryRun: true }).content, new RegExp(aliasId))

    const sourcePath = join(vaultPath, 'Kunden/Schule/Review Capture.md')
    writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf-8')}\n\nNeue Zuordnungsinformation.\n`, 'utf-8')
    vault.indexNote(sourcePath, statSync(sourcePath).mtimeMs)

    assert.match(vault.buildKnowledgeInbox({ dryRun: true }).content, new RegExp(aliasId))
  })

  test('blocks claim decisions as state-only transitions and blocks mixed-risk batches', () => {
    const confirmId = knowledgeInboxItemId('confirm_claim', 'Knowledge/Claims/DHCP Claim.md')
    const aliasId = knowledgeInboxItemId('review_client_alias', 'Kunden/Schule/Review Capture.md')

    assert.throws(
      () => vault.brainReviewInboxItems({ itemIds: [confirmId], status: 'accepted', dryRun: false }),
      /Claims dürfen nicht per Statewechsel/,
    )
    assert.equal(vault.notes.get('Knowledge/Claims/DHCP Claim.md')?.frontmatter.claim_status, 'provisional')
    assert.throws(
      () => vault.brainReviewInboxItems({ itemIds: [confirmId, aliasId], status: 'snoozed', snoozedUntil: new Date(Date.now() + 86_400_000).toISOString(), dryRun: false }),
      /nur für low-risk/,
    )

    const applied = vault.brainApplyInboxItem({ itemId: confirmId, dryRun: false })
    assert.equal(applied.state?.status, 'accepted')
    assert.equal(vault.notes.get('Knowledge/Claims/DHCP Claim.md')?.frontmatter.claim_status, 'confirmed')
  })

  test('runbook inbox action remains a preview while persisting its review decision', () => {
    const runbookId = knowledgeInboxItemId('runbook_preview', 'Kunden/Schule/Review Capture.md')
    const markdownBefore = readdirSync(join(vaultPath, 'Kunden/Schule')).filter(file => file.endsWith('.md')).sort()

    const result = vault.brainApplyInboxItem({ itemId: runbookId, dryRun: false })

    assert.equal(result.state?.status, 'accepted')
    assert.equal((result.result as { dryRun: boolean }).dryRun, true)
    assert.deepEqual(readdirSync(join(vaultPath, 'Kunden/Schule')).filter(file => file.endsWith('.md')).sort(), markdownBefore)
  })

  test('fails closed on corrupt lifecycle state instead of overwriting review history', () => {
    const statePath = join(vaultPath, KNOWLEDGE_INBOX_STATE_FILE)
    const corrupt = '{ broken review state'
    writeFileSync(statePath, corrupt, 'utf-8')
    const aliasId = knowledgeInboxItemId('review_client_alias', 'Kunden/Schule/Review Capture.md')

    assert.throws(() => vault.buildKnowledgeInbox({ dryRun: true }), /Knowledge-Inbox-State ist beschädigt/)
    assert.throws(
      () => vault.brainReviewInboxItems({ itemIds: [aliasId], status: 'accepted', dryRun: false }),
      /Knowledge-Inbox-State ist beschädigt/,
    )
    assert.equal(readFileSync(statePath, 'utf-8'), corrupt)
  })
})
