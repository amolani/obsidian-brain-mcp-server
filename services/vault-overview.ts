import { basename, dirname } from 'node:path'
import type { NoteEntry } from '../vault.ts'

export interface VaultStats {
  totalNotes: number
  notesByFolder: Record<string, number>
  allTags: Record<string, number>
  recentlyModified: { path: string; title: string; date: string }[]
  orphanNotes: { path: string; title: string }[]
  openTodoCount: number
  staleNotes: { path: string; title: string; lastModified: string; daysAgo: number }[]
}

const STALE_THRESHOLD_MS = 180 * 24 * 60 * 60 * 1000

export function buildVaultOverview(
  notes: Map<string, NoteEntry>,
  linkIndex: Map<string, Set<string>>,
  now: number = Date.now()
): VaultStats {
  const notesByFolder: Record<string, number> = {}
  const allTags: Record<string, number> = {}
  let openTodoCount = 0

  for (const [, entry] of notes) {
    const folder = dirname(entry.relativePath)
    const topFolder = folder === '.' ? '(root)' : folder.split('/')[0]
    notesByFolder[topFolder] = (notesByFolder[topFolder] ?? 0) + 1

    for (const tag of entry.tags) {
      allTags[tag] = (allTags[tag] ?? 0) + 1
    }

    openTodoCount += entry.todos.filter(todo => !todo.done).length
  }

  const recentlyModified = [...notes.values()]
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 10)
    .map(entry => ({
      path: entry.relativePath,
      title: entry.title,
      date: new Date(entry.lastModified).toISOString().split('T')[0],
    }))

  const orphanNotes: { path: string; title: string }[] = []
  for (const [relativePath, entry] of notes) {
    if (linkIndex.has(relativePath) && linkIndex.get(relativePath)!.size > 0) continue
    if (entry.title === 'Dashboard') continue
    orphanNotes.push({ path: relativePath, title: entry.title })
  }

  const staleNotes: { path: string; title: string; lastModified: string; daysAgo: number }[] = []
  for (const [relativePath, entry] of notes) {
    if (entry.frontmatter?.status !== 'aktiv') continue
    if (relativePath.startsWith('Archiv/') || relativePath.startsWith('Daily/')) continue
    if (basename(relativePath, '.md') === '_MOC') continue

    const age = now - entry.lastModified
    if (age > STALE_THRESHOLD_MS) {
      staleNotes.push({
        path: relativePath,
        title: entry.title,
        lastModified: new Date(entry.lastModified).toISOString().split('T')[0],
        daysAgo: Math.floor(age / (24 * 60 * 60 * 1000)),
      })
    }
  }
  staleNotes.sort((a, b) => b.daysAgo - a.daysAgo)

  return {
    totalNotes: notes.size,
    notesByFolder,
    allTags,
    recentlyModified,
    orphanNotes,
    openTodoCount,
    staleNotes,
  }
}
