import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { NoteEntry } from '../vault.ts'
import { buildLinkIndexForNotes, resolveLinkInNotes } from '../services/link-index.ts'

function note(path: string, outgoingLinks: string[] = []): NoteEntry {
  return {
    path: `/vault/${path}`,
    relativePath: path,
    title: path.split('/').pop()!.replace(/\.md$/, ''),
    frontmatter: {},
    tags: [],
    outgoingLinks,
    todos: [],
    lastModified: 1,
    content: '',
  }
}

describe('link-index', () => {
  test('resolves exact path, path without md, basename, and case-insensitive basename', () => {
    const notes = new Map<string, NoteEntry>([
      ['Kunden/A/Note.md', note('Kunden/A/Note.md')],
      ['Technik/Docker/Compose.md', note('Technik/Docker/Compose.md')],
    ])

    assert.equal(resolveLinkInNotes(notes, 'Kunden/A/Note.md'), 'Kunden/A/Note.md')
    assert.equal(resolveLinkInNotes(notes, 'Kunden/A/Note'), 'Kunden/A/Note.md')
    assert.equal(resolveLinkInNotes(notes, 'Compose'), 'Technik/Docker/Compose.md')
    assert.equal(resolveLinkInNotes(notes, 'compose'), 'Technik/Docker/Compose.md')
    assert.equal(resolveLinkInNotes(notes, 'Missing'), null)
  })

  test('builds backlink index from resolved outgoing links', () => {
    const notes = new Map<string, NoteEntry>([
      ['Dashboard.md', note('Dashboard.md', ['Compose', 'Kunden/A/Note'])],
      ['Kunden/A/Note.md', note('Kunden/A/Note.md')],
      ['Technik/Docker/Compose.md', note('Technik/Docker/Compose.md')],
    ])

    const index = buildLinkIndexForNotes(notes)

    assert.deepEqual([...(index.get('Technik/Docker/Compose.md') ?? [])], ['Dashboard.md'])
    assert.deepEqual([...(index.get('Kunden/A/Note.md') ?? [])], ['Dashboard.md'])
  })
})
