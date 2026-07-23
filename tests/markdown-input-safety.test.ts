import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { buildFrontmatter } from '../services/frontmatter-linter.ts'
import { parseFrontmatter } from '../services/note-parser.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('MCP Markdown and frontmatter input safety', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/München/Projekt.md',
      frontmatter: { status: 'aktiv', tags: ['kunde'], kunde: 'München' },
      title: 'München Projekt',
      body: 'DHCP muss auf der Firewall laufen.\n\n- [ ] Scope prüfen\n',
    })
    writeNote(vaultPath, {
      path: 'Kunden/München/Capture.md',
      frontmatter: { status: 'aktiv', tags: ['auto-capture', 'prozedur'], quelle: 'knowledge-harvester' },
      title: 'München DHCP',
      body: '## Durchgeführte Schritte\n\n1. Firewall Scope prüfen\n',
    })
    writeNote(vaultPath, {
      path: '.raw/vendor.md',
      title: 'Vendor DHCP',
      body: 'Eine unveränderliche Quelle.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('frontmatter serializer keeps attacker-controlled values inside their scalar', () => {
    const value = 'DHCP\nstatus: archiviert\nquelle: attacker'
    const raw = `---\n${buildFrontmatter({ status: 'aktiv', topic: value, tags: ['safe', 'x\nstatus: hacked'] })}---\n`
    const parsed = parseFrontmatter(raw)

    assert.equal(parsed.status, 'aktiv')
    assert.equal(parsed.topic, value)
    assert.deepEqual(parsed.tags, ['safe', 'x\nstatus: hacked'])
    assert.equal(parsed.quelle, undefined)
  })

  test('frontmatter serializer also quotes non-simple keys', () => {
    const hostileKey = 'custom\nquelle'
    const raw = `---\n${buildFrontmatter({ status: 'aktiv', [hostileKey]: 'attacker' })}---\n`
    const parsed = parseFrontmatter(raw)

    assert.equal(parsed.status, 'aktiv')
    assert.equal(parsed[hostileKey], 'attacker')
    assert.equal(parsed.quelle, undefined)
  })

  test('checkpoint rejects multiline identifiers and unsafe source paths before writing', () => {
    assert.throws(
      () => vault.brainCheckpoint({ title: 'Gut\nstatus: archiviert', summary: 'Zusammenfassung', dryRun: true }),
      /Zeilenumbrüche/,
    )
    assert.throws(
      () => vault.brainCheckpoint({ summary: 'Zusammenfassung', client: 'München\nquelle: attacker', dryRun: true }),
      /Zeilenumbrüche/,
    )
    assert.throws(
      () => vault.brainCheckpoint({ summary: 'Zusammenfassung', sourcePath: '../outside.md', dryRun: true }),
      /Unsicherer Vault-Pfad/,
    )

    const result = vault.brainCheckpoint({ title: 'Übergabe München', summary: 'Alles stabil.', client: 'München', dryRun: true })
    assert.equal(result.path, 'Knowledge/Checkpoints/Übergabe München.md')
    assert.equal(parseFrontmatter(result.content).kunde, 'München')
  })

  test('hot-cache safely quotes YAML-significant queries and rejects multiline queries', () => {
    const safe = vault.updateHotCache({ query: 'DHCP: München #1', dryRun: true })
    const parsed = parseFrontmatter(safe.content)
    assert.equal(parsed.query, 'DHCP: München #1')
    assert.equal(parsed.quelle, 'hot-cache')

    assert.throws(
      () => vault.updateHotCache({ query: 'DHCP\nstatus: archiviert', dryRun: true }),
      /Zeilenumbrüche/,
    )
  })

  test('research, gaps, and customer surfaces reject control-line and traversal inputs', () => {
    assert.throws(
      () => vault.createResearchPlan({ topic: 'DHCP\nstatus: archiviert', dryRun: true }),
      /Zeilenumbrüche/,
    )
    assert.throws(
      () => vault.flagKnowledgeGap({ question: 'Was gilt?\nquelle: attacker', dryRun: true }),
      /Zeilenumbrüche/,
    )
    assert.throws(
      () => vault.flagContradiction({ title: 'A\nstatus: archiviert', claimA: 'A', claimB: 'B', dryRun: true }),
      /Zeilenumbrüche/,
    )
    assert.throws(() => vault.buildCustomerSnapshot({ client: '../outside', dryRun: true }), /Ungültiges client/)
    assert.throws(() => vault.buildMemoryTimeline({ client: 'München\nfoo', dryRun: true }), /Zeilenumbrüche/)
    assert.throws(
      () => vault.resolveGap({ path: '../outside.md', resolution: 'Nein', dryRun: true }),
      /Unsicherer Vault-Pfad/,
    )

    const snapshot = vault.buildCustomerSnapshot({ client: 'München', dryRun: true })
    const timeline = vault.buildMemoryTimeline({ client: 'München', dryRun: true })
    assert.equal(parseFrontmatter(snapshot.content).kunde, 'München')
    assert.equal(parseFrontmatter(timeline.content).kunde, 'München')
  })

  test('all user-selectable output folders are validated in dry-run mode', () => {
    assert.throws(
      () => vault.saveInsight({ title: 'Sicher', content: 'Inhalt', folder: '../outside', dryRun: true }),
      /Unsicherer Vault-Pfad/,
    )
    assert.throws(
      () => vault.ingestSource({ sourcePath: '.raw/vendor.md', outputFolder: '../outside', dryRun: true }),
      /Unsicherer Vault-Pfad/,
    )
    assert.throws(
      () => vault.generateRunbook('München', { outputFolder: '../outside', dryRun: true }),
      /Unsicherer Vault-Pfad/,
    )
    assert.throws(
      () => vault.promoteCaptureToRunbook({ path: 'Kunden/München/Capture.md', outputFolder: '../outside', dryRun: true }),
      /Unsicherer Vault-Pfad/,
    )
    assert.throws(
      () => vault.triageNote({ path: 'Kunden/München/Projekt.md', targetFolder: '../outside', dryRun: true }),
      /Unsicherer Vault-Pfad/,
    )
    assert.throws(
      () => vault.buildSessionImpactReport({ sourcePath: '../outside.md', dryRun: true }),
      /Unsicherer Vault-Pfad/,
    )
  })

  test('create_note rejects multiline titles and quotes hostile tag values', () => {
    assert.throws(
      () => vault.createNote('Projekt\nstatus: archiviert', 'kunde', undefined, ['safe']),
      /Zeilenumbrüche/,
    )
    assert.equal(existsSync(join(vaultPath, 'Kunden', 'Projekt\nstatus: archiviert')), false)

    const result = vault.createNote('Unicode Überprüfung', 'referenz', undefined, ['safe\nstatus: hacked'])
    const note = vault.getNoteContext(result.path)
    assert.ok(note)
    assert.deepEqual(note.frontmatter.tags, ['safe\nstatus: hacked'])
    assert.equal(note.frontmatter.status, 'aktiv')
  })
})
