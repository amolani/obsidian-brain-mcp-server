import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('frontmatter schema profiles', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/Merian/Projekt.md',
      frontmatter: { tags: ['Projekt'] },
      title: 'Merian Projekt',
    })
    writeNote(vaultPath, {
      path: 'Daily/2026-05-11.md',
      frontmatter: { tags: ['daily'] },
      title: 'Daily 2026-05-11',
    })
    writeNote(vaultPath, {
      path: 'Captures/Session.md',
      frontmatter: { status: 'aktiv', tags: ['auto-capture'], quelle: 'knowledge-harvester' },
      title: 'Session Capture',
    })
    writeNote(vaultPath, {
      path: 'Technik/Docker/_MOC.md',
      frontmatter: { status: 'moc', tags: ['moc'] },
      title: 'Docker MOC',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('infers profiles and reports profile-specific missing fields', () => {
    const issues = vault.lintFrontmatter()

    assert.ok(issues.some(i =>
      i.path === 'Kunden/Merian/Projekt.md'
      && i.profile === 'Kunde'
      && i.field === 'kunde'
      && i.autoFixable,
    ))
    assert.ok(issues.some(i =>
      i.path === 'Daily/2026-05-11.md'
      && i.profile === 'Daily'
      && i.field === 'datum',
    ))
    assert.ok(issues.some(i =>
      i.path === 'Captures/Session.md'
      && i.profile === 'Auto-Capture'
      && i.field === 'datum',
    ))
    assert.ok(issues.some(i =>
      i.path === 'Technik/Docker/_MOC.md'
      && i.profile === 'MOC'
      && i.field === 'quelle',
    ))
  })

  test('explicit profile override is supported', () => {
    const issues = vault.lintFrontmatter({ profile: 'Runbook' })
    assert.ok(issues.some(i => i.path === 'Kunden/Merian/Projekt.md' && i.profile === 'Runbook' && i.field === 'quelle'))
  })

  test('fixFrontmatter applies safe profile defaults', () => {
    const result = vault.fixFrontmatter({ dryRun: false })
    assert.ok(result.fixed.some(item => item.path === 'Kunden/Merian/Projekt.md'))
    assert.ok(result.fixed.some(item => item.path === 'Daily/2026-05-11.md'))

    const kunde = readFileSync(join(vaultPath, 'Kunden/Merian/Projekt.md'), 'utf-8')
    assert.match(kunde, /status: aktiv/)
    assert.match(kunde, /kunde: Merian/)
    assert.match(kunde, /  - kunde/)
    assert.match(kunde, /  - projekt/)

    const daily = readFileSync(join(vaultPath, 'Daily/2026-05-11.md'), 'utf-8')
    assert.match(daily, /datum: \d{4}-\d{2}-\d{2}/)
    assert.doesNotMatch(daily, /status: aktiv/)

    const capture = readFileSync(join(vaultPath, 'Captures/Session.md'), 'utf-8')
    assert.match(capture, /datum: \d{4}-\d{2}-\d{2}/)

    const moc = readFileSync(join(vaultPath, 'Technik/Docker/_MOC.md'), 'utf-8')
    assert.match(moc, /status: moc/)
    assert.match(moc, /quelle: moc/)
  })
})
