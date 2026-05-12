#!/usr/bin/env node

// Session Context Hook - SessionStart
// Detects which project you're working in (from CWD) and shows
// relevant knowledge from the Obsidian vault.
// Also ensures the daily note exists.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadClients } from '../config.ts'
import { appendActionLog } from '../services/action-log.ts'
import { assertCanWriteTool, loadBrainPolicy } from '../services/policy.ts'
import { Vault } from '../vault.ts'

if (!process.env.VAULT_PATH) {
  console.log(JSON.stringify({ result: 'continue' }))
  process.exit(0)
}
const VAULT_PATH = process.env.VAULT_PATH

function today(): string {
  return new Date().toISOString().split('T')[0]
}

// Ensure daily note exists
function ensureDailyNote(): string | null {
  const policy = loadBrainPolicy()
  if (!policy.hooks.createDailyNote) return null
  const datum = today()
  assertCanWriteTool('create_daily_note', [`Daily/${datum}.md`])
  const dailyDir = join(VAULT_PATH, 'Daily')
  const dailyPath = join(dailyDir, `${datum}.md`)
  if (!existsSync(dailyPath)) {
    mkdirSync(dailyDir, { recursive: true })
    writeFileSync(dailyPath, `---\ntags:\n  - daily\ndatum: ${datum}\n---\n\n# ${datum}\n\n## Aufgaben\n\n- [ ]\n\n## Notizen\n\n## Gelernt\n`, 'utf-8')
    appendActionLog(VAULT_PATH, {
      tool: 'create_daily_note',
      mode: 'apply',
      targets: [`Daily/${datum}.md`],
      summary: `Daily Note ${datum} erstellt`,
    })
    return `Daily Note ${datum} erstellt.`
  }
  return null
}

// Auto-organize through the same Vault implementation used by the MCP tool.
async function autoOrganize(): Promise<number> {
  if (!loadBrainPolicy().hooks.autoOrganize) return 0
  const vault = new Vault(VAULT_PATH)
  try {
    await vault.init()
    return vault.organizeReferenz(false).moved.length
  } catch {
    return 0
  } finally {
    vault.shutdown()
  }
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
process.stdin.on('end', async () => {
  clearTimeout(timeout)

  try {
    const data = JSON.parse(input)
    const cwd = data.cwd || ''

    // Always ensure daily note
    const dailyMsg = ensureDailyNote()

    // Auto-organize Referenz/ → Technik/{Kategorie}/
    const organizedCount = await autoOrganize()
    const organizeMsg = organizedCount > 0
      ? `${organizedCount} Notiz${organizedCount > 1 ? 'en' : ''} automatisch in Technik/ einsortiert.`
      : null

    // Detect client from CWD
    const cwdLower = cwd.toLowerCase()
    let detectedClient: string | null = null
    for (const [key, name] of Object.entries(loadClients())) {
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
