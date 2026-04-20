#!/usr/bin/env node

// Session Context Hook - SessionStart
// Detects which project you're working in (from CWD) and shows
// relevant knowledge from the Obsidian vault.
// Also ensures the daily note exists.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, renameSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { classifyNote } from '../technik-categories.ts'

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

if (!process.env.VAULT_PATH) {
  console.log(JSON.stringify({ result: 'continue' }))
  process.exit(0)
}
const VAULT_PATH = process.env.VAULT_PATH
const CLIENTS_PATH = process.env.CLIENTS_PATH || join(PROJECT_ROOT, 'clients.json')

const CLIENT_MAP: Record<string, string> = {}

function loadClients(): void {
  try {
    const raw = readFileSync(CLIENTS_PATH, 'utf-8')
    const data = JSON.parse(raw)
    for (const [canonical, keywords] of Object.entries(data)) {
      if (canonical.startsWith('_')) continue
      if (Array.isArray(keywords)) {
        for (const kw of keywords) {
          if (typeof kw === 'string') CLIENT_MAP[kw.toLowerCase()] = canonical
        }
      }
    }
  } catch {}
}
loadClients()

function today(): string {
  return new Date().toISOString().split('T')[0]
}

// Ensure daily note exists
function ensureDailyNote(): string | null {
  const datum = today()
  const dailyDir = join(VAULT_PATH, 'Daily')
  const dailyPath = join(dailyDir, `${datum}.md`)
  if (!existsSync(dailyPath)) {
    mkdirSync(dailyDir, { recursive: true })
    writeFileSync(dailyPath, `---\ntags:\n  - daily\ndatum: ${datum}\n---\n\n# ${datum}\n\n## Aufgaben\n\n- [ ]\n\n## Notizen\n\n## Gelernt\n`, 'utf-8')
    return `Daily Note ${datum} erstellt.`
  }
  return null
}

// Auto-organize: scan Referenz/ for unsorted notes, move into Technik/{Kategorie}/
function autoOrganize(): number {
  const referenzDir = join(VAULT_PATH, 'Referenz')
  if (!existsSync(referenzDir)) return 0

  let moved = 0
  let files: string[] = []
  try { files = readdirSync(referenzDir) } catch { return 0 }

  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const fullPath = join(referenzDir, file)

    let stat
    try { stat = statSync(fullPath) } catch { continue }
    if (!stat.isFile()) continue

    // Parse frontmatter for tags
    let content = ''
    try { content = readFileSync(fullPath, 'utf-8') } catch { continue }

    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    let tags: string[] = []
    if (fmMatch) {
      try {
        const fm = parseYaml(fmMatch[1]) ?? {}
        if (Array.isArray(fm.tags)) tags = fm.tags.map((t: any) => String(t).toLowerCase())
      } catch {}
    }

    const title = basename(file, '.md')
    const classification = classifyNote(title, content, tags)
    if (!classification.category) continue

    const categoryPath = classification.subcategory
      ? join('Technik', classification.category, classification.subcategory)
      : join('Technik', classification.category)
    const targetDir = join(VAULT_PATH, categoryPath)
    const targetPath = join(targetDir, file)

    // Skip if target already exists
    if (existsSync(targetPath)) continue

    try {
      mkdirSync(targetDir, { recursive: true })
      renameSync(fullPath, targetPath)
      moved++
    } catch {}
  }

  return moved
}

// Find relevant notes for a client/project
function findRelevantNotes(client: string): string[] {
  const clientDir = join(VAULT_PATH, 'Kunden', client)
  const notes: string[] = []
  try {
    const files = readdirSync(clientDir, { recursive: true })
    for (const f of files) {
      if (typeof f === 'string' && f.endsWith('.md')) {
        notes.push(`Kunden/${client}/${f}`)
      }
    }
  } catch {}
  return notes
}

// Count open TODOs for a client
function countTodos(client: string): number {
  const clientDir = join(VAULT_PATH, 'Kunden', client)
  let count = 0
  try {
    const files = readdirSync(clientDir, { recursive: true })
    for (const f of files) {
      if (typeof f === 'string' && f.endsWith('.md')) {
        const content = readFileSync(join(clientDir, f), 'utf-8')
        const matches = content.match(/- \[ \]/g)
        if (matches) count += matches.length
      }
    }
  } catch {}
  return count
}

// ── Main ───────────────────────────────────────────────────────────

let input = ''
const timeout = setTimeout(() => process.exit(0), 8000)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => input += chunk)
process.stdin.on('end', () => {
  clearTimeout(timeout)

  try {
    const data = JSON.parse(input)
    const cwd = data.cwd || ''

    // Always ensure daily note
    const dailyMsg = ensureDailyNote()

    // Auto-organize Referenz/ → Technik/{Kategorie}/
    const organizedCount = autoOrganize()
    const organizeMsg = organizedCount > 0
      ? `${organizedCount} Notiz${organizedCount > 1 ? 'en' : ''} automatisch in Technik/ einsortiert.`
      : null

    // Detect client from CWD
    const cwdLower = cwd.toLowerCase()
    let detectedClient: string | null = null
    for (const [key, name] of Object.entries(CLIENT_MAP)) {
      if (cwdLower.includes(key)) {
        detectedClient = name
        break
      }
    }

    if (!detectedClient) {
      // No client context - just output daily note + organize status
      const msgs = [dailyMsg, organizeMsg].filter(Boolean)
      if (msgs.length > 0) {
        console.log(JSON.stringify({ result: 'continue', message: msgs.join('\n') }))
      } else {
        console.log(JSON.stringify({ result: 'continue' }))
      }
      process.exit(0)
    }

    // Build context message
    const notes = findRelevantNotes(detectedClient)
    const todoCount = countTodos(detectedClient)

    const parts: string[] = []
    parts.push(`Projekt-Kontext: **${detectedClient}** (${notes.length} Notizen in Vault)`)

    if (todoCount > 0) {
      parts.push(`${todoCount} offene TODOs — nutze \`todo_list\` für Details.`)
    }

    if (notes.length > 0) {
      parts.push(`Vorhandene Dokumentation: ${notes.slice(0, 5).join(', ')}`)
      if (notes.length > 5) parts.push(`...und ${notes.length - 5} weitere.`)
      parts.push(`Nutze \`vault_search\` mit "${detectedClient}" für Details.`)
    }

    if (dailyMsg) parts.push(dailyMsg)
    if (organizeMsg) parts.push(organizeMsg)

    console.log(JSON.stringify({
      result: 'continue',
      message: parts.join('\n')
    }))

  } catch {
    console.log(JSON.stringify({ result: 'continue' }))
  }

  process.exit(0)
})
