#!/usr/bin/env node

// Session Context Hook - SessionStart
// Detects which project you're working in (from CWD) and shows
// relevant knowledge from the Obsidian vault.
// Also ensures the daily note exists.

import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveClientContext } from '../services/client-resolver.ts'
import { appendActionLog } from '../services/action-log.ts'
import { atomicWriteFileSync } from '../services/atomic-file.ts'
import { assertCanWriteTool, loadBrainPolicy } from '../services/policy.ts'
import { vaultJoin } from '../services/vault-paths.ts'

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
  const dailyRelativePath = `Daily/${datum}.md`
  assertCanWriteTool('create_daily_note', [dailyRelativePath])
  const dailyPath = vaultJoin(VAULT_PATH, dailyRelativePath)
  const dailyDir = dirname(dailyPath)
  if (!existsSync(dailyPath)) {
    mkdirSync(dailyDir, { recursive: true })
    atomicWriteFileSync(dailyPath, `---\ntags:\n  - daily\ndatum: ${datum}\n---\n\n# ${datum}\n\n## Aufgaben\n\n- [ ]\n\n## Notizen\n\n## Gelernt\n`)
    appendActionLog(VAULT_PATH, {
      tool: 'create_daily_note',
      mode: 'apply',
      targets: [dailyRelativePath],
      summary: `Daily Note ${datum} erstellt`,
    })
    return `Daily Note ${datum} erstellt.`
  }
  return null
}

interface ClientNotePath {
  relativePath: string
  fullPath: string
}

// Find client notes without following directory/file symlinks outside the
// vault. SessionStart exposes only paths and aggregate TODO counts.
function findRelevantNotes(client: string): ClientNotePath[] {
  const rootRelative = `Kunden/${client}`
  const notes: ClientNotePath[] = []
  const visit = (relativeDir: string): void => {
    let entries
    try {
      entries = readdirSync(vaultJoin(VAULT_PATH, relativeDir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const relativePath = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) visit(relativePath)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          notes.push({ relativePath, fullPath: vaultJoin(VAULT_PATH, relativePath) })
        } catch {
          // A raced or escaping path is ignored fail-closed.
        }
      }
    }
  }
  visit(rootRelative)
  return notes
}

function countTodos(notes: ClientNotePath[]): number {
  let count = 0
  for (const note of notes) {
    try {
      const content = readFileSync(note.fullPath, 'utf-8')
      const matches = content.match(/- \[ \]/g)
      if (matches) count += matches.length
    } catch {}
  }
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

    // Detect client from CWD
    const detectedClient = resolveClientContext(cwd).client

    if (!detectedClient) {
      // No client context - only report daily-note setup.
      const msgs = [dailyMsg].filter(Boolean)
      if (msgs.length > 0) {
        console.log(JSON.stringify({ result: 'continue', message: msgs.join('\n') }))
      } else {
        console.log(JSON.stringify({ result: 'continue' }))
      }
      process.exit(0)
    }

    // Build context message
    const notePaths = findRelevantNotes(detectedClient)
    const notes = notePaths.map(note => note.relativePath)
    const todoCount = countTodos(notePaths)

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
    console.log(JSON.stringify({
      result: 'continue',
      message: parts.join('\n')
    }))

  } catch {
    console.log(JSON.stringify({ result: 'continue' }))
  }

  process.exit(0)
})
