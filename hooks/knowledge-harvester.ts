#!/usr/bin/env node

// Knowledge Harvester v3 - Stop Hook (async)
// Reads full transcript to capture procedural knowledge.
// Smart title from CWD + detected services.
// Auto-places notes in correct Kunden/ folder.
// Auto-tags from commands used.
// Uses assistant summaries ("Erledigt:", bullet lists) as note content.
// One capture per session, dedup by session ID.

import { writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { classifyNote } from '../technik-categories.ts'
import { configPaths, loadClients } from '../config.ts'
import { appendActionLog } from '../services/action-log.ts'

if (!process.env.VAULT_PATH) {
  process.stderr.write('knowledge-harvester: VAULT_PATH environment variable required\n')
  process.exit(0)
}
const VAULT_PATH = process.env.VAULT_PATH
const LOG_PATH = process.env.HARVESTER_LOG || '/tmp/knowledge-harvester.log'
const STATE_DIR = process.env.HARVESTER_STATE_DIR || '/tmp/knowledge-harvester-state'
const SUGGESTIONS_LOG = process.env.HARVESTER_SUGGESTIONS_LOG || '/tmp/knowledge-harvester-suggestions.log'

function log(msg: string): void {
  try { appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`) } catch {}
}

// CLIENT_MAP resolved lazily via config.loadClients()

// Non-client path segments to skip when suggesting new clients
const SKIP_SEGMENTS = new Set([
  'home', 'root', 'amo', 'documents', 'code', 'projects', 'project',
  'src', 'tmp', 'temp', 'test', 'tests', 'dev', 'work', 'repos',
  'workspace', 'workspaces', 'git', 'github', 'gitlab', 'bitbucket',
  'build', 'dist', 'node_modules', 'vendor', 'cache',
])

const COMMAND_TAGS: Record<string, string> = {
  'qm ': 'proxmox',
  'pvesh': 'proxmox',
  'pveceph': 'ceph',
  'pct ': 'proxmox',
  'linuxmuster': 'linuxmuster',
  'lmn-': 'linuxmuster',
  'sophomorix': 'linuxmuster',
  'opnsense': 'opnsense',
  'edulution': 'edulution',
  'apt ': 'ubuntu',
  'netplan': 'netplan',
  'systemctl': 'systemd',
  'docker': 'docker',
  'ssh ': 'ssh',
  'samba': 'samba',
  'firewall': 'firewall',
  'nginx': 'nginx',
  'apache': 'apache',
}

// ── Transcript Parsing ─────────────────────────────────────────────

interface TranscriptEntry {
  role: string
  type: 'text' | 'tool_use' | 'tool_result'
  content: string
  toolName?: string
  isError?: boolean
}

function parseTranscript(path: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  try {
    const raw = readFileSync(path, 'utf-8')
    for (const line of raw.trim().split('\n')) {
      try {
        const obj = JSON.parse(line)
        if (!obj.message?.content) continue
        // Transcript format uses `type` at top-level (not `role`)
        const entryRole = obj.role ?? obj.type ?? 'unknown'

        // User text messages may have content as plain string (not array)
        if (typeof obj.message.content === 'string' && entryRole === 'user') {
          entries.push({ role: 'user', type: 'text', content: obj.message.content })
          continue
        }

        if (!Array.isArray(obj.message.content)) continue

        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            entries.push({ role: entryRole, type: 'text', content: block.text })
          } else if (block.type === 'tool_use') {
            entries.push({
              role: entryRole,
              type: 'tool_use',
              content: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
              toolName: block.name,
            })
          } else if (block.type === 'tool_result') {
            const text = Array.isArray(block.content)
              ? block.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
              : typeof block.content === 'string' ? block.content : ''
            entries.push({
              role: 'tool',
              type: 'tool_result',
              content: text,
              isError: block.is_error === true || /^Error:|Exit code [^0]/.test(text.slice(0, 100)),
            })
          }
        }
      } catch { continue }
    }
  } catch (err) {
    log(`Failed to parse transcript: ${err}`)
  }
  return entries
}

// ── Client Detection from CWD ──────────────────────────────────────

function detectClient(cwd: string): string | null {
  const cwdLower = cwd.toLowerCase()
  for (const [key, name] of Object.entries(loadClients())) {
    if (cwdLower.includes(key)) return name
  }
  return null
}

function suggestClientFromCwd(cwd: string): string | null {
  const clientMap = loadClients()
  // Walk path segments, find the first segment that looks like a client name
  const segments = cwd.split('/').filter(Boolean).map(s => s.toLowerCase())
  for (const seg of segments.reverse()) {
    if (SKIP_SEGMENTS.has(seg)) continue
    // Must be 3-25 chars, mostly alphabetic
    if (seg.length < 3 || seg.length > 25) continue
    if (!/^[a-zäöüß][a-zäöüß0-9\-_]+$/i.test(seg)) continue
    // Already known? no suggestion needed
    if (clientMap[seg]) return null
    return seg
  }
  return null
}

function logSuggestion(candidate: string, cwd: string): void {
  try {
    const msg = `${new Date().toISOString()} VORSCHLAG: "${candidate}" als Kunde registrieren? (Pfad: ${cwd})\n` +
                `  → Zeile in ${configPaths().clients} hinzufügen:\n` +
                `    "${candidate.charAt(0).toUpperCase() + candidate.slice(1)}": ["${candidate}"],\n\n`
    appendFileSync(SUGGESTIONS_LOG, msg)
  } catch {}
}

// ── Auto-Tag Detection from Commands ───────────────────────────────

function detectTags(entries: TranscriptEntry[]): string[] {
  const tags = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'tool_use' || entry.toolName !== 'Bash') continue
    let cmd = ''
    try { cmd = JSON.parse(entry.content).command || '' } catch { cmd = entry.content }
    const cmdLower = cmd.toLowerCase()
    for (const [pattern, tag] of Object.entries(COMMAND_TAGS)) {
      if (cmdLower.includes(pattern)) tags.add(tag)
    }
  }
  return [...tags]
}

// ── Smart Title Generation ─────────────────────────────────────────

function generateTitle(entries: TranscriptEntry[], cwd: string, tags: string[]): string {
  const client = detectClient(cwd)
  const datum = new Date().toISOString().split('T')[0]

  // Collect substantive user messages to detect the topic
  const userTopics: string[] = []
  for (const entry of entries) {
    if (entry.role === 'user' && entry.type === 'text') {
      const text = entry.content.trim()
      if (text.length > 20 && text.length < 300 && !/^(ja|nein|ok|gerne|weiter|danke|mach|klar)/i.test(text)) {
        userTopics.push(text)
      }
    }
  }

  // Detect main activity from tags
  const activity = tags.includes('linuxmuster') ? 'linuxmuster Setup'
    : tags.includes('proxmox') ? 'Proxmox Konfiguration'
    : tags.includes('docker') ? 'Docker Setup'
    : tags.includes('opnsense') ? 'OPNsense Konfiguration'
    : tags.includes('netplan') ? 'Netzwerk-Konfiguration'
    : 'Server-Konfiguration'

  // Check assistant messages for descriptive headings
  for (const entry of entries) {
    if (entry.role === 'assistant' && entry.type === 'text') {
      const heading = entry.content.match(/^#+\s+(.{15,80})$/m)
      if (heading && !/erledigt|zusammenfassung|nächst/i.test(heading[1])) {
        const cleanTitle = heading[1].trim()
        if (client) return `${client} — ${cleanTitle}`
        return cleanTitle
      }
    }
  }

  // Build from components
  if (client) return `${client} — ${activity} (${datum})`
  if (userTopics.length > 0) {
    const topic = userTopics[0].slice(0, 60).replace(/[/\\:*?"<>|\n]/g, ' ').trim()
    return `${topic} (${datum})`
  }

  return `${activity} (${datum})`
}

// ── Knowledge Extraction ───────────────────────────────────────────

interface Phase {
  userRequest: string   // was der User gefragt hat (kurz)
  outcome: string       // was als Ergebnis rauskam (assistant summary)
  commandCount: number  // wie viele Bash-Commands in dieser Phase
  hadError: boolean     // trat ein Fehler auf der gelöst wurde?
}

interface ExtractedKnowledge {
  title: string
  client: string | null
  tags: string[]
  procedures: string[]
  errorFixes: string[]
  summaries: string[]
  phases: Phase[]
}

// Extract "phases" = work-blocks between user messages
function extractPhases(entries: TranscriptEntry[]): Phase[] {
  const phases: Phase[] = []
  let currentUserRequest = ''
  let currentAssistantTexts: string[] = []
  let currentCmdCount = 0
  let currentHadError = false
  let inPhase = false

  const flushPhase = () => {
    if (!inPhase || !currentUserRequest) return
    // Pick best outcome: last substantial assistant text, or final assistant text
    const outcome = currentAssistantTexts
      .filter(t => t.length > 40)
      .pop() || ''
    // Only save if there was actual work (commands or substantial outcome)
    if (currentCmdCount > 0 || outcome.length > 60) {
      phases.push({
        userRequest: currentUserRequest,
        outcome: outcome.slice(0, 500),
        commandCount: currentCmdCount,
        hadError: currentHadError,
      })
    }
    currentAssistantTexts = []
    currentCmdCount = 0
    currentHadError = false
  }

  for (const entry of entries) {
    if (entry.role === 'user' && entry.type === 'text') {
      flushPhase()
      // Start new phase
      const text = entry.content.trim()
      if (text.length >= 10 && !/^<(command|system|local-command|user-prompt)/i.test(text)) {
        currentUserRequest = text.slice(0, 200).replace(/\n+/g, ' ').trim()
        inPhase = true
      } else {
        inPhase = false
      }
    } else if (inPhase) {
      if (entry.role === 'assistant' && entry.type === 'text' && entry.content.length > 30) {
        currentAssistantTexts.push(entry.content)
      } else if (entry.type === 'tool_use' && entry.toolName === 'Bash') {
        currentCmdCount++
      } else if (entry.type === 'tool_result' && entry.isError) {
        currentHadError = true
      }
    }
  }
  flushPhase()

  return phases
}

function extractKnowledge(entries: TranscriptEntry[], cwd: string): ExtractedKnowledge | null {
  const procedures: string[] = []
  const errorFixes: string[] = []
  const summaries: string[] = []

  let lastBashCmd = ''
  let lastError = ''

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]

    // Track Bash commands
    if (entry.type === 'tool_use' && entry.toolName === 'Bash') {
      try { lastBashCmd = JSON.parse(entry.content).command || entry.content } catch { lastBashCmd = entry.content }
    }

    // Track errors
    if (entry.type === 'tool_result' && entry.isError && lastBashCmd) {
      lastError = lastBashCmd.slice(0, 150)
    }

    // Detect Error → Fix cycle
    if (lastError && entry.type === 'tool_use' && entry.toolName === 'Bash') {
      let fixCmd = ''
      try { fixCmd = JSON.parse(entry.content).command || '' } catch { fixCmd = entry.content }
      const nextResult = entries[i + 1]
      if (nextResult?.type === 'tool_result' && !nextResult.isError) {
        // Strip SSH wrapper
        const innerError = stripSsh(lastError)
        const innerFix = stripSsh(fixCmd)
        errorFixes.push(`**Fehler:** \`${innerError}\`\n**Fix:** \`${innerFix.slice(0, 200)}\``)
        lastError = ''
      }
    }

    // Collect successful Bash commands (not reads/checks)
    if (entry.type === 'tool_result' && !entry.isError && lastBashCmd) {
      const isRead = /^(echo |cat |ls |head |tail |grep |find |less |wc |hostname|pwd|id |whoami)/.test(lastBashCmd)
      const isCheck = lastBashCmd.length < 80 && /(status|show|list|get |config .*output|info|ping |nslookup|dig )/.test(lastBashCmd)
      if (lastBashCmd.length > 20 && !isRead && !isCheck) {
        const cmd = stripSsh(lastBashCmd)
        if (cmd.length > 15) procedures.push(cmd.slice(0, 250))
      }
      lastBashCmd = ''
    }

    // Collect assistant summaries (the "Erledigt:", bullet-point messages)
    if (entry.role === 'assistant' && entry.type === 'text' && entry.content.length > 80) {
      const text = entry.content
      // Prioritize structured summaries
      if (/erledigt|zusammenfassung|durchgelaufen|konfiguriert|installiert|eingerichtet|abgeschlossen/i.test(text)) {
        summaries.push(text.slice(0, 800))
      }
    }
  }

  const tags = detectTags(entries)
  const client = detectClient(cwd)

  // Need minimum substance
  if (procedures.length < 2) return null
  const totalSignals = procedures.length + errorFixes.length + summaries.length
  if (totalSignals < 3) return null

  const title = generateTitle(entries, cwd, tags)
  const phases = extractPhases(entries)

  return { title, client, tags, procedures, errorFixes, summaries, phases }
}

