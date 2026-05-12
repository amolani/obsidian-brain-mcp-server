import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { assertCanWriteTool } from './policy.ts'
import { sanitizePathSegment, vaultJoin } from './vault-paths.ts'

export interface BuildMemoryTimelineOptions {
  client: string
  dryRun?: boolean
}

export interface MemoryTimelineEvent {
  date: string
  type: string
  path: string
  title: string
  summary: string
}

export interface MemoryTimelineResult {
  dryRun: boolean
  client: string
  path: string
  eventCount: number
  content: string
}

function dateOf(entry: NoteEntry): string {
  const raw = entry.frontmatter.datum ?? entry.frontmatter.aktualisiert ?? entry.frontmatter.erstellt
  if (typeof raw === 'string' && raw.length >= 10) return raw.slice(0, 10)
  return new Date(entry.lastModified).toISOString().split('T')[0]
}

function kind(entry: NoteEntry): string {
  if (entry.tags.includes('decision')) return 'Entscheidung'
  if (entry.tags.includes('runbook')) return 'Runbook'
  if (entry.tags.includes('auto-capture')) return 'Capture'
  if (entry.tags.includes('claim')) return 'Claim'
  if (/incident|postmortem|troubleshooting/i.test(entry.relativePath + entry.title)) return 'Incident'
  if (entry.todos.some(todo => !todo.done)) return 'Offene Punkte'
  return 'Notiz'
}

function firstLine(entry: NoteEntry): string {
  return entry.content
    .split('\n')
    .map(line => line.replace(/^[-*#\s]+/, '').trim())
    .find(line => line.length >= 20)
    ?.slice(0, 180) ?? entry.title
}

function clientNotes(vault: Vault, client: string): Array<{ path: string; entry: NoteEntry }> {
  const lower = client.toLowerCase()
  return [...vault.notes.entries()].filter(([path, entry]) =>
    path.toLowerCase().startsWith(`kunden/${lower}/`)
      || String(entry.frontmatter.kunde ?? '').toLowerCase() === lower
      || entry.tags.includes(client.toLowerCase())
  ).map(([path, entry]) => ({ path, entry }))
}

export function buildMemoryTimeline(vault: Vault, options: BuildMemoryTimelineOptions): MemoryTimelineResult {
  const dryRun = options.dryRun ?? true
  const client = sanitizePathSegment(options.client.trim())
  if (!client) throw new Error('client ist erforderlich')
  const events: MemoryTimelineEvent[] = clientNotes(vault, client)
    .map(({ path, entry }) => ({
      date: dateOf(entry),
      type: kind(entry),
      path,
      title: entry.title,
      summary: firstLine(entry),
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path))
  const path = `Kunden/${client}/_timeline.md`
  const eventLines = events.length > 0
    ? events.map(event => `- **${event.date}** · ${event.type} · [[${event.path}|${event.title}]]\n  ${event.summary}`).join('\n')
    : '- Keine Ereignisse gefunden'
  const content = `---\nstatus: aktiv\ntags:\n  - timeline\n  - kunde\nkunde: ${client}\naktualisiert: ${new Date().toISOString().split('T')[0]}\nquelle: memory-timeline\n---\n\n# ${client} Memory Timeline\n\n${eventLines}\n`

  if (!dryRun) {
    assertCanWriteTool('build_memory_timeline', [path])
    const fullPath = vaultJoin(vault.vaultPath, path)
    if (existsSync(fullPath)) {
      const existing = vault.notes.get(path)
      if (existing && existing.frontmatter.quelle !== 'memory-timeline') {
        throw new Error(`${path} existiert und ist nicht auto-generiert`)
      }
    }
    mkdirSync(vaultJoin(vault.vaultPath, `Kunden/${client}`), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'build_memory_timeline',
      mode: 'apply',
      targets: [path],
      summary: `Memory Timeline für ${client} aktualisiert (${events.length} Events)`,
      meta: { client, eventCount: events.length },
    })
  }

  return { dryRun, client, path, eventCount: events.length, content }
}
