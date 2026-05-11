import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('inbox triage', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Technik/Docker/Traefik.md',
      frontmatter: { status: 'aktiv', tags: ['docker', 'traefik'] },
      title: 'Traefik',
      body: 'Traefik reverse proxy routing.',
    })
    writeNote(vaultPath, {
      path: 'Inbox/Docker Compose Notes.md',
      frontmatter: { tags: ['Docker Compose'] },
      title: 'Docker Compose Notes',
      body: 'docker compose container setup with traefik labels and dockerfile hints.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('triage_note dry-run classifies, suggests target, tags, and links without writing', () => {
    const result = vault.triageNote({ path: 'Inbox/Docker Compose Notes.md', dryRun: true })

    assert.equal(result.dryRun, true)
    assert.equal(result.applied, false)
    assert.equal(result.decision, 'move')
    assert.equal(result.targetFolder, 'Technik/Docker/Compose')
    assert.equal(result.targetPath, 'Technik/Docker/Compose/Docker Compose Notes.md')
    assert.ok(result.tags.includes('docker'))
    assert.ok(result.tags.includes('docker/compose'))
    assert.ok(result.linkSuggestions.some(suggestion => suggestion.target === 'Technik/Docker/Traefik.md'))
    assert.ok(existsSync(join(vaultPath, 'Inbox/Docker Compose Notes.md')))
    assert.ok(!existsSync(join(vaultPath, 'Technik/Docker/Compose/Docker Compose Notes.md')))
    assert.ok(!existsSync(join(vaultPath, '.action-log.jsonl')))
  })

  test('triage_note apply normalizes frontmatter, moves note, rewrites backlinks, and logs', () => {
    writeNote(vaultPath, {
      path: 'Dashboard.md',
      title: 'Dashboard',
      body: 'See [[Inbox/Docker Compose Notes]]',
    })
    vault.indexNote(join(vaultPath, 'Dashboard.md'), Date.now())
    vault.buildLinkIndex()

    const result = vault.triageNote({ path: 'Inbox/Docker Compose Notes.md', dryRun: false })

    assert.equal(result.applied, true)
    assert.equal(result.targetPath, 'Technik/Docker/Compose/Docker Compose Notes.md')
    assert.ok(!existsSync(join(vaultPath, 'Inbox/Docker Compose Notes.md')))
    assert.ok(existsSync(join(vaultPath, 'Technik/Docker/Compose/Docker Compose Notes.md')))

    const moved = readFileSync(join(vaultPath, 'Technik/Docker/Compose/Docker Compose Notes.md'), 'utf-8')
    assert.match(moved, /status: aktiv/)
    assert.match(moved, /  - docker/)
    assert.match(moved, /  - docker\/compose/)

    const dashboard = readFileSync(join(vaultPath, 'Dashboard.md'), 'utf-8')
    assert.match(dashboard, /\[\[Technik\/Docker\/Compose\/Docker Compose Notes\]\]/)

    const log = readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8')
    assert.match(log, /"tool":"rename_note"/)
    assert.match(log, /"tool":"triage_note"/)
  })

  test('triage_inbox previews all inbox notes', () => {
    writeNote(vaultPath, {
      path: 'Inbox/Unknown.md',
      title: 'Unknown',
      body: 'random loose thought without enough category signals',
    })
    vault.indexNote(join(vaultPath, 'Inbox/Unknown.md'), Date.now())

    const result = vault.triageInbox({ dryRun: true, maxNotes: 10 })

    assert.equal(result.dryRun, true)
    assert.equal(result.total, 2)
    assert.equal(result.applied, 0)
    assert.ok(result.results.some(item => item.decision === 'move'))
    assert.ok(result.results.some(item => item.decision === 'review_low_confidence'))
  })

  test('high-confidence duplicates stay in review and are not applied', () => {
    writeNote(vaultPath, {
      path: 'Inbox/Docker Compose Duplicate.md',
      frontmatter: { tags: ['docker', 'compose'] },
      title: 'Docker Compose Notes',
      body: 'docker compose container setup with traefik labels and dockerfile hints.',
    })
    vault.indexNote(join(vaultPath, 'Inbox/Docker Compose Duplicate.md'), Date.now())

    const result = vault.triageNote({ path: 'Inbox/Docker Compose Duplicate.md', dryRun: false })

    assert.equal(result.decision, 'review_duplicate')
    assert.equal(result.applied, false)
    assert.ok(result.duplicates.some(candidate => candidate.confidence === 'high'))
    assert.ok(existsSync(join(vaultPath, 'Inbox/Docker Compose Duplicate.md')))
  })
})
