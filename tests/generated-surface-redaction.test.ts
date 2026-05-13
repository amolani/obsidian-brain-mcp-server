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
    writeNote(vaultPath, {
      path: 'Kunden/HUG/Runbook Verbose Probe.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['runbook', 'kunde/hug'],
        kunde: 'HUG',
      },
      title: 'Runbook Verbose Probe',
      body: [
        '## Systeme',
        '',
        '1. `ssh -o StrictHostKeyChecking=accept-new root@10.0.0.5 \'cat /srv/app/.env && grep -i token /srv/app/.env && docker compose ps\'`',
        '',
        'System: HUG App ist erreichbar.',
      ].join('\n'),
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

  test('customer timeline and dashboard do not copy credential snippets', () => {
    const timeline = vault.buildMemoryTimeline({ client: 'HUG', dryRun: true })
    const dashboard = vault.buildCustomerDashboard('HUG', { dryRun: true })
    const content = `${timeline.content}\n${dashboard.content}`

    assert.match(content, /Zugangsdaten/)
    assert.match(content, /REDACTED_SENSITIVE_NOTE_SNIPPET/)
    assert.doesNotMatch(content, /VPN4arbeitenvonextern/)
    assert.doesNotMatch(content, /HUG4holzsichermachen/)
  })

  test('generated customer surfaces hide verbose env probe commands', () => {
    const snapshot = vault.buildCustomerSnapshot({ client: 'HUG', dryRun: true })
    const timeline = vault.buildMemoryTimeline({ client: 'HUG', dryRun: true })
    const dashboard = vault.buildCustomerDashboard('HUG', { dryRun: true })
    const content = `${snapshot.content}\n${timeline.content}\n${dashboard.content}`

    assert.match(content, /HUG App ist erreichbar/)
    assert.match(content, /REDACTED_COMMAND_SNIPPET/)
    assert.doesNotMatch(content, /StrictHostKeyChecking/)
    assert.doesNotMatch(content, /edulution\.env|\/srv\/app\/\.env/)
  })
})
