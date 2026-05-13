#!/usr/bin/env node

// Knowledge Harvester v3 - Stop Hook (async)
// Reads full transcript to capture procedural knowledge.
// Smart title from CWD + detected services.
// Auto-places notes in correct Kunden/ folder.
// Auto-tags from commands used.
// Uses assistant summaries ("Erledigt:", bullet lists) as note content.
// Incremental per-session capture: unchanged transcript hashes are skipped,
// changed transcripts update the generated capture instead of blocking forever.

import { createHash } from 'node:crypto'
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { classifyNote } from '../technik-categories.ts'
import { configPaths, loadClients } from '../config.ts'
import { appendActionLog } from '../services/action-log.ts'
import { scoreCapture } from '../services/capture-scoring.ts'
import { resolveClientContext, type ClientMatch } from '../services/client-resolver.ts'
import { classifyIntent, type ClassifiedIntent } from '../services/intent-classifier.ts'
import { assertCanWriteTool, loadBrainPolicy } from '../services/policy.ts'
import { redactSecrets, type RedactionResult } from '../services/secret-redaction.ts'
import { Vault } from '../vault.ts'

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

function detectClient(cwd: string, content = ''): ClientMatch {
  return resolveClientContext(cwd, content)
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

function logSuggestion(candidate: string, cwd: string, client?: string | null): void {
  try {
    const target = client?.trim() || `${candidate.charAt(0).toUpperCase() + candidate.slice(1)}`
    const msg = `${new Date().toISOString()} VORSCHLAG: "${candidate}" als Kunde registrieren? (Pfad: ${cwd})\n` +
                `  → Zeile in ${configPaths().clients} hinzufügen:\n` +
                `    "${target}": ["${candidate}"],\n\n`
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
  const text = entries.filter(entry => entry.type === 'text').map(entry => entry.content).join('\n')
  const client = detectClient(cwd, text).client
  const datum = new Date().toISOString().split('T')[0]

  // Collect substantive user messages to detect the topic
  const userTopics: string[] = []
  for (const entry of entries) {
    if (entry.role === 'user' && entry.type === 'text') {
      const text = cleanCaptureText(entry.content)
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
  clientMatch: ClientMatch
  tags: string[]
  procedures: string[]
  errorFixes: string[]
  summaries: string[]
  phases: Phase[]
  intent: ClassifiedIntent
}

function cleanCaptureText(text: string): string {
  return text
    .replace(/<task-notification[\s\S]*?(?:<\/task-notification>|$)/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isNoisyCaptureText(text: string): boolean {
  const trimmed = cleanCaptureText(text).replace(/^[-*#\s>\d.]+/, '').trim()
  if (!trimmed) return true
  return /^<(command|system|local-command|user-prompt|task-notification)\b/i.test(trimmed)
    || /^(ok|okay|okey|alles klar|verstanden|nicht ganz|hier|sag|sobald|wenn|bitte|alternativ|kopier|kopiere|führe|fuehre|prüfe|pruefe)\b/i.test(trimmed)
    || /^(eine sache stimmt nicht|spurensuche-ergebnis|compose-syntax|pull durch|files stehen|damit ist die vorbereitung komplett|heute abend)\b/i.test(trimmed)
    || /\b(sag bescheid|ich warte|ich melde mich|willst du|kannst du|soll ich|zum selber-ausführen|zum selber-ausfuehren)\b/i.test(trimmed)
}

function isReadOnlyOrInspectionCommand(cmd: string): boolean {
  const trimmed = cmd.trim()
  return /^(echo |cat |ls |head |tail |grep |find |less |wc |hostname|pwd|id |whoami|dig |nslookup|ip\s+(a|addr|route|link)\b|docker\s+(ps|images|info|version)\b|docker\s+compose\s+(config|version|ps)\b)/i.test(trimmed)
    || trimmed.length < 100 && /\b(status|show|list|get |config .*output|info|ping |nslookup|dig )/i.test(trimmed)
}

function isSensitiveOrVerboseCommand(cmd: string): boolean {
  return /<<|cat\s*>\s*\.?env\b|NETWORKBOX_|JWT_SECRET|DB_PASSWORD|MONGO_URI|auth-user-pass|password|passwd|secret|token/i.test(cmd)
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
      const text = cleanCaptureText(entry.content)
      if (text.length >= 10 && !isNoisyCaptureText(text)) {
        currentUserRequest = text.slice(0, 200).replace(/\n+/g, ' ').trim()
        inPhase = true
      } else {
        inPhase = false
      }
    } else if (inPhase) {
      if (entry.role === 'assistant' && entry.type === 'text' && entry.content.length > 30) {
        const text = cleanCaptureText(entry.content)
        if (text.length > 30 && !isNoisyCaptureText(text)) currentAssistantTexts.push(text)
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
      const cmd = stripSsh(lastBashCmd)
      const isRead = isReadOnlyOrInspectionCommand(cmd)
      const sensitiveOrVerbose = isSensitiveOrVerboseCommand(cmd)
      if (cmd.length >= 15 && !isRead && !sensitiveOrVerbose) {
        if (cmd.length > 15) procedures.push(cmd.slice(0, 250))
      }
      lastBashCmd = ''
    }

    // Collect assistant summaries (the "Erledigt:", bullet-point messages)
    if (entry.role === 'assistant' && entry.type === 'text' && entry.content.length > 80) {
      const text = cleanCaptureText(entry.content)
      if (isNoisyCaptureText(text)) continue
      // Prioritize structured summaries
      if (/erledigt|zusammenfassung|befund|ergebnis|empfehlung|durchgelaufen|konfiguriert|installiert|eingerichtet|abgeschlossen/i.test(text)) {
        summaries.push(text.slice(0, 800))
      }
    }
  }

  const tags = detectTags(entries)
  const resolverText = entries
    .filter(entry => entry.type === 'text')
    .map(entry => entry.content)
    .join('\n')
  const clientMatch = detectClient(cwd, resolverText)
  const client = clientMatch.client

  // Need minimum substance. Read-only investigation sessions can be valuable
  // when the assistant produced a concrete finding summary, even if no commands
  // should be promoted as reusable procedure steps.
  const bashCommandCount = entries.filter(entry => entry.type === 'tool_use' && entry.toolName === 'Bash').length
  const hasSubstantiveSummary = summaries.some(summary => summary.length >= 120)
  if (procedures.length < 2 && !hasSubstantiveSummary) return null
  const totalSignals = procedures.length + errorFixes.length + summaries.length
  if (totalSignals < 3 && !(hasSubstantiveSummary && bashCommandCount >= 3)) return null

  const title = generateTitle(entries, cwd, tags)
  const phases = extractPhases(entries)
  const intentContent = [
    summaries.join('\n\n'),
    procedures.map((procedure, i) => `${i + 1}. \`${procedure}\``).join('\n'),
    errorFixes.join('\n\n'),
  ].join('\n\n')
  const intent = classifyIntent(intentContent, tags)

  return { title, client, clientMatch, tags, procedures, errorFixes, summaries, phases, intent }
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
knowledge_type: capture
source_stage: stop_capture
session_intent: ${k.intent.intent}
intent_confidence: ${k.intent.confidence}
client_match_method: ${k.clientMatch.method}
client_match_confidence: ${k.clientMatch.confidence}
${k.clientMatch.candidate ? `client_match_candidate: ${k.clientMatch.candidate}\n` : ''}${k.clientMatch.matched ? `client_match_alias: ${k.clientMatch.matched}\n` : ''}${k.client ? `kunde: ${k.client}\n` : ''}
---

# ${k.title}

> [!info] Auto-Capture
> Automatisch aus Session erfasst am ${datum}.`)

  sections.push(`\n## Intent\n\n- Intent: ${k.intent.intent}\n- Confidence: ${k.intent.confidence}\n${k.intent.reasons.map(reason => `- ${reason}`).join('\n')}`)

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

function yamlList(values: string[]): string {
  return values.length > 0 ? values.map(value => `  - ${value}`).join('\n') : '  - none'
}

function injectCaptureMetadata(
  content: string,
  redaction: RedactionResult,
  scores: ReturnType<typeof scoreCapture>,
  session: { sessionId: string; transcriptHash: string; entryCount: number; bashCount: number },
): string {
  const fields = [
    `sensitive: ${redaction.count > 0}`,
    `redactions: ${redaction.count}`,
    `redaction_types:\n${yamlList(redaction.types)}`,
    `capture_value: ${scores.captureValue}`,
    `runbook_readiness: ${scores.runbookReadiness}`,
    `review_need: ${scores.reviewNeed}`,
    `session_id: ${session.sessionId}`,
    `transcript_hash: ${session.transcriptHash}`,
    `transcript_entries: ${session.entryCount}`,
    `transcript_bash_commands: ${session.bashCount}`,
  ].join('\n')
  return content.replace(/^---\n/, `---\n${fields}\n`)
}

function cwdExcluded(cwd: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    try {
      return new RegExp(pattern, 'i').test(cwd)
    } catch {
      return cwd.toLowerCase().includes(pattern.toLowerCase())
    }
  })
}

// ── Session State ──────────────────────────────────────────────────

interface SessionCaptureState {
  version: 2
  sessionId: string
  transcriptHash: string
  entryCount: number
  bashCount: number
  capturePath?: string
  updatedAt: string
  skippedReason?: string
}

function donePath(sessionId: string): string {
  return join(STATE_DIR, `${sessionId}.done`)
}

function statePath(sessionId: string): string {
  return join(STATE_DIR, `${sessionId}.json`)
}

function transcriptHash(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}

function readSessionCaptureState(sessionId: string): SessionCaptureState | null {
  mkdirSync(STATE_DIR, { recursive: true })
  try {
    const path = statePath(sessionId)
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SessionCaptureState>
    if (parsed.version !== 2 || parsed.sessionId !== sessionId || typeof parsed.transcriptHash !== 'string') return null
    return parsed as SessionCaptureState
  } catch {
    return null
  }
}

function markSessionCaptured(state: SessionCaptureState): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(statePath(state.sessionId), `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  writeFileSync(donePath(state.sessionId), state.updatedAt)
  // Cleanup old state files
  try {
    const files = readdirSync(STATE_DIR)
      .map(f => ({ name: f, mtime: statSync(join(STATE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(60)) unlinkSync(join(STATE_DIR, f.name))
  } catch {}
}

function shouldSkipSession(sessionId: string, hash: string): boolean {
  const state = readSessionCaptureState(sessionId)
  return !!state && !!hash && state.transcriptHash === hash
}

function existingGeneratedCapture(fullPath: string): boolean {
  if (!existsSync(fullPath)) return false
  try {
    const content = readFileSync(fullPath, 'utf-8')
    return /(^|\n)tags:\n(?:  - .+\n)*  - auto-capture/m.test(content)
      || /(^|\n)knowledge_type: capture\n/.test(content)
      || /(^|\n)source_stage: stop_capture\n/.test(content)
      || /Auto-Capture/.test(content)
  } catch {
    return false
  }
}

// ── Main ───────────────────────────────────────────────────────────

let input = ''
const timeout = setTimeout(() => process.exit(0), 12000)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => input += chunk)
process.stdin.on('end', async () => {
  clearTimeout(timeout)

  try {
    const policy = loadBrainPolicy()
    if (!policy.hooks.autoCapture) {
      log('Auto-capture disabled by brain-policy.json')
      process.exit(0)
    }

    const data = JSON.parse(input || process.env.HARVESTER_INPUT_JSON || '{}')
    const sessionId = data.session_id
    const transcriptPath = data.transcript_path
    const cwd = data.cwd || ''

    if (!sessionId || !transcriptPath) process.exit(0)
    const currentTranscriptHash = transcriptHash(transcriptPath)
    if (shouldSkipSession(sessionId, currentTranscriptHash)) {
      log(`skip ${sessionId.slice(0, 8)}: transcript hash unchanged`)
      process.exit(0)
    }
    if (cwdExcluded(cwd, policy.hooks.captureSafety.excludeCwdPatterns)) {
      log(`Session ${sessionId.slice(0, 8)}: CWD durch captureSafety.excludeCwdPatterns ausgeschlossen`)
      markSessionCaptured({
        version: 2,
        sessionId,
        transcriptHash: currentTranscriptHash,
        entryCount: 0,
        bashCount: 0,
        updatedAt: new Date().toISOString(),
        skippedReason: 'cwd excluded',
      })
      process.exit(0)
    }

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
    } else if (knowledge.clientMatch.method === 'fuzzy_cwd' && knowledge.clientMatch.candidate) {
      logSuggestion(knowledge.clientMatch.candidate, cwd, knowledge.client)
      log(`Session ${sessionId.slice(0, 8)}: Fuzzy-Kunde ${knowledge.client} über "${knowledge.clientMatch.candidate}" erkannt`)
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
    const relativeTarget = `${folder}/${safeTitle}.md`
    assertCanWriteTool('auto_capture', [relativeTarget])
    const previousState = readSessionCaptureState(sessionId)
    const canUpdateExisting = previousState?.capturePath === relativeTarget || existingGeneratedCapture(fullPath)
    if (existsSync(fullPath) && !canUpdateExisting) {
      log(`Note already exists and is not a generated capture: ${fullPath}`)
      markSessionCaptured({
        version: 2,
        sessionId,
        transcriptHash: currentTranscriptHash,
        entryCount: entries.length,
        bashCount,
        updatedAt: new Date().toISOString(),
        skippedReason: 'target exists and is not generated capture',
      })
      process.exit(0)
    }

    mkdirSync(fullDir, { recursive: true })
    const rawNoteContent = generateNote(knowledge)
    const redaction = policy.hooks.captureSafety.secretRedaction
      ? redactSecrets(rawNoteContent)
      : { content: rawNoteContent, count: 0, types: [] }
    if (redaction.count > 0 && policy.hooks.captureSafety.blockOnSecret) {
      log(`Session ${sessionId.slice(0, 8)}: Secret erkannt, Capture durch captureSafety.blockOnSecret blockiert`)
      markSessionCaptured({
        version: 2,
        sessionId,
        transcriptHash: currentTranscriptHash,
        entryCount: entries.length,
        bashCount,
        updatedAt: new Date().toISOString(),
        skippedReason: 'secret blocked',
      })
      process.exit(0)
    }
    const scores = scoreCapture({
      content: redaction.content,
      tags: ['auto-capture', 'prozedur', ...knowledge.tags],
      intent: knowledge.intent,
      clientMatchMethod: knowledge.clientMatch.method,
      redactionCount: redaction.count,
    })
    const noteContent = injectCaptureMetadata(redaction.content, redaction, scores, {
      sessionId,
      transcriptHash: currentTranscriptHash,
      entryCount: entries.length,
      bashCount,
    })
    writeFileSync(fullPath, noteContent, 'utf-8')
    markSessionCaptured({
      version: 2,
      sessionId,
      transcriptHash: currentTranscriptHash,
      entryCount: entries.length,
      bashCount,
      capturePath: relativeTarget,
      updatedAt: new Date().toISOString(),
    })
    log(`${canUpdateExisting ? 'Updated capture' : 'Captured'}: ${folder}/${safeTitle}.md`)

    appendActionLog(VAULT_PATH, {
      tool: 'auto_capture',
      mode: 'apply',
      targets: [relativeTarget],
      summary: `${canUpdateExisting ? 'Session-Capture aktualisiert' : 'Session-Capture'}: "${knowledge.title}" (${knowledge.procedures.length} Schritte, ${knowledge.errorFixes.length} Workarounds)`,
      meta: {
        sessionId,
        tags: knowledge.tags,
        client: knowledge.client,
        clientMatch: knowledge.clientMatch,
        intent: knowledge.intent,
        redactions: redaction.count,
        scores,
      },
    })

    // Append to daily note
    const datum = new Date().toISOString().split('T')[0]
    const dailyPath = join(VAULT_PATH, 'Daily', `${datum}.md`)
    if (!canUpdateExisting && policy.hooks.appendDailyCaptureLink && existsSync(dailyPath)) {
      assertCanWriteTool('daily_note', [`Daily/${datum}.md`])
      appendFileSync(dailyPath, `\n- Auto-Capture: [[${folder}/${safeTitle}|${knowledge.title}]]\n`)
      appendActionLog(VAULT_PATH, {
        tool: 'daily_note',
        mode: 'apply',
        targets: [`Daily/${datum}.md`],
        summary: `Auto-Capture-Link in Daily Note eingetragen`,
        meta: { link: relativeTarget },
      })
    }

    if (policy.automation.mode === 'auto_build') {
      const vault = new Vault(VAULT_PATH)
      try {
        await vault.init()
        const result = vault.brainAutoBuild({
          sourcePath: relativeTarget,
          client: knowledge.client ?? undefined,
          dryRun: false,
        })
        const applied = result.steps.filter(step => step.applied).length
        const skipped = result.steps.filter(step => step.skipped).length
        log(`Auto-build: ${applied} applied, ${skipped} skipped for ${relativeTarget}`)
      } finally {
        vault.shutdown()
      }
    }

  } catch (err) {
    log(`Error: ${err}`)
  }
  process.exit(0)
})
process.stdin.resume()
