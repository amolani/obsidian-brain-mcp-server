import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('advanced brain layer', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/Schule/Projekt.md',
      frontmatter: { status: 'aktiv', tags: ['kunde'], kunde: 'Schule' },
      title: 'Projekt',
      body: 'DHCP muss auf der Firewall laufen.\n\n- [ ] Firewall Scope prüfen\n',
    })
    writeNote(vaultPath, {
      path: 'Referenz/Quellen/DHCP Vendor.md',
      frontmatter: { status: 'aktiv', tags: ['source'], quelle: '.raw/vendor/dhcp.md' },
      title: 'DHCP Vendor',
      body: 'DHCP should run on the firewall for managed school networks. Linuxmuster should not provide DHCP directly.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('manual knowledge saves and evidence updates carry confidence metadata', () => {
    const saved = vault.saveDecision({
      title: 'DHCP Firewall Entscheidung',
      content: 'DHCP bleibt auf der Firewall.',
      source: 'Referenz/Quellen/DHCP Vendor.md',
      confidence: 'high',
      recheckAt: '2099-01-01',
      dryRun: false,
    })

    assert.match(readFileSync(join(vaultPath, saved.path), 'utf-8'), /confidence: high/)
    assert.equal(vault.evidenceReport().missingConfidence, 1)

    const update = vault.updateEvidence({
      path: 'Referenz/Quellen/DHCP Vendor.md',
      confidence: 'medium',
      checkedAt: '2026-05-12',
      dryRun: false,
    })
    assert.equal(update.dryRun, false)
    assert.ok(update.changedFields.includes('confidence'))
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"update_evidence"/)
  })

  test('claim extraction is dry-run-first and writes claim notes on apply', () => {
    const preview = vault.extractClaims({
      path: 'Referenz/Quellen/DHCP Vendor.md',
      dryRun: true,
    })
    assert.equal(preview.dryRun, true)
    assert.ok(preview.claims.length >= 1)
    assert.equal(preview.written.length, 0)

    const applied = vault.extractClaims({
      path: 'Referenz/Quellen/DHCP Vendor.md',
      dryRun: false,
    })
    assert.equal(applied.dryRun, false)
    assert.ok(applied.written.length >= 1)
    assert.ok(vault.getNoteContext(applied.written[0]))
  })

  test('brain dashboard writes a generated overview note only on apply', () => {
    vault.flagKnowledgeGap({
      question: 'Welche DHCP Quelle ist verbindlich?',
      dryRun: false,
    })

    const preview = vault.buildBrainDashboard()
    assert.equal(preview.dryRun, true)
    assert.ok(preview.content.includes('Brain Dashboard'))
    assert.ok(!existsSync(join(vaultPath, 'Knowledge', '_brain.md')))

    const applied = vault.buildBrainDashboard({ dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.ok(existsSync(join(vaultPath, 'Knowledge', '_brain.md')))
    assert.ok(vault.getNoteContext(applied.path))
  })

  test('feedback loop records outcomes and summarizes categories', () => {
    const preview = vault.recordBrainFeedback({
      itemId: 'safe:broken_links',
      outcome: 'rejected',
      category: 'links',
      reason: 'Zu aggressiv',
    })
    assert.equal(preview.dryRun, true)
    assert.ok(!existsSync(join(vaultPath, '.brain-feedback.json')))

    vault.recordBrainFeedback({
      itemId: 'safe:broken_links',
      outcome: 'rejected',
      category: 'links',
      dryRun: false,
    })
    const summary = vault.brainFeedbackSummary()
    assert.equal(summary.total, 1)
    assert.equal(summary.rejected, 1)
    assert.equal(summary.byCategory.links.rejected, 1)
  })

  test('memory timeline and schedule are explicit workflows', () => {
    const timeline = vault.buildMemoryTimeline({ client: 'Schule', dryRun: false })
    assert.equal(timeline.dryRun, false)
    assert.ok(timeline.eventCount >= 1)
    assert.ok(existsSync(join(vaultPath, 'Kunden', 'Schule', '_timeline.md')))

    vault.updateEvidence({
      path: 'Kunden/Schule/Projekt.md',
      confidence: 'high',
      recheckAt: '2020-01-01',
      dryRun: false,
    })
    const schedule = vault.proposeBrainSchedule({ horizonDays: 30 })
    assert.ok(schedule.items.some(item => item.id.includes('Kunden/Schule/Projekt.md')))
    assert.ok(schedule.items.every(item => item.suggestedTool))
  })

  test('customer generated surfaces do not ingest previous generated surfaces', () => {
    vault.buildMemoryTimeline({ client: 'Schule', dryRun: false })
    vault.buildCustomerSnapshot({ client: 'Schule', dryRun: false })
    const snapshot = vault.buildCustomerSnapshot({ client: 'Schule', dryRun: false })
    const timeline = vault.buildMemoryTimeline({ client: 'Schule', dryRun: false })

    assert.doesNotMatch(snapshot.content, /Kunden\/Schule\/_snapshot/)
    assert.doesNotMatch(snapshot.content, /Kunden\/Schule\/_timeline/)
    assert.doesNotMatch(timeline.content, /_snapshot/)
    assert.doesNotMatch(timeline.content, /_timeline/)
  })

  test('customer snapshot filters conversational session noise', () => {
    writeNote(vaultPath, {
      path: 'Kunden/Schule/Session Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture', 'kunde/schule'],
        kunde: 'Schule',
      },
      title: 'Session Capture',
      body: [
        '1. ich arbeite heute in einer linuxmuster Umgebung.',
        'OK — ich warte auf docker --version.',
        'Docker service ist aktiv und Compose ist installiert.',
      ].join('\n\n'),
    })
    vault.shutdown()
    vault = new Vault(vaultPath)
    return vault.init().then(() => {
      const snapshot = vault.buildCustomerSnapshot({ client: 'Schule', dryRun: true })

      assert.doesNotMatch(snapshot.content, /ich arbeite heute/)
      assert.doesNotMatch(snapshot.content, /ich warte/)
      assert.match(snapshot.content, /Docker service ist aktiv/)
    })
  })
})
