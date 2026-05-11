import type { NoteEntry } from '../vault.ts'

export interface WeeklyReview {
  period: string
  modifiedNotes: { path: string; title: string; date: string }[]
  newNotes: { path: string; title: string; date: string }[]
  openTodos: number
  completedTodos: number
  activeProjects: { projekt: string; noteCount: number }[]
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function buildWeeklyReview(notes: Map<string, NoteEntry>, now: number = Date.now()): WeeklyReview {
  const weekAgo = now - WEEK_MS
  const weekStart = new Date(weekAgo).toISOString().split('T')[0]
  const weekEnd = new Date(now).toISOString().split('T')[0]

  const modifiedNotes: { path: string; title: string; date: string }[] = []
  const newNotes: { path: string; title: string; date: string }[] = []
  let openTodos = 0
  let completedTodos = 0
  const projectCounts = new Map<string, number>()

  for (const [, entry] of notes) {
    const dateStr = new Date(entry.lastModified).toISOString().split('T')[0]

    if (entry.lastModified >= weekAgo) {
      modifiedNotes.push({ path: entry.relativePath, title: entry.title, date: dateStr })

      const datum = entry.frontmatter.datum ?? entry.frontmatter.erstellt
      if (datum && new Date(datum).getTime() >= weekAgo) {
        newNotes.push({ path: entry.relativePath, title: entry.title, date: datum })
      }
    }

    for (const todo of entry.todos) {
      if (todo.done) completedTodos++
      else openTodos++
    }

    const projekt = entry.frontmatter.projekt
    if (projekt && entry.frontmatter.status === 'aktiv') {
      projectCounts.set(projekt, (projectCounts.get(projekt) ?? 0) + 1)
    }
  }

  modifiedNotes.sort((a, b) => b.date.localeCompare(a.date))
  const activeProjects = [...projectCounts.entries()]
    .map(([projekt, noteCount]) => ({ projekt, noteCount }))
    .sort((a, b) => b.noteCount - a.noteCount)

  return {
    period: `${weekStart} — ${weekEnd}`,
    modifiedNotes,
    newNotes,
    openTodos,
    completedTodos,
    activeProjects,
  }
}
