import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { NoteEntry } from '../vault.ts'
import { searchNotes } from '../services/vault-search.ts'

function note(overrides: Partial<NoteEntry> = {}): NoteEntry {
  return {
    path: `/vault/${overrides.relativePath ?? 'Note.md'}`,
    relativePath: 'Note.md',
    title: 'Note',
    frontmatter: {},
    tags: [],
    outgoingLinks: [],
    todos: [],
    lastModified: 1,
    content: '',
    ...overrides,
  }
}

describe('vault-search', () => {
  test('ranks query results by title, tags, frontmatter, and content matches', () => {
    const notes = new Map<string, NoteEntry>([
      ['A.md', note({ title: 'Docker Runbook', tags: ['ops'], content: 'docker once' })],
      ['B.md', note({ title: 'Container Notes', tags: ['docker'], content: 'no body hit' })],
      ['C.md', note({ title: 'Plain Note', frontmatter: { projekt: 'Docker' }, content: 'x' })],
      ['D.md', note({ title: 'Content Only', content: 'docker docker docker docker' })],
    ])

    const results = searchNotes(notes, { query: 'docker' })

    assert.deepEqual(results.map(result => result.path), ['A.md', 'B.md', 'D.md', 'C.md'])
    assert.deepEqual(results.map(result => result.matchCount), [11, 5, 4, 3])
  })

  test('does not score internal calibration frontmatter', () => {
    const notes = new Map<string, NoteEntry>([
      ['Calibration.md', note({
        title: 'Generic Capture',
        frontmatter: {
          status: 'aktiv',
          calibration_snapshot_payloads: ['blindreviewtoken'],
          calibration_capture_schema: 'calibration-capture-v2',
        },
      })],
      ['Knowledge.md', note({
        title: 'Ordinary Knowledge',
        frontmatter: { projekt: 'blindreviewtoken' },
      })],
    ])

    const results = searchNotes(notes, { query: 'blindreviewtoken' })

    assert.deepEqual(results.map(result => result.path), ['Knowledge.md'])
    assert.equal(results[0]?.matchCount, 3)
  })

  test('applies folder, tag, and status filters before query scoring', () => {
    const notes = new Map<string, NoteEntry>([
      ['Kunden/A/Docker.md', note({
        title: 'Docker',
        frontmatter: { status: 'aktiv' },
        tags: ['docker', 'kunde/a'],
        content: 'docker',
      })],
      ['Kunden/B/Docker.md', note({
        title: 'Docker',
        frontmatter: { status: 'archiviert' },
        tags: ['docker', 'kunde/b'],
        content: 'docker',
      })],
      ['Referenz/Docker.md', note({
        title: 'Docker',
        frontmatter: { status: 'aktiv' },
        tags: ['docker'],
        content: 'docker',
      })],
    ])

    const results = searchNotes(notes, {
      folder: 'kunden',
      tags: ['docker', 'kunde/a'],
      status: 'AKTIV',
      query: 'docker',
    })

    assert.deepEqual(results.map(result => result.path), ['Kunden/A/Docker.md'])
  })

  test('sorts unscored filtered results by last modified descending', () => {
    const notes = new Map<string, NoteEntry>([
      ['Old.md', note({ title: 'Old', tags: ['ops'], lastModified: 10 })],
      ['New.md', note({ title: 'New', tags: ['ops'], lastModified: 30 })],
      ['Other.md', note({ title: 'Other', tags: ['personal'], lastModified: 50 })],
    ])

    const results = searchNotes(notes, { tags: ['ops'] })

    assert.deepEqual(results.map(result => result.path), ['New.md', 'Old.md'])
    assert.ok(results.every(result => result.matchCount === 0))
  })
})
