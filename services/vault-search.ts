import type { NoteEntry } from '../vault.ts'
import { sanitizeKnowledgeSurfaceFrontmatter } from './knowledge-surface-sanitizer.ts'

export interface SearchParams {
  query?: string
  tags?: string[]
  folder?: string
  status?: string
}

export interface SearchResult {
  path: string
  title: string
  tags: string[]
  status: string | null
  projekt: string | null
  datum: string | null
  matchCount: number
}

function toResult(path: string, entry: NoteEntry, matchCount: number): SearchResult {
  return {
    path,
    title: entry.title,
    tags: entry.tags,
    status: entry.frontmatter.status ?? null,
    projekt: entry.frontmatter.projekt ?? null,
    datum: entry.frontmatter.datum ?? entry.frontmatter.erstellt ?? null,
    matchCount,
  }
}

function scoreEntry(entry: NoteEntry, query: string): number {
  let score = 0

  if (entry.title.toLowerCase().includes(query)) score += 10
  if (entry.tags.some(tag => tag.includes(query))) score += 5

  const fmStr = JSON.stringify(
    sanitizeKnowledgeSurfaceFrontmatter(entry.frontmatter),
  ).toLowerCase()
  if (fmStr.includes(query)) score += 3

  const contentLower = entry.content.toLowerCase()
  let idx = 0
  while ((idx = contentLower.indexOf(query, idx)) !== -1) {
    score += 1
    idx += query.length
  }

  return score
}

export function searchNotes(notes: Map<string, NoteEntry>, params: SearchParams): SearchResult[] {
  let results: [string, NoteEntry][] = [...notes.entries()]

  if (params.folder) {
    const folder = params.folder.toLowerCase()
    results = results.filter(([path]) => path.toLowerCase().startsWith(folder))
  }

  if (params.tags && params.tags.length > 0) {
    const requiredTags = params.tags.map(tag => tag.toLowerCase())
    results = results.filter(([, entry]) =>
      requiredTags.every(tag => entry.tags.includes(tag))
    )
  }

  if (params.status) {
    const status = params.status.toLowerCase()
    results = results.filter(([, entry]) =>
      String(entry.frontmatter.status ?? '').toLowerCase() === status
    )
  }

  if (params.query) {
    const query = params.query.toLowerCase()
    return results
      .map(([path, entry]) => ({ path, entry, score: scoreEntry(entry, query) }))
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ path, entry, score }) => toResult(path, entry, score))
  }

  return results
    .sort((a, b) => b[1].lastModified - a[1].lastModified)
    .map(([path, entry]) => toResult(path, entry, 0))
}
