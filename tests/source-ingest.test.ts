import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault } from './helpers.ts'

describe('source ingest', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    mkdirSync(join(vaultPath, '.raw', 'articles'), { recursive: true })
    writeFileSync(join(vaultPath, '.raw', 'articles', 'vendor-doc.md'), [
      '# Vendor DHCP Notes',
      '',
      '## Scope',
      '',
      '- DHCP must run on the firewall for this deployment.',
      '- Linuxmuster should only forward requests to the firewall service.',
      '',
      'See https://example.com/vendor/dhcp for details.',
    ].join('\n'), 'utf-8')
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('dry-run previews source note and does not write manifest', () => {
    const result = vault.ingestSource({
      sourcePath: '.raw/articles/vendor-doc.md',
      dryRun: true,
    })

    assert.equal(result.dryRun, true)
    assert.equal(result.skipped, false)
    assert.equal(result.title, 'Vendor DHCP Notes')
    assert.equal(result.profile, 'markdown')
    assert.equal(result.outputPath, 'Referenz/Quellen/Vendor DHCP Notes.md')
    assert.ok(result.headings.includes('Scope'))
    assert.ok(result.keyPoints.some(point => point.includes('DHCP must run')))
    assert.ok(result.links.includes('https://example.com/vendor/dhcp'))
    assert.ok(!existsSync(join(vaultPath, '.raw', '.manifest.json')))
    assert.ok(!existsSync(join(vaultPath, 'Referenz', 'Quellen', 'Vendor DHCP Notes.md')))
  })

  test('apply writes source note, manifest, index, and action log', () => {
    const result = vault.ingestSource({
      sourcePath: '.raw/articles/vendor-doc.md',
      dryRun: false,
    })

    assert.equal(result.dryRun, false)
    assert.ok(existsSync(join(vaultPath, result.outputPath)))
    assert.ok(existsSync(join(vaultPath, '.raw', '.manifest.json')))
    assert.ok(vault.getNoteContext(result.outputPath))

    const note = readFileSync(join(vaultPath, result.outputPath), 'utf-8')
    assert.match(note, /source_hash:/)
    assert.match(note, /DHCP must run on the firewall/)

    const manifest = JSON.parse(readFileSync(join(vaultPath, '.raw', '.manifest.json'), 'utf-8'))
    assert.equal(manifest.sources['.raw/articles/vendor-doc.md'].outputPath, result.outputPath)
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"ingest_source"/)
  })

  test('unchanged source is skipped after manifest entry unless forced', () => {
    const first = vault.ingestSource({
      sourcePath: '.raw/articles/vendor-doc.md',
      dryRun: false,
    })
    const second = vault.ingestSource({
      sourcePath: '.raw/articles/vendor-doc.md',
      dryRun: false,
    })
    assert.equal(second.skipped, true)
    assert.equal(second.outputPath, first.outputPath)

    const forced = vault.ingestSource({
      sourcePath: '.raw/articles/vendor-doc.md',
      dryRun: true,
      force: true,
    })
    assert.equal(forced.skipped, false)
  })

  test('source profiles add review prompts to generated notes', () => {
    const result = vault.ingestSource({
      sourcePath: '.raw/articles/vendor-doc.md',
      profile: 'ticket',
      dryRun: false,
    })

    const note = readFileSync(join(vaultPath, result.outputPath), 'utf-8')
    assert.equal(result.profile, 'ticket')
    assert.match(note, /profile: ticket/)
    assert.match(note, /Ticket Kontext/)
  })

  test('corrupt source manifest fails closed before writing an output note', () => {
    writeFileSync(join(vaultPath, '.raw', '.manifest.json'), '{ corrupt', 'utf-8')

    assert.throws(
      () => vault.ingestSource({ sourcePath: '.raw/articles/vendor-doc.md', dryRun: false }),
      /Source-Ingest-Manifest ist beschädigt/,
    )
    assert.ok(!existsSync(join(vaultPath, 'Referenz', 'Quellen', 'Vendor DHCP Notes.md')))
  })

  test('does not overwrite a manifest target whose ownership marker was removed', () => {
    const first = vault.ingestSource({ sourcePath: '.raw/articles/vendor-doc.md', dryRun: false })
    writeFileSync(join(vaultPath, first.outputPath), '---\nstatus: aktiv\nquelle: user\n---\n\n# Personal note\n', 'utf-8')

    assert.throws(
      () => vault.ingestSource({ sourcePath: '.raw/articles/vendor-doc.md', dryRun: false, force: true }),
      /nicht von \.raw\/articles\/vendor-doc\.md generiert/,
    )
    assert.match(readFileSync(join(vaultPath, first.outputPath), 'utf-8'), /# Personal note/)
  })

  test('rejects sources outside .raw', () => {
    assert.throws(
      () => vault.ingestSource({ sourcePath: 'Referenz/source.md', dryRun: true }),
      /nur Quellen unter \.raw/,
    )
  })
})
