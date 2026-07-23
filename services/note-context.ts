import { basename } from 'node:path'
import type { NoteEntry } from '../vault.ts'

export interface NoteContext {
  content: string
  frontmatter: Record<string, any>
  backlinks: { path: string; title: string }[]
  outgoingLinks: { path: string; title: string }[]
  relatedByTags: { path: string; title: string }[]
}

export function findNoteEntry(notes: Map<string, NoteEntry>, pathOrTitle: string): NoteEntry | null {
  let entry = notes.get(pathOrTitle)
  if (entry) return entry

  entry = notes.get(`${pathOrTitle}.md`)
  if (entry) return entry

  const lower = pathOrTitle.toLowerCase()
  for (const [, candidate] of notes) {
    if (
      candidate.title.toLowerCase() === lower ||
      basename(candidate.relativePath, '.md').toLowerCase() === lower
    ) {
      return candidate
    }
  }

  return null
}

export function buildNoteContext(
  notes: Map<string, NoteEntry>,
  linkIndex: Map<string, Set<string>>,
  tagIndex: Map<string, Set<string>>,
  resolveLink: (link: string) => string | null,
  pathOrTitle: string
): NoteContext | null {
  const entry = findNoteEntry(notes, pathOrTitle)
  if (!entry) return null

  const backlinkPaths = linkIndex.get(entry.relativePath) ?? new Set()
  const backlinks = [...backlinkPaths]
    .map(relativePath => notes.get(relativePath))
    .filter((candidate): candidate is NoteEntry => !!candidate)
    .map(candidate => ({ path: candidate.relativePath, title: candidate.title }))

  const outgoingLinks = entry.outgoingLinks
    .map(link => {
      const resolved = resolveLink(link)
      if (!resolved) return null
      const target = notes.get(resolved)
      if (!target) return null
      return { path: target.relativePath, title: target.title }
    })
    .filter((link): link is { path: string; title: string } => !!link)

  const relatedMap = new Map<string, number>()
  for (const tag of entry.tags) {
    const paths = tagIndex.get(tag)
    if (!paths) continue
    for (const relativePath of paths) {
      if (relativePath === entry.relativePath) continue
      if (!notes.has(relativePath)) continue
      relatedMap.set(relativePath, (relatedMap.get(relativePath) ?? 0) + 1)
    }
  }

  const relatedByTags = [...relatedMap.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([relativePath]) => notes.get(relativePath))
    .filter((note): note is NoteEntry => !!note)
    .map(note => ({ path: note.relativePath, title: note.title }))

  return {
    content: entry.content,
    frontmatter: entry.frontmatter,
    backlinks,
    outgoingLinks,
    relatedByTags,
  }
}
