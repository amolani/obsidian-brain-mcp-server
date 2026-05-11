import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { parseNoteEntry } from '../services/note-parser.ts'

describe('note-parser', () => {
  test('parses frontmatter, title, tags, links, and todos', () => {
    const raw = `---
status: aktiv
tags:
  - Docker
  - proxy
---

# Docker Note

Content with [[Target|Alias]] and [[Escaped\\|Alias]] plus #InlineTag.

- [ ] Open task
- [x] Done task
`

    const entry = parseNoteEntry('/vault/Technik/Docker.md', 'Technik/Docker.md', raw, 123)

    assert.equal(entry.title, 'Docker Note')
    assert.equal(entry.frontmatter.status, 'aktiv')
    assert.deepEqual(entry.tags.sort(), ['docker', 'inlinetag', 'proxy'])
    assert.deepEqual(entry.outgoingLinks, ['Target', 'Escaped'])
    assert.deepEqual(entry.todos, [
      { text: 'Open task', done: false, line: 6 },
      { text: 'Done task', done: true, line: 7 },
    ])
    assert.equal(entry.lastModified, 123)
  })

  test('falls back to filename when H1 is missing', () => {
    const entry = parseNoteEntry('/vault/Inbox/Untitled.md', 'Inbox/Untitled.md', 'No heading', 1)
    assert.equal(entry.title, 'Untitled')
  })
})
