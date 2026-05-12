import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

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
      body: [
        '## Ablauf',
        '',
        '### 1. Firewall DHCP umsetzen',
        '',
        'DHCP muss auf der Firewall laufen. Linuxmuster sollte DHCP nicht direkt bereitstellen.',
        '',
        '### 2. Umsetzung',
        '',
        '## Durchgeführte Befehle',
        '',
        '1. `systemctl disable isc-dhcp-server`',
        '2. `opnsense-cli dhcp scope apply`',
        '3. `systemctl restart isc-dhcp-server`',
        '',
        '## Zusammenfassung',
        '',
        'DHCP wurde fuer Schule auf Firewall-Betrieb festgelegt und umgesetzt.',
        '',
        '## Fehler und Workarounds',
        '',
        '**Fehler:** `dhcp service conflict`',
        '**Fix:** `disable linuxmuster dhcp and use firewall scope`',
      ].join('\n'),
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
})
