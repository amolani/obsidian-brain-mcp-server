import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { isSensitiveGeneratedSource, safeGeneratedSnippet } from './generated-surface-redaction.ts'
import { isActiveNote } from './note-scope.ts'
import { assertCanWriteTool, loadBrainPolicy } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export interface UpdateHotCacheOptions {
  query?: string
  maxNotes?: number
  dryRun?: boolean
}

export interface HotCacheResult {
  dryRun: boolean
  path: string
  query: string
  noteCount: number
  content: string
}

const HOT_CACHE_PATH = 'Knowledge/hot.md'

function isoNow(): string {
  return new Date().toISOString()
}

function renderWithoutQuery(vault: Vault, maxNotes: number): { content: string; noteCount: number } {
  const notes = [...vault.notes.values()]
    .filter(isActiveNote)
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, maxNotes)

  const noteLines = notes.length > 0
    ? notes.map(note => `- [[${note.relativePath}|${note.title}]] - ${note.tags.slice(0, 5).join(', ') || 'keine Tags'}`).join('\n')
    : '- Keine Notizen gefunden'

  const todos = [...vault.notes.values()]
    .filter(isActiveNote)
    .flatMap(note => note.todos.filter(todo => !todo.done).map(todo => ({ note, todo })))
    .slice(0, 12)
  const todoLines = todos.length > 0
    ? todos.map(item => `- [ ] [[${item.note.relativePath}|${item.note.title}]]: ${safeGeneratedSnippet(item.note, item.todo.text)}`).join('\n')
    : '- Keine offenen TODOs gefunden'

  return {
    noteCount: notes.length,
    content: `---\nstatus: aktiv\ntags:\n  - hot-cache\n  - manual-only\naktualisiert: ${isoNow()}\n---\n\n# Hot Cache\n\nManuell aktualisierter Arbeitskontext. Diese Datei wird nicht automatisch in Sessions injiziert.\n\n## Zuletzt geänderte Notizen\n\n${noteLines}\n\n## Offene TODOs\n\n${todoLines}\n`,
  }
}

function renderWithQuery(vault: Vault, query: string, maxNotes: number): { content: string; noteCount: number } {
  const pack = vault.buildContextPack({ query, maxNotes, includeLinked: true })
  const notes = [...pack.primary, ...pack.linked].slice(0, maxNotes)
  const noteLines = notes.length > 0
    ? notes.map(note => `- [[${note.path}|${note.title}]] (Score ${note.score})\n  ${safeGeneratedSnippet(note, note.snippet)}`).join('\n')
    : '- Keine passenden Notizen gefunden'
  const todoLines = pack.openTodos.length > 0
    ? pack.openTodos.slice(0, 12).map(todo => {
      const source = vault.notes.get(todo.path)
      const text = source ? safeGeneratedSnippet(source, todo.text) : todo.text
      return `- [ ] [[${todo.path}]]: ${text}`
    }).join('\n')
    : '- Keine offenen TODOs im Kontext'
  const actionLines = pack.suggestedNextActions.length > 0
    ? pack.suggestedNextActions.map(action => `- ${action}`).join('\n')
    : '- Keine Vorschläge'
  const hiddenCount = notes.filter(isSensitiveGeneratedSource).length
  const redactionNotice = hiddenCount > 0
    ? `\n\n> [!warning] Sensitive snippets hidden\n> ${hiddenCount} Treffer stammen aus Zugangsdaten/Credential-Notizen. Links bleiben sichtbar; Inhalte werden in generierten Surfaces nicht ausgeschrieben.\n`
    : ''

  return {
    noteCount: notes.length,
    content: `---\nstatus: aktiv\ntags:\n  - hot-cache\n  - manual-only\naktualisiert: ${isoNow()}\nquery: ${query}\n---\n\n# Hot Cache: ${query}\n\nManuell aktualisierter Arbeitskontext. Diese Datei wird nicht automatisch in Sessions injiziert.${redactionNotice}\n\n## Relevante Notizen\n\n${noteLines}\n\n## Offene TODOs\n\n${todoLines}\n\n## Nächste sinnvolle Aktionen\n\n${actionLines}\n`,
  }
}

export function updateHotCache(vault: Vault, options: UpdateHotCacheOptions = {}): HotCacheResult {
  const policy = loadBrainPolicy()
  if (policy.workingMemory.mode === 'disabled') {
    throw new Error('Working Memory ist laut brain-policy.json deaktiviert')
  }

  const dryRun = options.dryRun ?? true
  const maxNotes = Math.max(1, Math.min(options.maxNotes ?? 8, 20))
  const query = options.query?.trim() ?? ''
  const rendered = query ? renderWithQuery(vault, query, maxNotes) : renderWithoutQuery(vault, maxNotes)

  if (!dryRun) {
    assertCanWriteTool('update_hot_cache', [HOT_CACHE_PATH])
    const fullPath = vaultJoin(vault.vaultPath, HOT_CACHE_PATH)
    mkdirSync(vaultJoin(vault.vaultPath, 'Knowledge'), { recursive: true })
    writeFileSync(fullPath, rendered.content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'update_hot_cache',
      mode: 'apply',
      targets: [HOT_CACHE_PATH],
      summary: query ? `Hot Cache aktualisiert für: ${query}` : 'Hot Cache aus aktueller Vault-Aktivität aktualisiert',
      meta: { query: query || null, noteCount: rendered.noteCount },
    })
  }

  return {
    dryRun,
    path: HOT_CACHE_PATH,
    query,
    noteCount: rendered.noteCount,
    content: rendered.content,
  }
}

export function readHotCache(vault: Vault): HotCacheResult {
  const fullPath = vaultJoin(vault.vaultPath, HOT_CACHE_PATH)
  const content = existsSync(fullPath)
    ? readFileSync(fullPath, 'utf-8')
    : '# Hot Cache\n\nNoch nicht angelegt. Nutze `update_hot_cache` mit `dry_run=false`, um ihn manuell zu schreiben.\n'
  return {
    dryRun: false,
    path: HOT_CACHE_PATH,
    query: '',
    noteCount: 0,
    content,
  }
}
