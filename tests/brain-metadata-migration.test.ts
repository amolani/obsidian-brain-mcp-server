import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('brain metadata migration', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/Schule/Legacy Capture.md',
      frontmatter: { status: 'aktiv', tags: ['auto-capture', 'prozedur'], quelle: 'knowledge-harvester' },
      title: 'Legacy Capture',
      body: [
        '## Zusammenfassung',
        '',
        'Dienst wurde umgesetzt.',
        '',
        '## Durchgeführte Befehle',
        '',
        '1. `systemctl restart nginx`',
        '2. `docker compose up -d`',
        '3. `systemctl status nginx`',
      ].join('\n'),
    })
    writeNote(vaultPath, {
      path: 'Knowledge/Claims/Legacy Claim.md',
      frontmatter: { status: 'aktiv', tags: ['claim'], quelle: 'Kunden/Schule/Legacy Capture.md' },
      title: 'Legacy Claim',
      body: 'Der Dienst ist aktiv.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('previews and applies metadata backfill without moving notes', () => {
    const preview = vault.migrateBrainMetadata({ dryRun: true })
    assert.equal(preview.dryRun, true)
    assert.ok(preview.changed.some(change => change.path === 'Kunden/Schule/Legacy Capture.md'))
    assert.ok(!readFileSync(join(vaultPath, 'Kunden/Schule/Legacy Capture.md'), 'utf-8').includes('capture_value'))

    const applied = vault.migrateBrainMetadata({ dryRun: false })
    assert.equal(applied.dryRun, false)
    const capture = readFileSync(join(vaultPath, 'Kunden/Schule/Legacy Capture.md'), 'utf-8')
    assert.match(capture, /knowledge_type: capture/)
    assert.match(capture, /capture_value: \d+/)
    const claim = readFileSync(join(vaultPath, 'Knowledge/Claims/Legacy Claim.md'), 'utf-8')
    assert.match(claim, /claim_status: provisional/)
  })
})
