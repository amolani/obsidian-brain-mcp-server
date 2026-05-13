import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { isActiveNote, isGeneratedCustomerSurfacePath } from './note-scope.ts'
import { assertSafeRelativePath, sanitizePathSegment, vaultJoin } from './vault-paths.ts'

export interface CustomerDashboardOptions {
  dryRun?: boolean
}

export interface CustomerDashboardResult {
  path: string
  client: string
  dryRun: boolean
  noteCount: number
  todoCount: number
  recentCount: number
  runbookCount: number
  captureCount: number
  issueCount: number
  frequentTags: Array<{ tag: string; count: number }>
  content: string
}

interface CustomerNote {
  path: string
  entry: NoteEntry
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function customerPrefix(client: string): string {
  const safeClient = sanitizePathSegment(client)
  if (!safeClient || safeClient !== client) throw new Error(`Ungültiger Kundenname: ${client}`)
  return assertSafeRelativePath(`Kunden/${safeClient}/`)
}

function collectCustomerNotes(vault: Vault, client: string): CustomerNote[] {
  const prefix = customerPrefix(client).toLowerCase()
  return [...vault.notes.entries()]
    .filter(([path, entry]) => isActiveNote(entry) && path.toLowerCase().startsWith(prefix))
    .filter(([path]) => !isGeneratedCustomerSurfacePath(path))
    .map(([path, entry]) => ({ path, entry }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function link(note: CustomerNote): string {
  return `[[${note.path.replace(/\.md$/, '')}|${note.entry.title}]]`
}

function topTags(notes: CustomerNote[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const note of notes) {
    for (const tag of note.entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 12)
}

function recentNotes(notes: CustomerNote[]): CustomerNote[] {
  return [...notes]
    .sort((a, b) => b.entry.lastModified - a.entry.lastModified)
    .slice(0, 8)
}

function openTodos(notes: CustomerNote[]): Array<{ note: CustomerNote; text: string; line: number }> {
  const items: Array<{ note: CustomerNote; text: string; line: number }> = []
  for (const note of notes) {
    for (const todo of note.entry.todos) {
      if (!todo.done) items.push({ note, text: todo.text, line: todo.line })
    }
  }
  return items
}

function isDashboardNoiseLine(line: string): boolean {
  const trimmed = line.replace(/^[-*\s#]+/, '').trim()
  return /^(bereinigungsnotiz|diese seite wurde nachträglich kuratiert|diese seite wurde nachtraeglich kuratiert)\b/i.test(trimmed)
    || /\b(rohfassung wurde archiviert|rohprotokoll enthielt)\b/i.test(trimmed)
}

function knownIssues(notes: CustomerNote[]): Array<{ note: CustomerNote; text: string }> {
  const issues: Array<{ note: CustomerNote; text: string }> = []
  const patterns = [
    /^##\s+(?:Bekannte Probleme|Fehler|Risiken|Offene Punkte)/gim,
    /(?:fehler|problem|workaround|risiko|blocked|blocker)/i,
  ]
  for (const note of notes) {
    if (!patterns.some(pattern => pattern.test(note.entry.content))) continue
    const matchingLines = note.entry.content
      .split('\n')
      .filter(line => /fehler|problem|workaround|risiko|blocked|blocker/i.test(line))
    const lines = matchingLines
      .map(line => line.replace(/^[-*\s#]+/, '').trim())
      .filter(line => !isDashboardNoiseLine(line))
      .filter(line => line.length > 8)
      .slice(0, 2)
    if (lines.length === 0 && matchingLines.length === 0) {
      issues.push({ note, text: note.entry.title })
    } else {
      for (const line of lines) issues.push({ note, text: line })
    }
  }
  return issues.slice(0, 12)
}

function renderDashboard(client: string, notes: CustomerNote[]): CustomerDashboardResult {
  const datum = today()
  const todos = openTodos(notes)
  const recents = recentNotes(notes)
  const runbooks = notes.filter(n => n.entry.tags.includes('runbook') || n.entry.title.toLowerCase().startsWith('runbook'))
  const captures = notes.filter(n => n.entry.tags.includes('auto-capture') || n.entry.frontmatter?.quelle === 'knowledge-harvester')
  const issues = knownIssues(notes)
  const tags = topTags(notes)
  const path = `${customerPrefix(client)}_dashboard.md`

  const noteLines = notes.slice(0, 30).map(note => `- ${link(note)} — ${note.path}`).join('\n') || 'Keine Notizen gefunden.'
  const todoLines = todos.slice(0, 20).map(todo => `- [ ] ${todo.text} (${link(todo.note)}, Zeile ${todo.line})`).join('\n') || 'Keine offenen TODOs.'
  const recentLines = recents.map(note => {
    const date = new Date(note.entry.lastModified).toISOString().split('T')[0]
    return `- ${date} — ${link(note)}`
  }).join('\n') || 'Keine Änderungen.'
  const runbookLines = runbooks.map(link).map(value => `- ${value}`).join('\n') || 'Keine Runbooks gefunden.'
  const captureLines = captures.slice(0, 12).map(link).map(value => `- ${value}`).join('\n') || 'Keine Auto-Captures gefunden.'
  const tagLines = tags.map(t => `- #${t.tag} (${t.count})`).join('\n') || 'Keine Tags.'
  const issueLines = issues.map(issue => `- ${issue.text} (${link(issue.note)})`).join('\n') || 'Keine bekannten Issues erkannt.'

  const content = `---
status: aktiv
tags:
  - dashboard
  - kunde
kunde: ${client}
aktualisiert: ${datum}
quelle: customer-dashboard
---

# ${client} Dashboard

> [!info] Automatisch generiert
> Aktualisiert am ${datum}. Bei Bedarf erneut mit \`build_customer_context\` generieren.

## Überblick

| Bereich | Anzahl |
|---------|--------|
| Notizen | ${notes.length} |
| Offene TODOs | ${todos.length} |
| Runbooks | ${runbooks.length} |
| Auto-Captures | ${captures.length} |
| Erkannte Issues | ${issues.length} |

## Offene TODOs

${todoLines}

## Zuletzt geändert

${recentLines}

## Runbooks

${runbookLines}

## Auto-Captures

${captureLines}

## Bekannte Issues

${issueLines}

## Häufige Tags

${tagLines}

## Relevante Notizen

${noteLines}
`

  return {
    path,
    client,
    dryRun: true,
    noteCount: notes.length,
    todoCount: todos.length,
    recentCount: recents.length,
    runbookCount: runbooks.length,
    captureCount: captures.length,
    issueCount: issues.length,
    frequentTags: tags,
    content,
  }
}

export function buildCustomerDashboard(
  vault: Vault,
  client: string,
  options: CustomerDashboardOptions = {},
): CustomerDashboardResult {
  const dryRun = options.dryRun ?? true
  const notes = collectCustomerNotes(vault, client)
  const result = renderDashboard(client, notes)
  result.dryRun = dryRun

  if (!dryRun) {
    const fullPath = vaultJoin(vault.vaultPath, result.path)
    if (existsSync(fullPath)) {
      const existing = readFileSync(fullPath, 'utf-8')
      if (!/^---[\s\S]*?quelle:\s*customer-dashboard/m.test(existing)) {
        throw new Error(`Dashboard existiert und ist nicht auto-generiert: ${result.path}`)
      }
    }
    mkdirSync(vaultJoin(vault.vaultPath, customerPrefix(client)), { recursive: true })
    writeFileSync(fullPath, result.content, 'utf-8')
    const stat = statSync(fullPath)
    vault.indexNote(fullPath, stat.mtimeMs)
    vault.buildLinkIndex()

    appendActionLog(vault.vaultPath, {
      tool: 'build_customer_context',
      mode: 'apply',
      targets: [result.path],
      summary: `Customer-Dashboard für ${client} erstellt (${result.noteCount} Notizen, ${result.todoCount} TODOs)`,
      meta: {
        client,
        noteCount: result.noteCount,
        todoCount: result.todoCount,
        runbookCount: result.runbookCount,
        captureCount: result.captureCount,
      },
    })
  }

  return result
}
