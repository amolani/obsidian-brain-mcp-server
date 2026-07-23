import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { KNOWLEDGE_INBOX_STATE_FILE, knowledgeInboxItemId } from '../services/knowledge-inbox-actions.ts'
import { attestSessionDigestFixture, cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('session impact and knowledge inbox', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/Schule/Firewall Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture', 'prozedur', 'kunde/schule'],
        quelle: 'knowledge-harvester',
        knowledge_type: 'capture',
        source_stage: 'stop_capture',
        session_intent: 'implementation',
        intent_confidence: 'medium',
        client_match_method: 'fuzzy_cwd',
        client_match_confidence: 'medium',
        client_match_candidate: 'schulle',
        client_match_alias: 'Schule',
        kunde: 'Schule',
      },
      title: 'Firewall Capture',
      body: attestSessionDigestFixture([
        '## Session Digest',
        '',
        '_Modell: `knowledge-salience-v1` · 4/4 Fakten ausgewählt · ordinale Scores, keine Wahrscheinlichkeiten_',
        '',
        '### Root Cause',
        '',
        '- [F1] Der parallel aktive Linuxmuster-DHCP verursachte den Dienstkonflikt. _(Salienz 86/100 · Evidenz 88/100 · high)_',
        '',
        '### Entscheidung',
        '',
        '- [F2] DHCP wird verbindlich auf der Firewall betrieben. _(Salienz 91/100 · Evidenz 88/100 · high)_',
        '',
        '### Änderung / Fix',
        '',
        '- [F3] Der Linuxmuster-DHCP wurde deaktiviert und der Firewall-Scope aktiviert. _(Salienz 90/100 · Evidenz 88/100 · high)_',
        '',
        '### Verifikation',
        '',
        '- [F4] Der DHCP-Scope antwortete nach der Umstellung ausschließlich über die Firewall. _(Salienz 89/100 · Evidenz 88/100 · high)_',
        '',
        '### Evidenz',
        '',
        '- [F1] `bash_pair:dhcp-cause` · Hash `aaaaaaaaaaaa` — linuxmuster dhcp active',
        '- [F2] `bash_pair:dhcp-decision` · Hash `bbbbbbbbbbbb` — firewall scope selected',
        '- [F3] `bash_pair:dhcp-change` · Hash `cccccccccccc` — services changed',
        '- [F4] `bash_pair:dhcp-verify` · Hash `dddddddddddd` — firewall lease returned',
        '',
        '## Durchgeführte Befehle',
        '',
        '1. `systemctl disable isc-dhcp-server`',
        '2. `opnsense-cli dhcp scope apply`',
        '3. `systemctl restart isc-dhcp-server`',
      ].join('\n')),
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('auto-build writes an impact report and refreshes the knowledge inbox', () => {
    const result = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Firewall Capture.md',
      client: 'Schule',
      dryRun: false,
    })

    assert.equal(result.intent.intent, 'implementation')
    assert.ok(result.impactReportPath)
    assert.ok(existsSync(join(vaultPath, result.impactReportPath!)))
    assert.ok(existsSync(join(vaultPath, 'Maintenance', 'Knowledge Inbox.md')))

    const impact = readFileSync(join(vaultPath, result.impactReportPath!), 'utf-8')
    assert.match(impact, /## Was wurde geschrieben\?/)
    assert.match(impact, /session_intent: implementation/)
    assert.match(impact, /Provisional Claim/)

    const inbox = readFileSync(join(vaultPath, 'Maintenance', 'Knowledge Inbox.md'), 'utf-8')
    assert.match(inbox, /## Provisional Claims/)
    assert.match(inbox, /## Kundenzuordnung prüfen/)
    assert.match(inbox, /## Runbook-Kandidaten/)
  })

  test('session impact report is dry-run-first when called directly', () => {
    const preview = vault.buildSessionImpactReport({
      sourcePath: 'Kunden/Schule/Firewall Capture.md',
      dryRun: true,
    })

    assert.equal(preview.dryRun, true)
    assert.equal(preview.intent.intent, 'implementation')
    assert.ok(!existsSync(join(vaultPath, preview.path)))
  })

  test('knowledge inbox previews review queues without writing', () => {
    const preview = vault.buildKnowledgeInbox({ dryRun: true })

    assert.equal(preview.dryRun, true)
    assert.equal(preview.uncertainClientCount, 1)
    assert.equal(preview.runbookCandidateCount, 1)
    assert.ok(!existsSync(join(vaultPath, preview.path)))
  })

  test('knowledge inbox ignores archived provisional claims', async () => {
    writeNote(vaultPath, {
      path: 'Archiv/Auto-Build/2026-05-13/ADBK Cleanup/Knowledge/Claims/Noisy Claim.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['claim', 'evidence'],
        quelle: 'Kunden/Schule/Firewall Capture.md',
        claim_status: 'provisional',
        confidence: 'medium',
      },
      title: 'Claim: Noisy Claim',
      body: 'ich arbeite heute in einer linuxmuster umgebung.',
    })
    vault.shutdown()
    vault = new Vault(vaultPath)
    await vault.init()

    const preview = vault.buildKnowledgeInbox({ dryRun: true })

    assert.doesNotMatch(preview.content, /Noisy Claim/)
    assert.doesNotMatch(preview.content, /Archiv\/Auto-Build/)
  })

  test('inbox claim action is dry-run-first and can confirm a claim', () => {
    vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Firewall Capture.md',
      client: 'Schule',
      dryRun: false,
    })
    const claim = [...vault.notes.values()].find(note => note.relativePath.startsWith('Knowledge/Claims/'))
    assert.ok(claim)
    const itemId = knowledgeInboxItemId('confirm_claim', claim.relativePath)

    const preview = vault.brainApplyInboxItem({ itemId, dryRun: true })
    assert.equal(preview.dryRun, true)
    assert.equal(vault.notes.get(claim.relativePath)?.frontmatter.claim_status, 'provisional')

    const applied = vault.brainApplyInboxItem({ itemId, dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.equal(vault.notes.get(claim.relativePath)?.frontmatter.claim_status, 'confirmed')
  })

  test('knowledge inbox state hides reviewed items until their source changes', () => {
    const itemId = knowledgeInboxItemId('review_client_alias', 'Kunden/Schule/Firewall Capture.md')

    const before = vault.buildKnowledgeInbox({ dryRun: true })
    assert.equal(before.uncertainClientCount, 1)
    assert.match(before.content, new RegExp(itemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const applied = vault.brainApplyInboxItem({ itemId, dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.equal(applied.state?.status, 'accepted')
    assert.ok(existsSync(join(vaultPath, KNOWLEDGE_INBOX_STATE_FILE)))

    const after = vault.buildKnowledgeInbox({ dryRun: true })
    assert.equal(after.uncertainClientCount, 0)
    assert.doesNotMatch(after.content, new RegExp(itemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })
})
