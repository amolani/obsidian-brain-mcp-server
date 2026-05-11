import type { NoteEntry, Vault } from '../vault.ts'
import { semanticSearch, type SemanticSearchOptions } from './semantic-search.ts'

export interface ContextPackOptions {
  query: string
  maxNotes?: number
  includeLinked?: boolean
  folder?: string
  tags?: string[]
}

export interface ContextPackNote {
  path: string
  title: string
  score: number
  role: 'primary' | 'linked'
  reason: string
  snippet: string
  tags: string[]
  status: string | null
  openTodos: Array<{ text: string; line: number }>
  backlinks: string[]
  outgoingLinks: string[]
}

export interface ContextPack {
  query: string
  generatedAt: string
  provider: 'local-semantic'
  primary: ContextPackNote[]
  linked: ContextPackNote[]
  openTodos: Array<{ path: string; title: string; text: string; line: number }>
  suggestedNextActions: string[]
  citations: string[]
}

function resolvedOutgoing(vault: Vault, entry: NoteEntry): string[] {
  return entry.outgoingLinks
    .map(link => vault.resolveLink(link))
    .filter((path): path is string => !!path)
}

function firstParagraph(content: string): string {
  const paragraph = content
    .replace(/^#\s+.+$/m, '')
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s+/g, ' ').trim())
    .find(p => p.length > 20)
  return paragraph ? paragraph.slice(0, 420) : ''
}

function noteFromEntry(
  vault: Vault,
  path: string,
  entry: NoteEntry,
  role: ContextPackNote['role'],
  score: number,
  reason: string,
  snippet?: string,
): ContextPackNote {
  return {
    path,
    title: entry.title,
    score,
    role,
    reason,
    snippet: snippet || firstParagraph(entry.content) || entry.title,
    tags: entry.tags,
    status: entry.frontmatter.status ?? null,
    openTodos: entry.todos.filter(t => !t.done).map(t => ({ text: t.text, line: t.line })),
    backlinks: [...(vault.linkIndex.get(path) ?? new Set())].slice(0, 8),
    outgoingLinks: resolvedOutgoing(vault, entry).slice(0, 8),
  }
}

function linkedCandidates(vault: Vault, primaryPaths: string[]): Array<{ path: string; reason: string; weight: number }> {
  const weights = new Map<string, { reason: string; weight: number }>()
  const primary = new Set(primaryPaths)

  for (const path of primaryPaths) {
    const entry = vault.notes.get(path)
    if (!entry) continue

    for (const linked of resolvedOutgoing(vault, entry)) {
      if (primary.has(linked)) continue
      const current = weights.get(linked) ?? { reason: `verlinkt von ${path}`, weight: 0 }
      current.weight += 2
      weights.set(linked, current)
    }

    for (const source of vault.linkIndex.get(path) ?? new Set()) {
      if (primary.has(source)) continue
      const current = weights.get(source) ?? { reason: `Backlink auf ${path}`, weight: 0 }
      current.weight += 1
      weights.set(source, current)
    }
  }

  return [...weights.entries()]
    .map(([path, value]) => ({ path, ...value }))
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path))
}

function nextActions(pack: Pick<ContextPack, 'primary' | 'linked' | 'openTodos'>): string[] {
  const actions: string[] = []
  if (pack.primary.length === 0) {
    actions.push('Keine belastbaren Treffer gefunden. Query verfeinern oder relevante Note per vault_search suchen.')
    return actions
  }
  if (pack.openTodos.length > 0) {
    actions.push(`${pack.openTodos.length} offene TODO(s) in den Kontextnoten prüfen.`)
  }
  const lowConnectivity = [...pack.primary, ...pack.linked].filter(n => n.backlinks.length === 0 && n.outgoingLinks.length === 0)
  if (lowConnectivity.length > 0) {
    actions.push(`${lowConnectivity.length} isolierte Note(s) bei Bedarf verlinken.`)
  }
  actions.push('Bei Änderungen bestehende Notes aktualisieren statt neue Duplikate anzulegen.')
  return actions
}

export function buildContextPack(vault: Vault, options: ContextPackOptions): ContextPack {
  const maxNotes = Math.max(1, Math.min(options.maxNotes ?? 5, 12))
  const searchOptions: SemanticSearchOptions = {
    query: options.query,
    limit: maxNotes,
    folder: options.folder,
    tags: options.tags,
    minScore: 8,
  }
  const searchResults = semanticSearch(vault, searchOptions)
  const primary = searchResults
    .map(result => {
      const entry = vault.notes.get(result.path)
      if (!entry) return null
      return noteFromEntry(vault, result.path, entry, 'primary', result.score, result.reasons.join(', '), result.snippet)
    })
    .filter((note): note is ContextPackNote => !!note)

  const linked: ContextPackNote[] = []
  if (options.includeLinked !== false) {
    const candidates = linkedCandidates(vault, primary.map(note => note.path))
    for (const candidate of candidates) {
      if (linked.length >= Math.max(0, maxNotes - primary.length)) break
      const entry = vault.notes.get(candidate.path)
      if (!entry) continue
      if (candidate.path.startsWith('Archiv/')) continue
      linked.push(noteFromEntry(vault, candidate.path, entry, 'linked', candidate.weight * 10, candidate.reason))
    }
  }

  const notes = [...primary, ...linked]
  const openTodos = notes.flatMap(note =>
    note.openTodos.map(todo => ({ path: note.path, title: note.title, text: todo.text, line: todo.line }))
  )
  const pack: ContextPack = {
    query: options.query,
    generatedAt: new Date().toISOString(),
    provider: 'local-semantic',
    primary,
    linked,
    openTodos,
    suggestedNextActions: [],
    citations: notes.map(note => note.path),
  }
  pack.suggestedNextActions = nextActions(pack)
  return pack
}
