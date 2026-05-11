import type { NoteEntry } from '../vault.ts'

export interface TodoItem {
  file: string
  title: string
  todos: { text: string; line: number; done: boolean }[]
}

export function buildTodoList(notes: Map<string, NoteEntry>, folder?: string): TodoItem[] {
  const items: TodoItem[] = []

  for (const [relativePath, entry] of notes) {
    if (folder && !relativePath.toLowerCase().startsWith(folder.toLowerCase())) continue

    const openTodos = entry.todos.filter(todo => !todo.done)
    if (openTodos.length > 0) {
      items.push({
        file: relativePath,
        title: entry.title,
        todos: openTodos,
      })
    }
  }

  return items.sort((a, b) => b.todos.length - a.todos.length)
}