function stripSsh(cmd: string): string {
  // Remove ssh -J ... root@host "..." wrapper to show inner command
  const patterns = [
    /^ssh\s+(?:-[^\s]*\s+)*(?:-J\s+\S+\s+)?\S+\s+["'](.+)["']\s*$/s,
    /^ssh\s+(?:-[^\s]*\s+)*(?:-J\s+\S+\s+)?\S+\s+(.+)$/s,
  ]
  for (const p of patterns) {
    const m = cmd.match(p)
    if (m) return m[1].trim()
  }
  return cmd
}

// ── Note Generation ────────────────────────────────────────────────

function generateNote(k: ExtractedKnowledge): string {
  const datum = new Date().toISOString().split('T')[0]
  const allTags = ['auto-capture', 'prozedur', ...k.tags]
  if (k.client) allTags.push(`kunde/${k.client.toLowerCase()}`)
  const tagBlock = allTags.map(t => `  - ${t}`).join('\n')

  const sections: string[] = []

  sections.push(`---
status: aktiv
tags:
${tagBlock}
datum: ${datum}
quelle: knowledge-harvester
---

# ${k.title}

> [!info] Auto-Capture
> Automatisch aus Session erfasst am ${datum}.`)

  // Ablauf - human-readable phase-by-phase narrative (TOP)
  if (k.phases.length > 0) {
    const phaseList = k.phases.map((p, i) => {
      const header = `### ${i + 1}. ${p.userRequest.slice(0, 100)}`
      const parts: string[] = [header]
      if (p.outcome) {
        parts.push(p.outcome.slice(0, 400))
      }
      const meta: string[] = []
      if (p.commandCount > 0) meta.push(`${p.commandCount} Befehl${p.commandCount > 1 ? 'e' : ''}`)
      if (p.hadError) meta.push('mit Fehler-Workaround')
      if (meta.length > 0) parts.push(`*(${meta.join(', ')})*`)
      return parts.join('\n\n')
    }).join('\n\n')
    sections.push(`\n## Ablauf\n\n${phaseList}`)
  }

  // Summaries (raw assistant summary messages - kept for reference)
  if (k.summaries.length > 0) {
    const best = k.summaries.slice(-3)
    sections.push(`\n## Zusammenfassung\n\n${best.join('\n\n---\n\n')}`)
  }

  // Error fixes (high-value knowledge)
  if (k.errorFixes.length > 0) {
    const fixes = k.errorFixes.slice(0, 10).map((f, i) => `### ${i + 1}.\n${f}`).join('\n\n')
    sections.push(`\n## Fehler und Workarounds\n\n${fixes}`)
  }

  // Procedures (condensed)
  if (k.procedures.length > 0) {
    const steps = k.procedures.slice(0, 20).map((p, i) => `${i + 1}. \`${p}\``).join('\n')
    sections.push(`\n## Durchgeführte Befehle\n\n${steps}`)
    if (k.procedures.length > 20) {
      sections.push(`\n> ...und ${k.procedures.length - 20} weitere Schritte.`)
    }
  }

  return sections.join('\n')
}

// ── Session State ──────────────────────────────────────────────────

function hasSessionBeenCaptured(sessionId: string): boolean {
  mkdirSync(STATE_DIR, { recursive: true })
  return existsSync(join(STATE_DIR, `${sessionId}.done`))
}

function markSessionCaptured(sessionId: string): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(join(STATE_DIR, `${sessionId}.done`), new Date().toISOString())
  // Cleanup old state files
  try {
    const files = readdirSync(STATE_DIR)
      .map(f => ({ name: f, mtime: statSync(join(STATE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(30)) unlinkSync(join(STATE_DIR, f.name))
  } catch {}
}

// ── Main ───────────────────────────────────────────────────────────

let input = ''
const timeout = setTimeout(() => process.exit(0), 12000)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => input += chunk)
process.stdin.on('end', () => {
  clearTimeout(timeout)

  try {
    const data = JSON.parse(input)
    const sessionId = data.session_id
    const transcriptPath = data.transcript_path
    const cwd = data.cwd || ''

    if (!sessionId || !transcriptPath) process.exit(0)
    if (hasSessionBeenCaptured(sessionId)) process.exit(0)

    const entries = parseTranscript(transcriptPath)
    if (entries.length < 10) process.exit(0)

    // Only capture work sessions (>= 3 bash commands)
    const bashCount = entries.filter(e => e.type === 'tool_use' && e.toolName === 'Bash').length
    if (bashCount < 3) process.exit(0)

    const knowledge = extractKnowledge(entries, cwd)
    if (!knowledge) {
      log(`Session ${sessionId.slice(0, 8)}: ${entries.length} entries, ${bashCount} bash — not enough substance`)
      process.exit(0)
    }

    // If no client detected, check if we can suggest one
    if (!knowledge.client) {
      const suggestion = suggestClientFromCwd(cwd)
      if (suggestion) {
        logSuggestion(suggestion, cwd)
        log(`Session ${sessionId.slice(0, 8)}: Unbekannter Pfad — Vorschlag "${suggestion}" geloggt`)
      }
    }

    log(`Session ${sessionId.slice(0, 8)}: "${knowledge.title}" — ${knowledge.procedures.length} steps, ${knowledge.errorFixes.length} fixes, tags: [${knowledge.tags.join(',')}]`)

    // Determine folder:
    // 1. If client detected → Kunden/{Client}
    // 2. Else classify into Technik/{Category}
    // 3. Fallback → Referenz/ (wenn keine Kategorie passt)
    let folder = 'Referenz'
    if (knowledge.client) {
      folder = `Kunden/${knowledge.client}`
    } else {
      const content = knowledge.summaries.join('\n') + '\n' + knowledge.procedures.join('\n')
      const classification = classifyNote(knowledge.title, content, knowledge.tags)
      if (classification.category) {
        folder = classification.subcategory
          ? `Technik/${classification.category}/${classification.subcategory}`
          : `Technik/${classification.category}`
        log(`  → Kategorisiert als ${folder} (${classification.reason})`)
      }
    }

    const safeTitle = knowledge.title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 100)
    const fullDir = join(VAULT_PATH, folder)
    const fullPath = join(fullDir, `${safeTitle}.md`)

    if (existsSync(fullPath)) {
      log(`Note already exists: ${fullPath}`)
      markSessionCaptured(sessionId)
      process.exit(0)
    }

    mkdirSync(fullDir, { recursive: true })
    const noteContent = generateNote(knowledge)
    writeFileSync(fullPath, noteContent, 'utf-8')
    markSessionCaptured(sessionId)
    log(`Captured: ${folder}/${safeTitle}.md`)

    const relativeTarget = `${folder}/${safeTitle}.md`
    appendActionLog(VAULT_PATH, {
      tool: 'auto_capture',
      mode: 'apply',
      targets: [relativeTarget],
      summary: `Session-Capture: "${knowledge.title}" (${knowledge.procedures.length} Schritte, ${knowledge.errorFixes.length} Workarounds)`,
      meta: {
        sessionId,
        tags: knowledge.tags,
        client: knowledge.client,
      },
    })

    // Append to daily note
    const datum = new Date().toISOString().split('T')[0]
    const dailyPath = join(VAULT_PATH, 'Daily', `${datum}.md`)
    if (existsSync(dailyPath)) {
      appendFileSync(dailyPath, `\n- Auto-Capture: [[${folder}/${safeTitle}|${knowledge.title}]]\n`)
      appendActionLog(VAULT_PATH, {
        tool: 'daily_note',
        mode: 'apply',
        targets: [`Daily/${datum}.md`],
        summary: `Auto-Capture-Link in Daily Note eingetragen`,
        meta: { link: relativeTarget },
      })
    }

  } catch (err) {
    log(`Error: ${err}`)
  }
  process.exit(0)
})
