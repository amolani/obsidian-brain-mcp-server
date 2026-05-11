import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { NoteEntry } from '../vault.ts'
import { buildVaultOverview } from '../services/vault-overview.ts'

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

describe('vault-overview', () => {
  test('counts folders, tags, open todos, and recent notes', () => {
    const notes = new Map<string, NoteEntry>([
      ['Root.md', note('Root.md', {
        tags: ['root', 'ops'],
        todos: [{ text: 'Open', done: false, line: 1 }],
        lastModified: NOW - DAY,
      })],
      ['Kunden/A/Plan.md', note('Kunden/A/Plan.md', {
        tags: ['kunde/a', 'ops'],
        todos: [
          { text: 'Open', done: false, line: 1 },
          { text: 'Done', done: true, line: 2 },
        ],
        lastModified: NOW,
      })],
    ])

    const overview = buildVaultOverview(notes, new Map(), NOW)

    assert.equal(overview.totalNotes, 2)
    assert.deepEqual(overview.notesByFolder, { '(root)': 1, Kunden: 1 })
    assert.deepEqual(overview.allTags, { root: 1, ops: 2, 'kunde/a': 1 })
    assert.equal(overview.openTodoCount, 2)
    assert.deepEqual(overview.recentlyModified.map(note => note.path), ['Kunden/A/Plan.md', 'Root.md'])
  })

  test('excludes linked notes and Dashboard from orphan notes', () => {
    const notes = new Map<string, NoteEntry>([
      ['Dashboard.md', note('Dashboard.md', { title: 'Dashboard' })],
      ['Linked.md', note('Linked.md')],
      ['Orphan.md', note('Orphan.md')],
    ])
    const linkIndex = new Map<string, Set<string>>([
      ['Linked.md', new Set(['Source.md'])],
    ])

    const overview = buildVaultOverview(notes, linkIndex, NOW)

    assert.deepEqual(overview.orphanNotes, [{ path: 'Orphan.md', title: 'Orphan' }])
  })

  test('reports active stale notes and skips archive, daily, moc, and inactive notes', () => {
    const notes = new Map<string, NoteEntry>([
      ['VeryOld.md', note('VeryOld.md', {
        frontmatter: { status: 'aktiv' },
        lastModified: NOW - 250 * DAY,
      })],
      ['Old.md', note('Old.md', {
        frontmatter: { status: 'aktiv' },
        lastModified: NOW - 200 * DAY,
      })],
      ['Archiv/Old.md', note('Archiv/Old.md', {
        frontmatter: { status: 'aktiv' },
        lastModified: NOW - 300 * DAY,
      })],
      ['Daily/Old.md', note('Daily/Old.md', {
        frontmatter: { status: 'aktiv' },
        lastModified: NOW - 300 * DAY,
      })],
      ['Referenz/_MOC.md', note('Referenz/_MOC.md', {
        frontmatter: { status: 'aktiv' },
        lastModified: NOW - 300 * DAY,
      })],
      ['Planning.md', note('Planning.md', {
        frontmatter: { status: 'planung' },
        lastModified: NOW - 300 * DAY,
      })],
    ])

    const overview = buildVaultOverview(notes, new Map(), NOW)

    assert.deepEqual(overview.staleNotes.map(note => [note.path, note.daysAgo]), [
      ['VeryOld.md', 250],
      ['Old.md', 200],
    ])
    assert.equal(overview.staleNotes[0].lastModified, '2025-08-22')
  })
})
