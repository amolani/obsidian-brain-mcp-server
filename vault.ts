import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, watch, renameSync, unlinkSync } from 'node:fs'
import { join, relative, basename, dirname, extname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { classifyNote } from './technik-categories.ts'
import { loadClients, loadTechTerms } from './config.ts'
import { findDuplicates as findDuplicatesService, type DuplicateMatch } from './services/duplicate-analyzer.ts'
import { findBrokenLinks as findBrokenLinksService, fixBrokenLinks as fixBrokenLinksService, type BrokenLink } from './services/broken-link-analyzer.ts'
import { lintFrontmatter as lintFrontmatterService, fixFrontmatter as fixFrontmatterService, type LintIssue } from './services/frontmatter-linter.ts'
import { generateMocs as generateMocsService, type MocResult } from './services/moc-generator.ts'
import { runMaintenance as runMaintenanceService, type MaintenanceReport } from './services/review-queue-builder.ts'

// Re-export service types so existing consumers (server.ts) keep working.
export type { BrokenLink, LintIssue, MocResult, MaintenanceReport, DuplicateMatch }

// ── Types ──────────────────────────────────────────────────────────────

export interface NoteEntry {
  path: string
  relativePath: string
  title: string
  frontmatter: Record<string, any>
  tags: string[]
  outgoingLinks: string[]
  todos: { text: string; done: boolean; line: number }[]
  lastModified: number
  content: string
}

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

export interface NoteContext {
  content: string
  frontmatter: Record<string, any>
  backlinks: { path: string; title: string }[]
  outgoingLinks: { path: string; title: string }[]
  relatedByTags: { path: string; title: string }[]
}

export interface VaultStats {
  totalNotes: number
  notesByFolder: Record<string, number>
  allTags: Record<string, number>
  recentlyModified: { path: string; title: string; date: string }[]
  orphanNotes: { path: string; title: string }[]
  openTodoCount: number
  staleNotes: { path: string; title: string; lastModified: string; daysAgo: number }[]
}

export interface TodoItem {
  file: string
  title: string
  todos: { text: string; line: number; done: boolean }[]
}

// ── Templates ──────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().split('T')[0]
}

const TEMPLATES: Record<string, (title: string, tags: string[]) => string> = {
  kunde: (title, tags) =>
    `---
projekt: ${title}
status: aktiv
tags:
${tags.map(t => `  - ${t}`).join('\n')}
datum: ${today()}
---

# ${title}

## Übersicht

## Zugangsdaten

## Notizen
`,

  referenz: (title, tags) =>
    `---
status: aktiv
tags:
${tags.map(t => `  - ${t}`).join('\n')}
datum: ${today()}
---

# ${title}

## Beschreibung

## Befehle

## Links
`,

  troubleshooting: (title, tags) =>
    `---
status: aktiv
tags:
  - troubleshooting
${tags.map(t => `  - ${t}`).join('\n')}
datum: ${today()}
---

# ${title}

## Problem

## Ursache

## Lösung

## Prävention
`,

  learning: (title, tags) =>
    `---
status: aktiv
tags:
  - learning
${tags.map(t => `  - ${t}`).join('\n')}
datum: ${today()}
---

# ${title}

## Was

## Warum

## Wie

## Quellen
`,

  daily: (title, tags) =>
    `---
tags:
  - daily
datum: ${today()}
---

# ${today()}

## Aufgaben

- [ ]

## Notizen

## Gelernt
`,
}

// ── Known entities for auto-categorization ─────────────────────────────
// Clients and tech-terms are loaded from config.ts (clients.json, tech-terms.json).

const SECURITY_KEYWORDS = [
  'vulnerability', 'schwachstelle', 'sicherheit', 'cve', 'befund',
  'exploit', 'angriff', 'attack', 'risk', 'risiko', 'breach',
]

// ── Vault Class ────────────────────────────────────────────────────────

