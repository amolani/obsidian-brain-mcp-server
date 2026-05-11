import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { NoteEntry } from '../vault.ts'
import { buildTodoList } from '../services/todo-list.ts'

function note(path: string, todos: NoteEntry['todos']): NoteEntry {
  return {
    path: `/vault/${path}`,
    relativePath: path,
    title: path.replace(/\.md$/, ''),
    frontmatter: {},
    tags: [],
    outgoingLinks: [],
    todos,
    lastModified: 1,
    content: '',
  }
}

describe('todo-list', () => {
  test('returns open todos only and sorts files by open todo count', () => {
    const notes = new Map<string, NoteEntry>([
      ['A.md', note('A.md', [
        { text: 'A1', done: false, line: 1 },
        { text: 'A2', done: false, line: 2 },
      ])],
      ['B.md', note('B.md', [
        { text: 'B1', done: false, line: 1 },
        { text: 'B done', done: true, line: 2 },
      ])],
      ['C.md', note('C.md', [
        { text: 'C done', done: true, line: 1 },
      ])],
    ])

    const items = buildTodoList(notes)

    assert.deepEqual(items.map(item => item.file), ['A.md', 'B.md'])
    assert.deepEqual(items.map(item => item.todos.length), [2, 1])
  })

  test('applies case-insensitive folder filter', () => {
    const notes = new Map<string, NoteEntry>([
      ['Kunden/A/Plan.md', note('Kunden/A/Plan.md', [{ text: 'A1', done: false, line: 1 }])],
      ['Referenz/Plan.md', note('Referenz/Plan.md', [{ text: 'R1', done: false, line: 1 }])],
    ])

    assert.deepEqual(buildTodoList(notes, 'kunden').map(item => item.file), ['Kunden/A/Plan.md'])
  })
})
