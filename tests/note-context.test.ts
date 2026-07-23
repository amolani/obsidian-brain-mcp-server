import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { NoteEntry } from '../vault.ts'
import { buildNoteContext, findNoteEntry } from '../services/note-context.ts'

function note(path: string, overrides: Partial<NoteEntry> = {}): NoteEntry {
  return {
    path: `/vault/${path}`,
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

describe('note-context', () => {
  test('finds notes by path, path without extension, title, and filename', () => {
    const notes = new Map<string, NoteEntry>([
      ['Technik/Docker/Compose.md', note('Technik/Docker/Compose.md', { title: 'Docker Compose' })],
    ])

    assert.equal(findNoteEntry(notes, 'Technik/Docker/Compose.md')?.relativePath, 'Technik/Docker/Compose.md')
    assert.equal(findNoteEntry(notes, 'Technik/Docker/Compose')?.relativePath, 'Technik/Docker/Compose.md')
    assert.equal(findNoteEntry(notes, 'Docker Compose')?.relativePath, 'Technik/Docker/Compose.md')
    assert.equal(findNoteEntry(notes, 'compose')?.relativePath, 'Technik/Docker/Compose.md')
    assert.equal(findNoteEntry(notes, 'missing'), null)
  })

  test('builds backlinks, resolved outgoing links, and tag-related notes', () => {
    const notes = new Map<string, NoteEntry>([
      ['Source.md', note('Source.md', { title: 'Source' })],
      ['Target.md', note('Target.md', {
        title: 'Target',
        tags: ['docker', 'tls'],
        outgoingLinks: ['Outgoing'],
        content: 'Target content',
      })],
      ['Outgoing.md', note('Outgoing.md', { title: 'Outgoing' })],
      ['Related.md', note('Related.md', { title: 'Related', tags: ['docker', 'tls'] })],
      ['Weak.md', note('Weak.md', { title: 'Weak', tags: ['docker'] })],
    ])
    const linkIndex = new Map<string, Set<string>>([
      ['Target.md', new Set(['Source.md'])],
    ])
    const tagIndex = new Map<string, Set<string>>([
      ['docker', new Set(['Target.md', 'Related.md', 'Weak.md'])],
      ['tls', new Set(['Target.md', 'Related.md'])],
    ])

    const context = buildNoteContext(notes, linkIndex, tagIndex, link => `${link}.md`, 'Target')

    assert.ok(context)
    assert.deepEqual(context.backlinks, [{ path: 'Source.md', title: 'Source' }])
    assert.deepEqual(context.outgoingLinks, [{ path: 'Outgoing.md', title: 'Outgoing' }])
    assert.deepEqual(context.relatedByTags, [{ path: 'Related.md', title: 'Related' }])
    assert.equal(context.content, 'Target content')
  })

  test('ignores stale tag-index paths that no longer exist in notes', () => {
    const notes = new Map<string, NoteEntry>([
      ['Target.md', note('Target.md', { tags: ['docker', 'tls'] })],
    ])
    const tagIndex = new Map<string, Set<string>>([
      ['docker', new Set(['Target.md', 'Deleted.md'])],
      ['tls', new Set(['Target.md', 'Deleted.md'])],
    ])

    const context = buildNoteContext(notes, new Map(), tagIndex, () => null, 'Target.md')

    assert.ok(context)
    assert.deepEqual(context.relatedByTags, [])
  })
})