export class Vault {
  // State fields exposed for service modules in ./services/.
  // Not part of the public MCP API — external callers go through methods.
  readonly vaultPath: string
  readonly notes: Map<string, NoteEntry> = new Map()
  readonly linkIndex: Map<string, Set<string>> = new Map() // target → sources (backlinks)
  private tagIndex: Map<string, Set<string>> = new Map()
  private watcher: ReturnType<typeof watch> | null = null

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath
  }

  async init(): Promise<void> {
    this.scanVault()
    this.startWatcher()
    process.stderr.write(`obsidian-brain: indexed ${this.notes.size} notes\n`)
  }

  shutdown(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }

  // ── Scanning ───────────────────────────────────────────────────────

  private scanVault(): void {
    this.notes.clear()
    this.tagIndex.clear()
    this.linkIndex.clear()

    // Pass 1: scan all files, build notes + tag index
    this.scanDirectory(this.vaultPath)

    // Pass 2: resolve links now that ALL notes are indexed
    this.buildLinkIndex()
  }

  buildLinkIndex(): void {
    this.linkIndex.clear()
    for (const [relativePath, entry] of this.notes) {
      for (const link of entry.outgoingLinks) {
        const resolved = this.resolveLink(link)
        if (resolved) {
          if (!this.linkIndex.has(resolved)) this.linkIndex.set(resolved, new Set())
          this.linkIndex.get(resolved)!.add(relativePath)
        }
      }
    }
  }

  private scanDirectory(dir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue // skip .obsidian, .trash etc
      const fullPath = join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        this.scanDirectory(fullPath)
      } else if (extname(entry) === '.md') {
        this.indexNote(fullPath, stat.mtimeMs)
      }
    }
  }

  indexNote(fullPath: string, mtimeMs: number): void {
    let raw: string
    try {
      raw = readFileSync(fullPath, 'utf-8')
    } catch {
      return
    }

    const relativePath = relative(this.vaultPath, fullPath)
    const frontmatter = this.parseFrontmatter(raw)
    const content = this.stripFrontmatter(raw)
    const title = this.extractTitle(content, fullPath)
    const tags = this.extractTags(frontmatter, content)
    const outgoingLinks = this.extractLinks(content)
    const todos = this.extractTodos(content)

    const entry: NoteEntry = {
      path: fullPath,
      relativePath,
      title,
      frontmatter,
      tags,
      outgoingLinks,
      todos,
      lastModified: mtimeMs,
      content,
    }

    this.notes.set(relativePath, entry)

    // Update tag index
    for (const tag of tags) {
      if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set())
      this.tagIndex.get(tag)!.add(relativePath)
    }

    // Note: link index is built in buildLinkIndex() after all notes are scanned
  }

  private removeFromIndex(relativePath: string): void {
    const entry = this.notes.get(relativePath)
    if (!entry) return

    // Remove from tag index
    for (const tag of entry.tags) {
      this.tagIndex.get(tag)?.delete(relativePath)
      if (this.tagIndex.get(tag)?.size === 0) this.tagIndex.delete(tag)
    }

    // Remove from link index
    for (const link of entry.outgoingLinks) {
      const resolved = this.resolveLink(link)
      if (resolved) {
        this.linkIndex.get(resolved)?.delete(relativePath)
        if (this.linkIndex.get(resolved)?.size === 0) this.linkIndex.delete(resolved)
      }
    }

    this.notes.delete(relativePath)
  }

  // ── Parsing ────────────────────────────────────────────────────────

  private parseFrontmatter(raw: string): Record<string, any> {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return {}
    try {
      return parseYaml(match[1]) ?? {}
    } catch {
      return {}
    }
  }

  private stripFrontmatter(raw: string): string {
    return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  }

  private extractTitle(content: string, fullPath: string): string {
    const match = content.match(/^#\s+(.+)$/m)
    if (match) return match[1].trim()
    return basename(fullPath, '.md')
  }

  private extractTags(frontmatter: Record<string, any>, content: string): string[] {
    const tags = new Set<string>()

    // From frontmatter
    if (Array.isArray(frontmatter.tags)) {
      for (const t of frontmatter.tags) {
        if (typeof t === 'string') tags.add(t.toLowerCase())
      }
    }

    // Inline #tags from content
    const inlineTags = content.matchAll(/(^|\s)#([a-zA-ZäöüÄÖÜß][\w/äöüÄÖÜß-]*)/g)
    for (const m of inlineTags) {
      tags.add(m[2].toLowerCase())
    }

    return [...tags]
  }

  private extractLinks(content: string): string[] {
    const links: string[] = []
    // Handle both [[target|alias]] and [[target\|alias]] (escaped pipe in tables)
    const matches = content.matchAll(/\[\[([^\]]+?)\]\]/g)
    for (const m of matches) {
      let raw = m[1]
      // Split on | or \| to get target (first part)
      const pipeIdx = raw.search(/\\?\|/)
      if (pipeIdx !== -1) raw = raw.substring(0, pipeIdx)
      const target = raw.trim()
      if (target && !target.startsWith('!')) links.push(target)
    }
    return links
  }

  private extractTodos(content: string): { text: string; done: boolean; line: number }[] {
    const todos: { text: string; done: boolean; line: number }[] = []
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^[\s]*- \[([ xX])\]\s+(.+)/)
      if (match) {
        todos.push({
          text: match[2].trim(),
          done: match[1] !== ' ',
          line: i + 1,
        })
      }
    }
    return todos
  }

  // ── Link Resolution ────────────────────────────────────────────────

  resolveLink(link: string): string | null {
    // Try exact relative path match (with .md)
    const withMd = link.endsWith('.md') ? link : `${link}.md`
    if (this.notes.has(withMd)) return withMd

    // Try without .md
    if (this.notes.has(link)) return link

    // If no slash, match by filename
    if (!link.includes('/')) {
      const target = `${link}.md`
      for (const [relPath] of this.notes) {
        if (basename(relPath) === target || basename(relPath, '.md') === link) {
          return relPath
        }
      }
      // Case-insensitive fallback
      const lower = link.toLowerCase()
      for (const [relPath] of this.notes) {
        if (basename(relPath, '.md').toLowerCase() === lower) {
          return relPath
        }
      }
    }

    return null
  }

  // ── File Watcher ───────────────────────────────────────────────────

  private startWatcher(): void {
    try {
      this.watcher = watch(this.vaultPath, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith('.md')) return
        if (filename.startsWith('.')) return

        const fullPath = join(this.vaultPath, filename)
        const relativePath = filename

        // Remove old entry first
        this.removeFromIndex(relativePath)

        // Re-index if file still exists
        try {
          const stat = statSync(fullPath)
          this.indexNote(fullPath, stat.mtimeMs)
        } catch {
          // File was deleted, already removed from index
        }

        // Rebuild link index (links may have changed)
        this.buildLinkIndex()
      })
    } catch (err) {
      process.stderr.write(`obsidian-brain: watcher failed: ${err}\n`)
    }
  }

  // ── Public API: Search ─────────────────────────────────────────────

  search(params: SearchParams): SearchResult[] {
    let results: [string, NoteEntry][] = [...this.notes.entries()]

    // Filter by folder
    if (params.folder) {
      const folder = params.folder.toLowerCase()
      results = results.filter(([rel]) => rel.toLowerCase().startsWith(folder))
    }

    // Filter by tags (must have ALL)
    if (params.tags && params.tags.length > 0) {
      const requiredTags = params.tags.map(t => t.toLowerCase())
      results = results.filter(([, entry]) =>
        requiredTags.every(t => entry.tags.includes(t))
      )
    }

    // Filter by status
    if (params.status) {
      const status = params.status.toLowerCase()
      results = results.filter(([, entry]) =>
        String(entry.frontmatter.status ?? '').toLowerCase() === status
      )
    }

    // Full-text search + scoring
    if (params.query) {
      const query = params.query.toLowerCase()
      const scored: { rel: string; entry: NoteEntry; score: number }[] = []

      for (const [rel, entry] of results) {
        let score = 0

        // Title match (highest weight)
        if (entry.title.toLowerCase().includes(query)) score += 10

        // Tag match
        if (entry.tags.some(t => t.includes(query))) score += 5

        // Frontmatter match
        const fmStr = JSON.stringify(entry.frontmatter).toLowerCase()
        if (fmStr.includes(query)) score += 3

        // Content match
        const contentLower = entry.content.toLowerCase()
        let idx = 0
        while ((idx = contentLower.indexOf(query, idx)) !== -1) {
          score += 1
          idx += query.length
        }

        if (score > 0) scored.push({ rel, entry, score })
      }

      scored.sort((a, b) => b.score - a.score)
      return scored.map(({ rel, entry, score }) => ({
        path: rel,
        title: entry.title,
        tags: entry.tags,
        status: entry.frontmatter.status ?? null,
        projekt: entry.frontmatter.projekt ?? null,
        datum: entry.frontmatter.datum ?? entry.frontmatter.erstellt ?? null,
        matchCount: score,
      }))
    }

    // No query - return all filtered, sorted by lastModified
    results.sort((a, b) => b[1].lastModified - a[1].lastModified)
    return results.map(([rel, entry]) => ({
      path: rel,
      title: entry.title,
      tags: entry.tags,
      status: entry.frontmatter.status ?? null,
      projekt: entry.frontmatter.projekt ?? null,
      datum: entry.frontmatter.datum ?? entry.frontmatter.erstellt ?? null,
      matchCount: 0,
    }))
  }

  // ── Public API: Note Context ───────────────────────────────────────

  getNoteContext(pathOrTitle: string): NoteContext | null {
    // Find the note
    let entry = this.notes.get(pathOrTitle)

    // Try with .md
    if (!entry) entry = this.notes.get(pathOrTitle + '.md')

    // Try by title or filename
    if (!entry) {
      const lower = pathOrTitle.toLowerCase()
      for (const [, e] of this.notes) {
        if (e.title.toLowerCase() === lower || basename(e.relativePath, '.md').toLowerCase() === lower) {
          entry = e
          break
        }
      }
    }

    if (!entry) return null

    // Backlinks
    const backlinkPaths = this.linkIndex.get(entry.relativePath) ?? new Set()
    const backlinks = [...backlinkPaths]
      .map(rel => this.notes.get(rel))
      .filter((e): e is NoteEntry => !!e)
      .map(e => ({ path: e.relativePath, title: e.title }))

    // Outgoing links (resolved)
    const outgoingLinks = entry.outgoingLinks
      .map(link => {
        const resolved = this.resolveLink(link)
        if (!resolved) return null
        const target = this.notes.get(resolved)
        if (!target) return null
        return { path: target.relativePath, title: target.title }
      })
      .filter((l): l is { path: string; title: string } => !!l)

    // Related by tags (share at least 2 tags, excluding self)
    const relatedMap = new Map<string, number>()
    for (const tag of entry.tags) {
      const paths = this.tagIndex.get(tag)
      if (!paths) continue
      for (const p of paths) {
        if (p === entry.relativePath) continue
        relatedMap.set(p, (relatedMap.get(p) ?? 0) + 1)
      }
    }
    const relatedByTags = [...relatedMap.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([rel]) => {
        const n = this.notes.get(rel)!
        return { path: n.relativePath, title: n.title }
      })

    return {
      content: entry.content,
      frontmatter: entry.frontmatter,
      backlinks,
      outgoingLinks,
      relatedByTags,
    }
  }

  // ── Public API: Create Note ────────────────────────────────────────

  createNote(
    title: string,
    template: string,
    content?: string,
    tags?: string[],
    folder?: string
  ): { path: string } {
    const templateFn = TEMPLATES[template]
    if (!templateFn) throw new Error(`Unknown template: ${template}`)

    // Determine folder
    let targetFolder: string
    if (folder) {
      targetFolder = folder
    } else {
      switch (template) {
        case 'kunde':
          targetFolder = `Kunden/${title}`
          break
        case 'referenz':
        case 'learning':
          targetFolder = 'Referenz'
          break
        case 'troubleshooting':
          targetFolder = 'Referenz'
          break
        case 'daily':
          targetFolder = 'Daily'
          break
        default:
          targetFolder = 'Inbox'
      }
    }

    const allTags = tags ?? []
    let noteContent = templateFn(title, allTags)

    // Append custom content after template
    if (content) {
      noteContent = noteContent.trimEnd() + '\n\n' + content + '\n'
    }

    const fileName = template === 'daily' ? `${today()}.md` : `${title}.md`
    const fullDir = join(this.vaultPath, targetFolder)
    const fullPath = join(fullDir, fileName)

    mkdirSync(fullDir, { recursive: true })
    writeFileSync(fullPath, noteContent, 'utf-8')

    // Index the new note
    const stat = statSync(fullPath)
    this.indexNote(fullPath, stat.mtimeMs)

    return { path: relative(this.vaultPath, fullPath) }
  }

  // ── Public API: Capture ────────────────────────────────────────────

  capture(
    content: string,
    category?: string
  ): { path: string; title: string; tags: string[]; folder: string } {
    const contentLower = content.toLowerCase()

    // Auto-detect title from first line or first sentence
    const lines = content.split('\n')
    const firstLine = lines[0].replace(/^#+\s*/, '').trim()
    const title = firstLine.length > 60 ? firstLine.substring(0, 57) + '...' : firstLine

    // Remove title line from content body to avoid duplication
    const bodyLines = lines.slice(1)
    // Also strip leading empty lines after title
    while (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift()
    const body = bodyLines.join('\n')

    // Auto-detect tags
    const autoTags: string[] = []
    for (const term of loadTechTerms()) {
      if (contentLower.includes(term)) autoTags.push(term)
    }

    // Auto-detect client
    let detectedClient: string | null = null
    for (const [key, name] of Object.entries(loadClients())) {
      if (contentLower.includes(key)) {
        detectedClient = name
        autoTags.push(`kunde/${key}`)
        break
      }
    }

    // Auto-detect folder
    let folder: string
    if (category) {
      switch (category.toLowerCase()) {
        case 'kunde':
          folder = detectedClient ? `Kunden/${detectedClient}` : 'Kunden'
          break
        case 'referenz':
          folder = 'Referenz'
          break
        case 'sicherheit':
          folder = 'Sicherheit'
          break
        case 'persönlich':
        case 'persoenlich':
          folder = 'Persönlich'
          break
        default:
          folder = 'Inbox'
      }
    } else if (detectedClient) {
      folder = `Kunden/${detectedClient}`
    } else if (SECURITY_KEYWORDS.some(kw => contentLower.includes(kw))) {
      folder = 'Sicherheit'
      autoTags.push('sicherheit')
    } else {
      folder = 'Inbox'
    }

    // Build the note
    const datum = today()
    const tagBlock = autoTags.length > 0
      ? autoTags.map(t => `  - ${t}`).join('\n')
      : '  - inbox'

    const noteContent = `---
status: aktiv
tags:
${tagBlock}
datum: ${datum}
---

# ${title}

${body}
`

    const fileName = `${title.replace(/[/\\:*?"<>|]/g, '-')}.md`
    const fullDir = join(this.vaultPath, folder)
    const fullPath = join(fullDir, fileName)

    mkdirSync(fullDir, { recursive: true })
    writeFileSync(fullPath, noteContent, 'utf-8')

    const stat = statSync(fullPath)
    this.indexNote(fullPath, stat.mtimeMs)

    return {
      path: relative(this.vaultPath, fullPath),
      title,
      tags: autoTags.length > 0 ? autoTags : ['inbox'],
      folder,
    }
  }

  // ── Public API: Vault Overview ─────────────────────────────────────

  getOverview(): VaultStats {
    const notesByFolder: Record<string, number> = {}
    const allTags: Record<string, number> = {}
    let openTodoCount = 0

    for (const [, entry] of this.notes) {
      // Count by folder
      const folder = dirname(entry.relativePath)
      const topFolder = folder === '.' ? '(root)' : folder.split('/')[0]
      notesByFolder[topFolder] = (notesByFolder[topFolder] ?? 0) + 1

      // Count tags
      for (const tag of entry.tags) {
        allTags[tag] = (allTags[tag] ?? 0) + 1
      }

      // Count open todos
      openTodoCount += entry.todos.filter(t => !t.done).length
    }

    // Recently modified (top 10)
    const sorted = [...this.notes.values()]
      .sort((a, b) => b.lastModified - a.lastModified)
      .slice(0, 10)
    const recentlyModified = sorted.map(e => ({
      path: e.relativePath,
      title: e.title,
      date: new Date(e.lastModified).toISOString().split('T')[0],
    }))

    // Orphan notes (no incoming links)
    const allLinkedTargets = new Set<string>()
    for (const [, sources] of this.linkIndex) {
      if (sources.size > 0) {
        // The key itself is the target
      }
    }
    const orphanNotes: { path: string; title: string }[] = []
    for (const [rel, entry] of this.notes) {
      if (!this.linkIndex.has(rel) || this.linkIndex.get(rel)!.size === 0) {
        // Dashboard is expected to have no backlinks
        if (entry.title !== 'Dashboard') {
          orphanNotes.push({ path: rel, title: entry.title })
        }
      }
    }

    // Stale notes: status:aktiv but last modified > 180 days ago
    const STALE_THRESHOLD_MS = 180 * 24 * 60 * 60 * 1000
    const now = Date.now()
    const staleNotes: { path: string; title: string; lastModified: string; daysAgo: number }[] = []
    for (const [rel, entry] of this.notes) {
      if (entry.frontmatter?.status !== 'aktiv') continue
      if (rel.startsWith('Archiv/') || rel.startsWith('Daily/')) continue
      if (basename(rel, '.md') === '_MOC') continue

      const age = now - entry.lastModified
      if (age > STALE_THRESHOLD_MS) {
        staleNotes.push({
          path: rel,
          title: entry.title,
          lastModified: new Date(entry.lastModified).toISOString().split('T')[0],
          daysAgo: Math.floor(age / (24 * 60 * 60 * 1000)),
        })
      }
    }
    staleNotes.sort((a, b) => b.daysAgo - a.daysAgo)

    return {
      totalNotes: this.notes.size,
      notesByFolder,
      allTags,
      recentlyModified,
      orphanNotes,
      openTodoCount,
      staleNotes,
    }
  }

  // ── Public API: Todo List ──────────────────────────────────────────

  getTodoList(folder?: string): TodoItem[] {
    const items: TodoItem[] = []

    for (const [rel, entry] of this.notes) {
      if (folder && !rel.toLowerCase().startsWith(folder.toLowerCase())) continue

      const openTodos = entry.todos.filter(t => !t.done)
      if (openTodos.length > 0) {
        items.push({
          file: rel,
          title: entry.title,
          todos: openTodos,
        })
      }
    }

    // Sort by number of open todos (most first)
    items.sort((a, b) => b.todos.length - a.todos.length)
    return items
  }

  // ── Public API: Suggest Links ──────────────────────────────────────

  suggestLinks(): { source: string; mention: string; target: string; targetTitle: string }[] {
    const suggestions: { source: string; mention: string; target: string; targetTitle: string }[] = []

    // Build a map of note titles/filenames to match against
    const titleToPath = new Map<string, string>()
    for (const [rel, entry] of this.notes) {
      const name = basename(rel, '.md').toLowerCase()
      // Only suggest links for notes with meaningful titles (>3 chars)
      if (name.length > 3 && name !== 'notizen' && name !== 'zugangsdaten' && name !== 'todos' && name !== 'pw') {
        titleToPath.set(name, rel)
      }
      if (entry.title.length > 3 && entry.title.toLowerCase() !== name) {
        titleToPath.set(entry.title.toLowerCase(), rel)
      }
    }

    for (const [sourceRel, sourceEntry] of this.notes) {
      const contentLower = sourceEntry.content.toLowerCase()
      const existingTargets = new Set(
        sourceEntry.outgoingLinks.map(l => this.resolveLink(l)).filter(Boolean)
      )

      for (const [searchTerm, targetRel] of titleToPath) {
        // Skip self-references
        if (targetRel === sourceRel) continue
        // Skip if already linked
        if (existingTargets.has(targetRel)) continue
        // Check if the term appears in content
        if (contentLower.includes(searchTerm)) {
          const target = this.notes.get(targetRel)
          if (target) {
            suggestions.push({
              source: sourceRel,
              mention: searchTerm,
              target: targetRel,
              targetTitle: target.title,
            })
          }
        }
      }
    }

    // Deduplicate (same source+target pair)
    const seen = new Set<string>()
    return suggestions.filter(s => {
      const key = `${s.source}→${s.target}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  // ── Public API: Weekly Review ──────────────────────────────────────

  weeklyReview(): {
    period: string
    modifiedNotes: { path: string; title: string; date: string }[]
    newNotes: { path: string; title: string; date: string }[]
    openTodos: number
    completedTodos: number
    activeProjects: { projekt: string; noteCount: number }[]
  } {
    const now = Date.now()
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000
    const weekStart = new Date(weekAgo).toISOString().split('T')[0]
    const weekEnd = new Date(now).toISOString().split('T')[0]

    const modifiedNotes: { path: string; title: string; date: string }[] = []
    const newNotes: { path: string; title: string; date: string }[] = []
    let openTodos = 0
    let completedTodos = 0
    const projectCounts = new Map<string, number>()

    for (const [, entry] of this.notes) {
      const modDate = new Date(entry.lastModified)
      const dateStr = modDate.toISOString().split('T')[0]

      if (entry.lastModified >= weekAgo) {
        modifiedNotes.push({ path: entry.relativePath, title: entry.title, date: dateStr })

        // Check if "created" this week via frontmatter datum
        const datum = entry.frontmatter.datum ?? entry.frontmatter.erstellt
        if (datum && new Date(datum).getTime() >= weekAgo) {
          newNotes.push({ path: entry.relativePath, title: entry.title, date: datum })
        }
      }

      // Count todos
      for (const todo of entry.todos) {
        if (todo.done) completedTodos++
        else openTodos++
      }

      // Track active projects
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

  // ── Public API: Daily Note ─────────────────────────────────────────

  dailyNote(append?: string): { path: string; created: boolean; content: string } {
    const dateStr = today()
    const fileName = `${dateStr}.md`
    const relativePath = `Daily/${fileName}`
    const fullPath = join(this.vaultPath, relativePath)

    let created = false

    // Check if exists
    try {
      const existing = readFileSync(fullPath, 'utf-8')
      if (append) {
        const updated = existing.trimEnd() + '\n\n' + append + '\n'
        writeFileSync(fullPath, updated, 'utf-8')
        const stat = statSync(fullPath)
        this.removeFromIndex(relativePath)
        this.indexNote(fullPath, stat.mtimeMs)
        this.buildLinkIndex()
        return { path: relativePath, created: false, content: updated }
      }
      return { path: relativePath, created: false, content: existing }
    } catch {
      // Create new daily note
      const result = this.createNote(dateStr, 'daily', append)
      created = true
      const content = readFileSync(join(this.vaultPath, result.path), 'utf-8')
      return { path: result.path, created, content }
    }
  }

  // ── Public API: Generate Runbook ───────────────────────────────────

  generateRunbook(
    topic: string,
    outputFolder?: string
  ): { path: string; sourceCount: number; stepCount: number; fixCount: number } {
    // 1. Find all auto-capture notes for this topic
    const topicLower = topic.toLowerCase()
    const sourceNotes: { path: string; title: string; content: string; datum: string }[] = []

    for (const [rel, entry] of this.notes) {
      const isAutoCapture = entry.tags.includes('auto-capture') || entry.tags.includes('prozedur')
      const matchesTopic = rel.toLowerCase().includes(topicLower)
        || entry.title.toLowerCase().includes(topicLower)
        || entry.tags.some(t => t.includes(topicLower))

      if (isAutoCapture && matchesTopic) {
        sourceNotes.push({
          path: rel,
          title: entry.title,
          content: entry.content,
          datum: entry.frontmatter.datum || '',
        })
      }
    }

    // Also search non-auto-capture notes that match
    for (const [rel, entry] of this.notes) {
      if (sourceNotes.some(s => s.path === rel)) continue
      const matchesTopic = rel.toLowerCase().includes(topicLower)
        || entry.title.toLowerCase().includes(topicLower)
      const hasProcedural = entry.content.includes('## Durchgeführte')
        || entry.content.includes('## Fehler')
        || entry.content.includes('## Installationsreihenfolge')
        || (entry.todos.length > 3)

      if (matchesTopic && hasProcedural) {
        sourceNotes.push({
          path: rel,
          title: entry.title,
          content: entry.content,
          datum: entry.frontmatter.datum || '',
        })
      }
    }

    if (sourceNotes.length === 0) {
      throw new Error(`Keine Quell-Notizen für "${topic}" gefunden. Arbeite zuerst am Projekt — der Knowledge Harvester erstellt automatisch Captures.`)
    }

    // Sort by date
    sourceNotes.sort((a, b) => a.datum.localeCompare(b.datum))

    // 2. Extract steps, fixes, and summaries from all sources
    const allSteps: string[] = []
    const allFixes: string[] = []
    const allSummaries: string[] = []
    const seenSteps = new Set<string>()

    for (const note of sourceNotes) {
      // Extract steps
      const stepSection = note.content.match(/## Durchgeführte (?:Befehle|Schritte)\n\n([\s\S]*?)(?=\n## |$)/i)
      if (stepSection) {
        const steps = stepSection[1].split('\n').filter(l => /^\d+\.\s/.test(l))
        for (const step of steps) {
          const cmd = step.replace(/^\d+\.\s*/, '').trim()
          // Dedup by first 60 chars of command
          const key = cmd.slice(0, 60).toLowerCase()
          if (!seenSteps.has(key)) {
            seenSteps.add(key)
            allSteps.push(cmd)
          }
        }
      }

      // Extract fixes
      const fixSection = note.content.match(/## Fehler und Workarounds\n\n([\s\S]*?)(?=\n## |$)/i)
      if (fixSection) {
        const fixes = fixSection[1].split(/### \d+\./).filter(f => f.trim())
        for (const fix of fixes) {
          allFixes.push(fix.trim())
        }
      }

      // Extract summaries
      const summarySection = note.content.match(/## Zusammenfassung\n\n([\s\S]*?)(?=\n## |$)/i)
      if (summarySection) {
        allSummaries.push(summarySection[1].trim())
      }
    }

    // 3. Also pull from non-auto-capture sources (e.g., Installationsplan)
    for (const note of sourceNotes) {
      if (note.content.includes('- [ ]') || note.content.includes('- [x]')) {
        const checklistItems = note.content.split('\n')
          .filter(l => /^\s*\d+\.\s*\[[ x]\]/.test(l))
          .map(l => l.replace(/^\s*\d+\.\s*\[[ x]\]\s*/, '').trim())
        for (const item of checklistItems) {
          if (item.length > 10 && !seenSteps.has(item.slice(0, 60).toLowerCase())) {
            seenSteps.add(item.slice(0, 60).toLowerCase())
            allSteps.push(item)
          }
        }
      }
    }

    // 4. Generate Runbook
    const datum = today()
    const tagBlock = ['runbook', topicLower.replace(/\s+/g, '-')].map(t => `  - ${t}`).join('\n')
    const sourceLinks = sourceNotes.map(s => `- [[${s.path}|${s.title}]]`).join('\n')

    let content = `---
status: aktiv
tags:
${tagBlock}
datum: ${datum}
quellen: ${sourceNotes.length}
---

# Runbook: ${topic}

> [!tip] Automatisch generiert
> Erstellt am ${datum} aus ${sourceNotes.length} Quell-Notizen.
> Bei Änderungen: Quell-Notizen updaten und Runbook neu generieren.

## Quellen

${sourceLinks}
`

    if (allSummaries.length > 0) {
      content += `\n## Übersicht\n\n${allSummaries.slice(-2).join('\n\n')}\n`
    }

    if (allSteps.length > 0) {
      const steps = allSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      content += `\n## Schritte\n\n${steps}\n`
    }

    if (allFixes.length > 0) {
      content += `\n## Bekannte Probleme und Workarounds\n\n`
      for (let i = 0; i < allFixes.length; i++) {
        content += `### ${i + 1}.\n${allFixes[i]}\n\n`
      }
    }

    // 5. Determine output path
    let folder = outputFolder || 'Referenz'
    // Auto-detect Kunden folder
    for (const [key, name] of Object.entries(loadClients())) {
      if (topicLower.includes(key)) {
        folder = `Kunden/${name}`
        break
      }
    }

    const safeTitle = `Runbook ${topic}`.replace(/[/\\:*?"<>|]/g, '-').slice(0, 100)
    const fullDir = join(this.vaultPath, folder)
    const fullPath = join(fullDir, `${safeTitle}.md`)

    mkdirSync(fullDir, { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')

    // Re-index
    const stat = statSync(fullPath)
    this.indexNote(fullPath, stat.mtimeMs)
    this.buildLinkIndex()

    return {
      path: relative(this.vaultPath, fullPath),
      sourceCount: sourceNotes.length,
      stepCount: allSteps.length,
      fixCount: allFixes.length,
    }
  }

  // ── Public API: Organize Referenz into Technik ─────────────────────

  organizeReferenz(dryRun: boolean = false): {
    moved: { from: string; to: string; category: string; reason: string }[]
    skipped: { path: string; reason: string }[]
    dryRun: boolean
  } {
    const moved: { from: string; to: string; category: string; reason: string }[] = []
    const skipped: { path: string; reason: string }[] = []

    for (const [relPath, entry] of this.notes) {
      // Process: (a) Referenz/ flat files and (b) Technik/{cat}/ flat files (for sub-cat refinement)
      let processable = false

      if (relPath.startsWith('Referenz/')) {
        const subpath = relPath.substring('Referenz/'.length)
        if (!subpath.includes('/')) processable = true
      } else if (relPath.startsWith('Technik/')) {
        const parts = relPath.substring('Technik/'.length).split('/')
        // Only re-classify files that are directly in Technik/{cat}/, not already in Technik/{cat}/{sub}/
        if (parts.length === 2) processable = true
      }

      if (!processable) continue

      const classification = classifyNote(entry.title, entry.content, entry.tags)

      if (!classification.category) {
        skipped.push({ path: relPath, reason: 'keine Kategorie zuordenbar' })
        continue
      }

      const categoryPath = classification.subcategory
        ? join('Technik', classification.category, classification.subcategory)
        : join('Technik', classification.category)
      const targetDir = join(this.vaultPath, categoryPath)
      const targetPath = join(targetDir, basename(relPath))
      const targetRel = relative(this.vaultPath, targetPath)

      // Skip if already at target (same path)
      if (targetRel === relPath) continue

      if (!dryRun) {
        mkdirSync(targetDir, { recursive: true })

        // Check if target already exists
        try {
          statSync(targetPath)
          skipped.push({ path: relPath, reason: `Zieldatei existiert bereits: ${targetRel}` })
          continue
        } catch { /* target doesn't exist - good */ }

        // Move file
        try {
          renameSync(entry.path, targetPath)

          // Update index
          this.notes.delete(relPath)
          const stat = statSync(targetPath)
          this.indexNote(targetPath, stat.mtimeMs)
        } catch (err) {
          skipped.push({ path: relPath, reason: `Move failed: ${err}` })
          continue
        }
      }

      moved.push({
        from: relPath,
        to: targetRel,
        category: classification.subcategory
          ? `${classification.category}/${classification.subcategory}`
          : classification.category as string,
        reason: classification.reason,
      })
    }

    if (!dryRun && moved.length > 0) {
      this.buildLinkIndex() // Rebuild backlinks with new paths
    }

    return { moved, skipped, dryRun }
  }

  // ── Public API: Find Duplicates ────────────────────────────────────

  findDuplicates(minScore: number = 40): DuplicateMatch[] {
    return findDuplicatesService(this, minScore)
  }

  // ── Public API: Find & Fix Broken Links ────────────────────────────

  findBrokenLinks(): BrokenLink[] {
    return findBrokenLinksService(this)
  }

  fixBrokenLinks(dryRun: boolean = true) {
    return fixBrokenLinksService(this, dryRun)
  }

  // ── Public API: Lint & Fix Frontmatter ─────────────────────────────

  lintFrontmatter(): LintIssue[] {
    return lintFrontmatterService(this)
  }

  fixFrontmatter(dryRun: boolean = true) {
    return fixFrontmatterService(this, dryRun)
  }

  // ── Public API: Generate MOCs (Maps of Content) ────────────────────

  generateMocs(dryRun: boolean = false, minNotes: number = 2): MocResult[] {
    return generateMocsService(this, dryRun, minNotes)
  }

  // ── Public API: Run Full Maintenance Analysis ──────────────────────

  runMaintenance(): MaintenanceReport {
    return runMaintenanceService(this)
  }
}
