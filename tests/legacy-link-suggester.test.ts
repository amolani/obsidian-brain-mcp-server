import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { NoteEntry } from '../vault.ts'
import { suggestLegacyLinks } from '../services/legacy-link-suggester.ts'

function note(path: string, overrides: Partial<NoteEntry> = {}): NoteEntry {
  return {
    path: `/vault/${path}`,
    relativePath: path,
    title: path.replace(/\.md$/, ''),
    frontmatter: {},
    tags: [],
    outgoingLinks: [],
    todos: [],
    lastModified: 1,
    content: '',
    ...overrides,
  }
}

describe('legacy-link-suggester', () => {
  test('suggests unlinked title mentions and skips existing/self links', () => {
    const notes = new Map<string, NoteEntry>([
      ['Source.md', note('Source.md', {
        title: 'Source',
        content: 'Docker Compose and Traefik are relevant here.',
        outgoingLinks: ['Traefik'],
      })],
      ['Docker Compose.md', note('Docker Compose.md', { title: 'Docker Compose' })],
      ['Traefik.md', note('Traefik.md', { title: 'Traefik' })],
    ])

    const suggestions = suggestLegacyLinks(notes, link => `${link}.md`)

    assert.deepEqual(suggestions, [{
      source: 'Source.md',
      mention: 'docker compose',
      target: 'Docker Compose.md',
      targetTitle: 'Docker Compose',
    }])
  })
})
