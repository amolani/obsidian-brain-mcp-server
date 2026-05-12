import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('public beta brain surfaces', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/Acme/Captures/Firewall DHCP.md',
      frontmatter: { status: 'aktiv', tags: ['auto-capture', 'prozedur'], quelle: 'knowledge-harvester', datum: '2026-05-12', client_match_method: 'fuzzy_cwd', client_match_confidence: 'medium', client_match_candidate: 'akme', client_match_alias: 'Acme' },
      title: 'Firewall DHCP',
      body: `## Zusammenfassung

DHCP now runs on the firewall.

## Durchgeführte Befehle

1. \`systemctl status isc-dhcp-server\`
2. \`dhcpd -t\`
3. \`systemctl restart isc-dhcp-server\`

## Validierung

- Client received a lease.

## Fehler und Workarounds

### 1.
Restart service after config validation.`,
    })
    writeNote(vaultPath, {
      path: 'Knowledge/Claims/DHCP Firewall.md',
      frontmatter: { status: 'aktiv', tags: ['claim'] },
      title: 'DHCP Firewall',
      body: 'Firewall is the DHCP source.',
    })
    writeFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), JSON.stringify({
      version: 1,
      sources: {
        'Kunden/Acme/Captures/Firewall DHCP.md': {
          sourcePath: 'Kunden/Acme/Captures/Firewall DHCP.md',
          artifacts: [
            'Knowledge/Claims/DHCP Firewall.md',
            'Knowledge/Answers/A.md',
            'Knowledge/Answers/B.md',
            'Knowledge/Answers/C.md',
            'Knowledge/Answers/D.md',
            'Knowledge/Answers/E.md',
            'Knowledge/Answers/F.md',
          ],
        },
      },
    }), 'utf-8')
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('capture review is dry-run-first and writes generated surface when applied', () => {
    const preview = vault.buildCaptureReview({ dryRun: true })
    assert.equal(preview.dryRun, true)
    assert.equal(preview.captureCount, 1)
    assert.equal(preview.promotionCandidateCount, 1)
    assert.equal(preview.uncertainClientCount, 1)
    assert.equal(preview.noisyAutoBuildCount, 1)
    assert.ok(!existsSync(join(vaultPath, preview.path)))

    const applied = vault.buildCaptureReview({ dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.ok(existsSync(join(vaultPath, applied.path)))
    assert.match(readFileSync(join(vaultPath, applied.path), 'utf-8'), /Promotionskandidaten/)
  })

  test('evidence dashboard summarizes missing evidence metadata', () => {
    const result = vault.buildEvidenceDashboard({ dryRun: true })
    assert.equal(result.dryRun, true)
    assert.equal(result.totalCandidates, 1)
    assert.equal(result.issueCount, 2)
    assert.match(result.content, /Missing Confidence/)

    const applied = vault.buildEvidenceDashboard({ dryRun: false })
    assert.ok(existsSync(join(vaultPath, applied.path)))
  })

  test('runbook generation supports dry-run previews before writing', () => {
    const preview = vault.generateRunbook('Acme', { outputFolder: 'Knowledge/Runbooks', dryRun: true })
    assert.equal(preview.dryRun, true)
    assert.equal(preview.stepCount, 3)
    assert.match(preview.content, /## Rollback/)
    assert.ok(!existsSync(join(vaultPath, preview.path)))

    const applied = vault.generateRunbook('Acme', { outputFolder: 'Knowledge/Runbooks', dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.ok(existsSync(join(vaultPath, applied.path)))
  })
})
