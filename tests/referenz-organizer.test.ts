import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { NoteEntry } from '../vault.ts'
import { organizeReferenz } from '../services/referenz-organizer.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

let vaultPath: string | null = null

afterEach(() => {
  if (vaultPath) cleanupVault(vaultPath)
  vaultPath = null
})

function note(path: string, overrides: Partial<NoteEntry> = {}): NoteEntry {
  return {
    path: join(vaultPath!, path),
    relativePath: path,
    title: path.replace(/\.md$/, '').split('/').pop()!,
    frontmatter: {},
    tags: [],
    outgoingLinks: [],
    todos: [],
    lastModified: 1,
    content: '',
    ...overrides,
  }
}

describe('referenz-organizer', () => {
  test('dry-run previews classifiable moves without moving files', () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, { path: 'Referenz/Docker Stuff.md', body: 'docker compose up' })
    const notes = new Map<string, NoteEntry>([
      ['Referenz/Docker Stuff.md', note('Referenz/Docker Stuff.md', {
        tags: ['docker'],
        content: 'docker compose up',
      })],
    ])

    const result = organizeReferenz({
      vaultPath,
      notes,
      indexNote() {},
      buildLinkIndex() {},
    }, true)

    assert.equal(result.dryRun, true)
    assert.ok(result.moved[0].to.startsWith('Technik/Docker/'))
    assert.ok(existsSync(join(vaultPath, 'Referenz/Docker Stuff.md')))
  })

  test('moves classifiable notes, updates index, rebuilds links, and logs action', () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, { path: 'Referenz/Docker Stuff.md', body: 'docker compose up' })
    const notes = new Map<string, NoteEntry>([
      ['Referenz/Docker Stuff.md', note('Referenz/Docker Stuff.md', {
        tags: ['docker'],
        content: 'docker compose up',
      })],
    ])
    const indexed: string[] = []
    let rebuilt = false

    const result = organizeReferenz({
      vaultPath,
      notes,
      indexNote(path) {
        indexed.push(path)
      },
      buildLinkIndex() {
        rebuilt = true
      },
    }, false)

    assert.equal(result.moved.length, 1)
    assert.ok(result.moved[0].to.startsWith('Technik/Docker/'))
    assert.ok(!existsSync(join(vaultPath, 'Referenz/Docker Stuff.md')))
    assert.ok(existsSync(join(vaultPath, result.moved[0].to)))
    assert.deepEqual(indexed, [join(vaultPath, result.moved[0].to)])
    assert.equal(rebuilt, true)
    assert.equal(notes.has('Referenz/Docker Stuff.md'), false)
  })

  test('skips unclassifiable notes', () => {
    vaultPath = createTempVault()
    const notes = new Map<string, NoteEntry>([
      ['Referenz/Random.md', note('Referenz/Random.md', { content: 'unclassifiable' })],
    ])

    const result = organizeReferenz({
      vaultPath,
      notes,
      indexNote() {},
      buildLinkIndex() {},
    }, false)

    assert.deepEqual(result.moved, [])
    assert.deepEqual(result.skipped, [{ path: 'Referenz/Random.md', reason: 'keine Kategorie zuordenbar' }])
  })
})
