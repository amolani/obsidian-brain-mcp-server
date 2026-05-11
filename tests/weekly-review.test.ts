import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { NoteEntry } from '../vault.ts'
import { buildWeeklyReview } from '../services/weekly-review.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 3, 29)

function note(path: string, overrides: Partial<NoteEntry> = {}): NoteEntry {
  return {
    path: `/vault/${path}`,
    relativePath: path,
    title: path.replace(/\.md$/, ''),
    frontmatter: {},
    tags: [],
    outgoingLinks: [],
    todos: [],
    lastModified: NOW,
    content: '',
    ...overrides,
  }
}

describe('weekly-review', () => {
  test('builds period, recent changes, new notes, todo counts, and active projects', () => {
    const notes = new Map<string, NoteEntry>([
      ['Recent.md', note('Recent.md', {
        frontmatter: { datum: '2026-04-28', projekt: 'Acme', status: 'aktiv' },
        todos: [
          { text: 'Open', done: false, line: 1 },
          { text: 'Done', done: true, line: 2 },
        ],
        lastModified: NOW - DAY,
      })],
      ['Older.md', note('Older.md', {
        frontmatter: { datum: '2026-01-01', projekt: 'Acme', status: 'aktiv' },
        todos: [{ text: 'Open old', done: false, line: 1 }],
        lastModified: NOW - 20 * DAY,
      })],
      ['Inactive.md', note('Inactive.md', {
        frontmatter: { projekt: 'Other', status: 'archiviert' },
      })],
    ])

    const review = buildWeeklyReview(notes, NOW)

    assert.equal(review.period, '2026-04-22 — 2026-04-29')
    assert.deepEqual(review.modifiedNotes.map(note => note.path), ['Inactive.md', 'Recent.md'])
    assert.deepEqual(review.newNotes.map(note => note.path), ['Recent.md'])
    assert.equal(review.openTodos, 2)
    assert.equal(review.completedTodos, 1)
    assert.deepEqual(review.activeProjects, [{ projekt: 'Acme', noteCount: 2 }])
  })
})
