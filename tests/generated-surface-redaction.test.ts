import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('generated surface redaction', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/HUG/Zugangsdaten.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['kunde/hug'],
        kunde: 'HUG',
      },
      title: 'Zugangsdaten',
      body: [
        'HUG4holzsichermachen#26',
        'VPN4arbeitenvonextern!',
        'Hostname: firewall.hug-holzenergie.de',
        '- [ ] Passwort Rotation pruefen: VPN4arbeitenvonextern!',
      ].join('\n'),
    })
    writeNote(vaultPath, {
      path: 'Kunden/HUG/VPN Befund.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['kunde/hug'],
        kunde: 'HUG',
      },
      title: 'VPN Befund',
      body: 'Synology01 ist unter 192.168.1.23 erreichbar.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('hot cache hides snippets and todos from credential notes', () => {
    const result = vault.updateHotCache({ query: 'HUG Zugangsdaten VPN', dryRun: true })

    assert.match(result.content, /REDACTED_SENSITIVE_NOTE_SNIPPET/)
    assert.doesNotMatch(result.content, /VPN4arbeitenvonextern/)
    assert.doesNotMatch(result.content, /HUG4holzsichermachen/)
  })

  test('customer snapshot links credential notes without copying their content', () => {
    const result = vault.buildCustomerSnapshot({ client: 'HUG', dryRun: true })

    assert.match(result.content, /Zugangsdaten/)
    assert.match(result.content, /REDACTED_SENSITIVE_NOTE_SNIPPET/)
    assert.doesNotMatch(result.content, /VPN4arbeitenvonextern/)
    assert.doesNotMatch(result.content, /HUG4holzsichermachen/)
  })
})
