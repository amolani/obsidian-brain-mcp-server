import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('rename_note', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Referenz/Old Name.md',
      frontmatter: { status: 'aktiv', tags: ['docker'], title: 'Old Name' },
      title: 'Old Name',
      body: 'Original body.',
    })
    writeNote(vaultPath, {
      path: 'Dashboard.md',
      frontmatter: { status: 'aktiv', quelle: 'Referenz/Old Name.md' },
      title: 'Dashboard',
      body: [
        'See [[Old Name]] and [[Referenz/Old Name|old alias]].',
        'Escaped table link [[Referenz/Old Name\\|Table Alias]].',
      ].join('\n'),
    })
    writeNote(vaultPath, {
      path: 'Technik/_MOC.md',
      frontmatter: { status: 'moc' },
      title: 'Technik MOC',
      body: '- [[Referenz/Old Name]]',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('dry-run plans move and link rewrites without writing', () => {
    const result = vault.renameNote({
      path: 'Referenz/Old Name.md',
      newTitle: 'Docker Basics',
      targetFolder: 'Technik/Docker',
      dryRun: true,
    })

    assert.equal(result.dryRun, true)
    assert.equal(result.applied, false)
    assert.equal(result.plan.source, 'Referenz/Old Name.md')
    assert.equal(result.plan.target, 'Technik/Docker/Docker Basics.md')
    assert.equal(result.plan.changedLinks.length, 2)
    assert.deepEqual(result.plan.aliasesAdded, ['Old Name'])
    assert.ok(existsSync(join(vaultPath, 'Referenz/Old Name.md')))
    assert.ok(!existsSync(join(vaultPath, 'Technik/Docker/Docker Basics.md')))
    assert.ok(!existsSync(join(vaultPath, '.action-log.jsonl')))
  })

  test('apply moves note, updates title, aliases, wikilinks, frontmatter refs, and action log', () => {
    const result = vault.renameNote({
      path: 'Old Name',
      newTitle: 'Docker Basics',
      targetFolder: 'Technik/Docker',
      dryRun: false,
    })

    assert.equal(result.dryRun, false)
    assert.equal(result.applied, true)
    assert.ok(!existsSync(join(vaultPath, 'Referenz/Old Name.md')))
    assert.ok(existsSync(join(vaultPath, 'Technik/Docker/Docker Basics.md')))

    const renamed = readFileSync(join(vaultPath, 'Technik/Docker/Docker Basics.md'), 'utf-8')
    assert.match(renamed, /title: Docker Basics/)
    assert.match(renamed, /aliases:\n  - Old Name/)
    assert.match(renamed, /^# Docker Basics/m)

    const dashboard = readFileSync(join(vaultPath, 'Dashboard.md'), 'utf-8')
    assert.match(dashboard, /\[\[Technik\/Docker\/Docker Basics\]\]/)
    assert.match(dashboard, /\[\[Technik\/Docker\/Docker Basics\|old alias\]\]/)
    assert.match(dashboard, /\[\[Technik\/Docker\/Docker Basics\\\|Table Alias\]\]/)
    assert.match(dashboard, /quelle: Technik\/Docker\/Docker Basics\.md/)

    const moc = readFileSync(join(vaultPath, 'Technik/_MOC.md'), 'utf-8')
    assert.match(moc, /\[\[Technik\/Docker\/Docker Basics\]\]/)

    const ctx = vault.getNoteContext('Technik/Docker/Docker Basics.md')
    assert.ok(ctx)
    assert.equal(ctx.backlinks.length, 2)

    const log = readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8')
    assert.match(log, /"tool":"rename_note"/)
    assert.match(log, /Referenz\/Old Name\.md/)
    assert.match(log, /Technik\/Docker\/Docker Basics\.md/)
  })

  test('refuses to overwrite an existing target', () => {
    writeNote(vaultPath, { path: 'Technik/Docker/Docker Basics.md', title: 'Docker Basics' })
    vault.indexNote(join(vaultPath, 'Technik/Docker/Docker Basics.md'), Date.now())

    assert.throws(
      () => vault.renameNote({
        path: 'Referenz/Old Name.md',
        newTitle: 'Docker Basics',
        targetFolder: 'Technik/Docker',
        dryRun: false,
      }),
      /Ziel existiert bereits/,
    )
  })
})
