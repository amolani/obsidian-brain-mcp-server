import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { safeGeneratedSnippet, isSensitiveGeneratedSource } from './generated-surface-redaction.ts'
import { isActiveNote, isGeneratedCustomerSurface } from './note-scope.ts'
import { assertCanWriteTool } from './policy.ts'
import { sanitizePathSegment, vaultJoin } from './vault-paths.ts'

export interface BuildCustomerSnapshotOptions {
  client: string
  dryRun?: boolean
}

export interface CustomerSnapshotResult {
  dryRun: boolean
  client: string
  path: string
  noteCount: number
  todoCount: number
  decisionCount: number
  riskCount: number
  runbookCount: number
  questionCount: number
  content: string
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function notesForClient(vault: Vault, client: string): NoteEntry[] {
  const lower = client.toLowerCase()
  return [...vault.notes.values()].filter(note =>
    isActiveNote(note)
      && !isGeneratedCustomerSurface(note)
      && (note.relativePath.toLowerCase().startsWith(`kunden/${lower}/`)
        || String(note.frontmatter.kunde ?? '').toLowerCase() === lower
        || note.tags.includes(lower)
        || note.tags.includes(`kunde/${lower}`)),
  )
}

function links(notes: NoteEntry[], limit = 10): string {
  return notes.slice(0, limit).map(note => `- [[${note.relativePath}|${note.title}]]`).join('\n') || '- Keine Einträge'
}

function contentLines(notes: NoteEntry[], pattern: RegExp, limit = 12): string {
  const lines: string[] = []
  const redactedSources = new Set<string>()
  for (const note of notes) {
    for (const line of note.content.split('\n')) {
      if (!pattern.test(line)) continue
      if (isSnapshotNoiseLine(line)) continue
      if (isSensitiveGeneratedSource(note)) {
        if (redactedSources.has(note.relativePath)) continue
        redactedSources.add(note.relativePath)
        lines.push(`- ${safeGeneratedSnippet(note, '')} ([[${note.relativePath}|${note.title}]])`)
      } else {
        lines.push(`- ${safeGeneratedSnippet(note, line.replace(/^[-*#\s]+/, '').trim())} ([[${note.relativePath}|${note.title}]])`)
      }
      if (lines.length >= limit) return lines.join('\n')
    }
  }
  return lines.join('\n') || '- Keine Einträge'
}

function isSnapshotNoiseLine(line: string): boolean {
  const trimmed = line.replace(/^[-*#\s>\d.]+/, '').trim()
  return /^(ich|du|wir)\b/i.test(trimmed)
    || /^(ok|okay|okey|alles klar|verstanden|nicht ganz|hier|sag|sobald|wenn|bitte|alternativ|kopier|kopiere|führe|fuehre|prüfe|pruefe)\b/i.test(trimmed)
    || /^(bereinigungsnotiz|diese seite wurde nachträglich kuratiert|diese seite wurde nachtraeglich kuratiert)\b/i.test(trimmed)
    || /\b(sag bescheid|ich warte|ich melde mich|willst du|kannst du|soll ich)\b/i.test(trimmed)
    || /\b(rohfassung wurde archiviert|rohprotokoll enthielt)\b/i.test(trimmed)
    || /^\(?\d+\s+Befehle,?\s+mit Fehler-Workaround\)?\*?$/i.test(trimmed)
}

export function buildCustomerSnapshot(vault: Vault, options: BuildCustomerSnapshotOptions): CustomerSnapshotResult {
  const dryRun = options.dryRun ?? true
  const client = sanitizePathSegment(options.client.trim())
  if (!client) throw new Error('client ist erforderlich')
  const notes = notesForClient(vault, client)
  const todos = notes.flatMap(note => note.todos.filter(todo => !todo.done).map(todo => ({ note, todo })))
  const decisions = notes.filter(note => note.tags.includes('decision') || /entscheidung/i.test(note.title))
  const runbooks = notes.filter(note => note.tags.includes('runbook') || /runbook/i.test(note.title))
  const questions = vault.listOpenQuestions().filter(q => q.path.toLowerCase().includes(`kunden/${client.toLowerCase()}/`) || q.context.toLowerCase().includes(client.toLowerCase()))
  const risks = contentLines(notes, /risiko|problem|blocker|fehler|workaround/i)
  const systems = contentLines(notes, /system|server|firewall|proxmox|linuxmuster|docker|opnsense|switch|vlan/i)
  const todoLines = todos.slice(0, 20).map(item => `- [ ] ${safeGeneratedSnippet(item.note, item.todo.text)} ([[${item.note.relativePath}|${item.note.title}]])`).join('\n') || '- Keine offenen TODOs'
  const path = `Kunden/${client}/_snapshot.md`
  const content = `---\nstatus: aktiv\ntags:\n  - snapshot\n  - kunde\nkunde: ${client}\naktualisiert: ${today()}\nquelle: customer-snapshot\n---\n\n# ${client} State Snapshot\n\n## Aktuelle Systeme / Komponenten\n\n${systems}\n\n## Offene TODOs\n\n${todoLines}\n\n## Entscheidungen\n\n${links(decisions)}\n\n## Risiken / bekannte Probleme\n\n${risks}\n\n## Relevante Runbooks\n\n${links(runbooks)}\n\n## Offene Fragen\n\n${questions.slice(0, 12).map(q => `- [${q.type}] [[${q.path}|${q.title}]]`).join('\n') || '- Keine offenen Fragen'}\n\n## Relevante Notizen\n\n${links(notes, 30)}\n`

  if (!dryRun) {
    assertCanWriteTool('build_customer_snapshot', [path])
    const fullPath = vaultJoin(vault.vaultPath, path)
    const existing = vault.notes.get(path)
    if (existsSync(fullPath) && existing && existing.frontmatter.quelle !== 'customer-snapshot') {
      throw new Error(`${path} existiert und ist nicht auto-generiert`)
    }
    mkdirSync(vaultJoin(vault.vaultPath, `Kunden/${client}`), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'build_customer_snapshot',
      mode: 'apply',
      targets: [path],
      summary: `Customer Snapshot für ${client} aktualisiert`,
      meta: { noteCount: notes.length, todoCount: todos.length },
    })
  }

  return {
    dryRun,
    client,
    path,
    noteCount: notes.length,
    todoCount: todos.length,
    decisionCount: decisions.length,
    riskCount: risks === '- Keine Einträge' ? 0 : risks.split('\n').length,
    runbookCount: runbooks.length,
    questionCount: questions.length,
    content,
  }
}
