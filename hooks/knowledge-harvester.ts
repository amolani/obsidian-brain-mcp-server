#!/usr/bin/env node

// Knowledge Harvester v3 - Stop Hook (async)
// Reads full transcript to capture procedural knowledge.
// Smart title from CWD + detected services.
// Auto-places notes in correct Kunden/ folder.
// Auto-tags from selected, evidenced knowledge only.
// Uses assistant summaries ("Erledigt:", bullet lists) as note content.
// Incremental per-session capture: unchanged transcript hashes are skipped,
// changed transcripts update the generated capture instead of blocking forever.

import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, statSync, readFileSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { classifyNote } from '../technik-categories.ts'
import { configPaths, loadClients } from '../config.ts'
import { appendActionLog } from '../services/action-log.ts'
import {
  calibrationSnapshotFingerprint,
  calibrationSnapshotFromFact,
  serializeCalibrationSnapshotCore,
} from '../services/brain-calibration.ts'
import {
  CALIBRATION_EVALUATION_SAMPLE_SIZE,
  CALIBRATION_CAPTURE_PRODUCER,
  CALIBRATION_CAPTURE_SCHEMA,
  calibrationCaptureIntegrity,
  serializeCalibrationReviewPayload,
  type CalibrationCaptureBundleInput,
} from '../services/calibration-capture.ts'
import { scoreCapture } from '../services/capture-scoring.ts'
import { resolveClientContext, type ClientMatch } from '../services/client-resolver.ts'
import { buildFrontmatter } from '../services/frontmatter-linter.ts'
import { classifyIntent, type ClassifiedIntent } from '../services/intent-classifier.ts'
import { parseFrontmatter } from '../services/note-parser.ts'
import { assertCanWriteTool, loadBrainPolicy } from '../services/policy.ts'
import { redactSecrets, type RedactionResult } from '../services/secret-redaction.ts'
import {
  selectSalientKnowledge,
  type KnowledgeBashEvidence,
  type KnowledgeFactKind,
  type KnowledgeSalienceFact,
  type KnowledgeSalienceSelection,
} from '../services/knowledge-salience.ts'
import { renderSessionDigest } from '../services/session-digest.ts'
import { uniqueRelativePath, vaultJoin } from '../services/vault-paths.ts'
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
  id?: string
  toolUseId?: string
  toolName?: string
  isError?: boolean
  exitCode?: number
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
              id: typeof block.id === 'string' ? block.id : undefined,
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
              toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
              isError: block.is_error === true || /^Error:|Exit code [^0]/.test(text.slice(0, 100)),
              exitCode: Number(text.match(/(?:exit code|exited with code)\s+(-?\d+)/i)?.[1] ?? (block.is_error === true ? 1 : 0)),
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

function detectTags(texts: readonly string[]): string[] {
  const tags = new Set<string>()
  for (const text of texts) {
    const textLower = text.toLowerCase()
    for (const [pattern, tag] of Object.entries(COMMAND_TAGS)) {
      if (textLower.includes(pattern)) tags.add(tag)
    }
  }
  return [...tags]
}

// ── Smart Title Generation ─────────────────────────────────────────

function generateTitle(entries: TranscriptEntry[], cwd: string, tags: string[], client: string | null): string {
  const datum = new Date().toISOString().slice(0, 10)

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
  selection: KnowledgeSalienceSelection
  routingActions: string[]
}

function cleanCaptureText(text: string): string {
  return text
    .replace(/<task-notification[\s\S]*?(?:<\/task-notification>|$)/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isNoisyCaptureText(text: string, speaker: 'assistant' | 'user' = 'assistant'): boolean {
  const trimmed = cleanCaptureText(text).replace(/^[-*#\s>\d.]+/, '').trim()
  if (!trimmed) return true
  if (/^<(command|system|local-command|user-prompt|task-notification)\b/i.test(trimmed)) return true
  if (/^(ok|okay|okey|alles klar|verstanden)\b[.!\s]*$/i.test(trimmed)) return true
  if (speaker === 'user') return false
  return /^(?:nicht ganz|hier|sag|sobald|wenn|bitte|alternativ|kopier|kopiere|führe|fuehre|prüfe|pruefe)\b/i.test(trimmed)
    || /^(?:eine sache stimmt nicht|spurensuche-ergebnis|compose-syntax|pull durch|files stehen|damit ist die vorbereitung komplett|heute abend)\b/i.test(trimmed)
    || /\b(?:sag bescheid|ich warte|ich melde mich|willst du|kannst du|soll ich|zum selber-ausführen|zum selber-ausfuehren)\b/i.test(trimmed)
}

function isReadOnlyOrInspectionCommand(cmd: string): boolean {
  const trimmed = cmd.trim()
  return /^(echo |cat |ls |head |tail |grep |find |less |wc |hostname|pwd|id |whoami|dig |nslookup|ip\s+(a|addr|route|link)\b|docker\s+(ps|images|info|version)\b|docker\s+compose\s+(config|version|ps)\b)/i.test(trimmed)
    || trimmed.length < 100 && /\b(status|show|list|get |config .*output|info|ping |nslookup|dig )/i.test(trimmed)
}

function isSensitiveOrVerboseCommand(cmd: string): boolean {
  return /<<|cat\s*>\s*\.?env\b|NETWORKBOX_|JWT_SECRET|DB_PASSWORD|MONGO_URI|auth-user-pass|password|passwd|secret|token/i.test(cmd)
}

function commandFromEntry(entry: TranscriptEntry): string {
  try {
    const parsed = JSON.parse(entry.content) as { command?: unknown }
    return typeof parsed.command === 'string' ? parsed.command : entry.content
  } catch {
    return entry.content
  }
}

function pairedBashEvidence(entries: TranscriptEntry[]): KnowledgeBashEvidence[] {
  const pending: Array<{ command: string; id: string; toolUseId?: string }> = []
  const pairs: KnowledgeBashEvidence[] = []

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.type === 'tool_use' && entry.toolName === 'Bash') {
      pending.push({
        command: commandFromEntry(entry),
        // Persist our own bounded ID. Tool-use IDs are transport metadata and
        // must not become a path/log surface for user-controlled input.
        id: `bash-${index}`,
        toolUseId: entry.id,
      })
      continue
    }
    if (entry.type !== 'tool_result' || pending.length === 0) continue

    const exactIndex = entry.toolUseId
      ? pending.findIndex(item => item.toolUseId === entry.toolUseId)
      : -1
    if (entry.toolUseId && exactIndex < 0) continue
    const pairIndex = exactIndex >= 0 ? exactIndex : pending.length - 1
    const pendingCommand = pending.splice(pairIndex, 1)[0]
    pairs.push({
      id: pendingCommand.id,
      command: pendingCommand.command,
      result: entry.content,
      isError: entry.isError,
      exitCode: entry.exitCode,
    })
  }

  return pairs
}

function selectedRoutingActions(
  selection: KnowledgeSalienceSelection,
  bashEvidence: readonly KnowledgeBashEvidence[],
): string[] {
  const selectedRefs = new Set(
    selection.facts.flatMap(fact => fact.provenance
      .filter(item => item.source === 'bash_pair')
      .map(item => item.ref)),
  )

  return bashEvidence
    .filter(pair => !!pair.id && selectedRefs.has(`bash_pair:${pair.id}`))
    .map(pair => stripSsh(pair.command))
    .filter(command => command.length >= 3 && !isSensitiveOrVerboseCommand(command))
    .map(command => command.slice(0, 250))
}

function taskFromEntries(entries: TranscriptEntry[]): string {
  return entries
    .filter(entry => entry.role === 'user' && entry.type === 'text')
    .map(entry => cleanCaptureText(entry.content).replace(/\s+/g, ' ').trim())
    .find(text => text.length >= 12 && !isNoisyCaptureText(text, 'user'))
    ?.slice(0, 300) ?? ''
}

function explicitlyRequestedFactKinds(entries: TranscriptEntry[]): Set<KnowledgeFactKind> | null {
  const userTexts = entries
    .filter(entry => entry.role === 'user' && entry.type === 'text')
    .map(entry => cleanCaptureText(entry.content))
    .reverse()

  for (const text of userTexts) {
    if (!/\b(?:nur|only)\b/i.test(text)) continue
    const kinds = new Set<KnowledgeFactKind>()
    const mappings: Array<[KnowledgeFactKind, RegExp]> = [
      ['decision', /(?:entscheidung|decision)/i],
      ['cause', /(?:ursache|root cause)/i],
      ['change', /(?:änderung|aenderung|change|fix)/i],
      ['verification', /(?:verifikation|validierung|prüfung|pruefung|prüfnachweis|pruefnachweis|verification)/i],
      ['constraint', /(?:[a-zäöüß]*bedingung|constraint|voraussetzung|schwellenwert|threshold)/i],
      ['open_question', /(?:offene frage|open question)/i],
      ['problem', /(?:problem|fehler|incident)/i],
      ['result', /(?:ergebnis|result|befund)/i],
    ]
    for (const [kind, pattern] of mappings) if (pattern.test(text)) kinds.add(kind)
    if (kinds.size > 0) return kinds
  }
  return null
}

function hasSemanticSignal(text: string): boolean {
  return /\b(?:zusammenfassung|summary|entscheidung|entschieden|beschlossen|decision|decided|ursache|root cause|because|weil|ergebnis|result|befund|verifiziert|validiert|verified|confirmed|test(?:s)? (?:passed|bestanden)|änderung|aenderung|geändert|geaendert|umgestellt|eingetragen|vorbereitet|verschoben|konfiguriert|installiert|behoben|fixed|offen(?:e|er|es)?|open question|todo|muss|muessen|must|constraint|fehlt|fehlgeschlagen|failed|funktioniert|works?|erreichbar|active|running)\b/i.test(text)
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
    // Keep the bounded semantic outcomes of a phase, not just the final chat
    // message. An explicit root cause or decision can otherwise disappear when
    // a later assistant message only reports cleanup or next steps. The
    // salience layer atomizes this evidence before anything is rendered.
    const substantial = currentAssistantTexts.filter(text => text.length > 40)
    const semanticOutcomes = substantial.filter(hasSemanticSignal)
    const outcome = semanticOutcomes
      .slice(-4)
      .join('\n')
    // Short, explicit decisions and findings can be more valuable than long
    // shell-heavy sessions, so phase retention is based on semantic substance.
    if (currentCmdCount > 0 || outcome.length > 20 || hasSemanticSignal(currentUserRequest)) {
      phases.push({
        userRequest: currentUserRequest,
        outcome: outcome.slice(0, 1800),
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
      if (text.length >= 10 && !isNoisyCaptureText(text, 'user')) {
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

function extractKnowledge(entries: TranscriptEntry[], cwd: string, sessionId: string): ExtractedKnowledge | null {
  const bashEvidence = pairedBashEvidence(entries)
  const procedures = bashEvidence
    .filter(pair => !pair.isError && (pair.exitCode === undefined || pair.exitCode === 0))
    .map(pair => stripSsh(pair.command))
    .filter(command => command.length >= 15 && !isReadOnlyOrInspectionCommand(command) && !isSensitiveOrVerboseCommand(command))
    .map(command => command.slice(0, 250))
  const errorFixes: string[] = []
  const summaries: string[] = []

  for (const entry of entries) {
    // Assistant text is evidence input, never note output. The salience layer
    // atomizes and abstracts it before anything is persisted.
    if (entry.role === 'assistant' && entry.type === 'text' && entry.content.length > 20) {
      const text = cleanCaptureText(entry.content)
      if (isNoisyCaptureText(text)) continue
      if (hasSemanticSignal(text)) summaries.push(text.slice(0, 1200))
      if (/(?:fehler|error)\s*:?[\s\S]*(?:fix|lösung|loesung|workaround)\s*:/i.test(text)) errorFixes.push(text.slice(0, 800))
    }
  }

  const resolverText = entries
    .filter(entry => entry.type === 'text')
    .map(entry => entry.content)
    .join('\n')
  const clientMatch = detectClient(cwd, resolverText)
  // Only an exact path segment is strong enough for physical customer routing.
  // Content and fuzzy matches remain review candidates in neutral folders.
  const client = clientMatch.method === 'exact_cwd' && clientMatch.confidence === 'high'
    ? clientMatch.client
    : null

  const phases = extractPhases(entries)
  const task = taskFromEntries(entries)
  const requestedKinds = explicitlyRequestedFactKinds(entries)
  const hasExplicitCause = summaries.some(summary => /\b(?:root cause|ursache)\b/i.test(summary))
  const factBudget = requestedKinds
    ? Math.max(1, Math.min(7, requestedKinds.size))
    : phases.length === 1 && hasExplicitCause
      ? 3
      : phases.length === 1
        ? 5
        : Math.max(4, Math.min(7, phases.length * 2))
  const selection = selectSalientKnowledge({
    sessionId,
    task,
    phases,
    assistantSummaries: summaries,
    errorFixes,
    bashEvidence,
    maxFacts: factBudget,
    minSalienceScore: 45,
    allowedKinds: requestedKinds ? [...requestedKinds] : undefined,
  })
  if (selection.facts.length === 0) return null

  // Routing and durable tags only see selected facts and Bash actions that
  // provide provenance for one of those exact facts. Incidental commands and
  // unselected assistant prose cannot decide a Technik folder.
  const routingActions = selectedRoutingActions(selection, bashEvidence)
  const routingFacts = selection.facts.map(fact => fact.statement)
  const tags = detectTags([...routingFacts, ...routingActions])

  // Titles are used in paths and logs before note-level redaction. Redact at
  // creation so no downstream surface ever receives a raw credential value.
  const title = redactSecrets(generateTitle(entries, cwd, tags, client)).content

  const intentContent = [
    task,
    selection.facts.map(fact => fact.statement).join('\n'),
    procedures.map((procedure, i) => `${i + 1}. \`${procedure}\``).join('\n'),
  ].join('\n\n')
  const intent = classifyIntent(intentContent, tags)

  return { title, client, clientMatch, tags, procedures, errorFixes, summaries, phases, intent, selection, routingActions }
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

interface CalibrationCaptureMaterial {
  bundle: CalibrationCaptureBundleInput
}

function calibrationReviewEvidence(
  fact: Omit<KnowledgeSalienceFact, 'selectionScore'>,
  sourceTypes: readonly string[],
): Array<{ ref: string; hash: string; excerpt: string }> {
  const allowedSources = new Set(sourceTypes)
  const provenance = fact.provenance.filter(item => allowedSources.has(item.source))
  const chosen = new Map<string, (typeof fact.provenance)[number]>()
  for (const item of provenance) {
    if (!chosen.has(item.source)) chosen.set(item.source, item)
  }
  for (const item of provenance) {
    if (chosen.size >= 8) break
    if (![...chosen.values()].some(current => current.ref === item.ref)) {
      chosen.set(`${item.source}:${item.ref}`, item)
    }
  }
  return [...chosen.values()].slice(0, 8).map(item => ({
    ref: item.ref,
    hash: item.hash,
    excerpt: item.excerpt.replace(
      /^(?:zusammenfassung|summary|erledigt)\s*:\s*/iu,
      '',
    ),
  }))
}

function calibrationCaptureMaterial(
  selection: KnowledgeSalienceSelection,
  generatedAt: string,
  sampleSeed: string,
): CalibrationCaptureMaterial {
  const population = selection.calibrationCandidates ?? selection.facts
  const selectedRank = new Map(selection.facts.map((fact, index) => [fact.id, index + 1]))
  const sampleSize = Math.min(CALIBRATION_EVALUATION_SAMPLE_SIZE, population.length)
  const sampled = [...population]
    .sort((left, right) => {
      const leftHash = createHash('sha256')
        .update(`${sampleSeed}\0${left.id}\0calibration-evaluation-v1`)
        .digest('hex')
      const rightHash = createHash('sha256')
        .update(`${sampleSeed}\0${right.id}\0calibration-evaluation-v1`)
        .digest('hex')
      return leftHash.localeCompare(rightHash, 'en') || left.id.localeCompare(right.id, 'en')
    })
    .slice(0, sampleSize)
  const sampledIds = new Set(sampled.map(fact => fact.id))
  const unselectedSample = sampled.filter(fact => !selectedRank.has(fact.id))
  const union = [
    ...selection.facts,
    ...unselectedSample,
  ]
  const inclusionProbability = population.length === 0 ? 0 : sampleSize / population.length
  const snapshots = union.map(fact => {
    const rank = selectedRank.get(fact.id) ?? null
    const evaluationSample = sampledIds.has(fact.id)
    return calibrationSnapshotFromFact(fact, {
      generatedAt,
      selectionStatus: rank === null ? 'sampled_unselected' : 'selected',
      productionRank: rank,
      evaluationSample,
      candidatePopulationCount: population.length,
      samplingProbability: evaluationSample ? inclusionProbability : 0,
    })
  })
  const factMap = snapshots.map((snapshot, index) => {
    const selectedPosition = selectedRank.get(snapshot.factId)
    if (selectedPosition !== undefined) return `F${selectedPosition}:${snapshot.factId}`
    const candidatePosition = index - selection.facts.length + 1
    return `C${candidatePosition}:${snapshot.factId}`
  })
  const snapshotFingerprints = snapshots.map(snapshot =>
    `${snapshot.factId}:${calibrationSnapshotFingerprint(snapshot)}`)
  const snapshotPayloads = snapshots.map(serializeCalibrationSnapshotCore)
  const snapshotsByFactId = new Map(snapshots.map(snapshot => [snapshot.factId, snapshot]))
  const factsById = new Map(union.map(fact => [fact.id, fact]))
  const reviewOrder = [...union].sort((left, right) => {
    const leftHash = createHash('sha256')
      .update(`${sampleSeed}\0${left.id}\0calibration-review-v1`)
      .digest('hex')
    const rightHash = createHash('sha256')
      .update(`${sampleSeed}\0${right.id}\0calibration-review-v1`)
      .digest('hex')
    return leftHash.localeCompare(rightHash, 'en') || left.id.localeCompare(right.id, 'en')
  })
  const reviewMap = reviewOrder.map((fact, index) => `R${index + 1}:${fact.id}`)
  const reviewPayloads = reviewOrder.map((orderedFact, index) => {
    const fact = factsById.get(orderedFact.id)
    if (!fact || fact.provenance.length === 0) {
      throw new Error(`Kalibrierungsfakt ${orderedFact.id} besitzt keine prüfbare Evidenz`)
    }
    const snapshot = snapshotsByFactId.get(fact.id)
    if (!snapshot) throw new Error(`Kalibrierungssnapshot ${fact.id} fehlt`)
    return serializeCalibrationReviewPayload({
      reviewId: `R${index + 1}`,
      statement: fact.statement,
      evidence: calibrationReviewEvidence(fact, snapshot.sourceTypes),
    })
  })
  return {
    bundle: {
      sessionId: selection.sessionId,
      modelVersion: selection.modelVersion,
      sampleSeed,
      selectedFactIds: selection.facts.map(fact => fact.id),
      factMap,
      snapshotFingerprints,
      snapshotPayloads,
      reviewMap,
      reviewPayloads,
    },
  }
}

function generateNote(
  k: ExtractedKnowledge,
  generatedAt: string,
  sampleSeed: string,
): string {
  const datum = generatedAt.slice(0, 10)
  const calibration = calibrationCaptureMaterial(k.selection, generatedAt, sampleSeed)
  const hasProcedure = k.selection.facts.some(fact => fact.kind === 'change' && fact.evidenceScore >= 75)
  const allTags = ['auto-capture', ...(hasProcedure ? ['prozedur'] : []), ...k.tags]
  if (k.client) allTags.push(`kunde/${k.client.toLowerCase()}`)
  const salienceScores = k.selection.facts.map(fact => fact.salienceScore)
  const evidenceScores = k.selection.facts.map(fact => fact.evidenceScore)
  const importanceScore = Math.max(0, ...salienceScores)
  const importanceMean = Math.round(salienceScores.reduce((sum, score) => sum + score, 0) / Math.max(1, salienceScores.length))
  const evidenceScore = Math.round(evidenceScores.reduce((sum, score) => sum + score, 0) / Math.max(1, evidenceScores.length))
  const evidenceQuality = evidenceScore >= 75 ? 'high' : evidenceScore >= 45 ? 'medium' : 'low'
  const frontmatter = buildFrontmatter({
    status: 'aktiv',
    tags: allTags,
    datum,
    quelle: 'knowledge-harvester',
    knowledge_type: 'capture',
    source_stage: 'stop_capture',
    abstraction_mode: 'typed_knowledge_atoms',
    importance_model: k.selection.modelVersion,
    importance_score: importanceScore,
    importance_mean: importanceMean,
    evidence_score: evidenceScore,
    evidence_quality: evidenceQuality,
    knowledge_fact_count: k.selection.facts.length,
    knowledge_candidate_count: k.selection.candidateCount,
    knowledge_fact_ids: k.selection.facts.map(fact => fact.id),
    calibration_capture_schema: CALIBRATION_CAPTURE_SCHEMA,
    calibration_capture_producer: CALIBRATION_CAPTURE_PRODUCER,
    calibration_capture_integrity: calibrationCaptureIntegrity(calibration.bundle),
    calibration_sample_seed: calibration.bundle.sampleSeed,
    calibration_fact_map: calibration.bundle.factMap,
    calibration_snapshot_fingerprints: calibration.bundle.snapshotFingerprints,
    calibration_snapshot_payloads: calibration.bundle.snapshotPayloads,
    calibration_review_map: calibration.bundle.reviewMap,
    calibration_review_payloads: calibration.bundle.reviewPayloads,
    session_intent: k.intent.intent,
    intent_confidence: k.intent.confidence,
    client_match_method: k.clientMatch.method,
    client_match_confidence: k.clientMatch.confidence,
    client_match_reason: k.clientMatch.reason,
    ...(k.clientMatch.candidate ? { client_match_candidate: k.clientMatch.candidate } : {}),
    ...(k.clientMatch.matched ? { client_match_alias: k.clientMatch.matched } : {}),
    ...(k.client ? { kunde: k.client } : {}),
  })

  const sections: string[] = []

  sections.push(`---
${frontmatter}---

# ${k.title}

> [!info] Auto-Capture
> Automatisch aus Session erfasst am ${datum}.`)

  sections.push(`\n## Intent\n\n- Intent: ${k.intent.intent}\n- Confidence: ${k.intent.confidence}\n${k.intent.reasons.map(reason => `- ${reason}`).join('\n')}`)

  sections.push(`\n${renderSessionDigest({
    title: k.title,
    client: k.client,
    clientMatch: k.clientMatch,
    intent: k.intent,
    phases: k.phases,
    summaries: k.summaries,
    procedures: k.procedures,
    errorFixes: k.errorFixes,
    selection: k.selection,
  })}`)

  return sections.join('\n')
}

function injectCaptureMetadata(
  content: string,
  redaction: RedactionResult,
  scores: ReturnType<typeof scoreCapture>,
  session: {
    sessionId: string
    transcriptHash: string
    entryCount: number
    bashCount: number
    generatedAt: string
  },
): string {
  const fields = buildFrontmatter({
    sensitive: redaction.count > 0,
    redactions: redaction.count,
    redaction_types: redaction.types.length > 0 ? redaction.types : ['none'],
    capture_value: scores.captureValue,
    runbook_readiness: scores.runbookReadiness,
    review_need: scores.reviewNeed,
    session_id: session.sessionId,
    transcript_hash: session.transcriptHash,
    transcript_entries: session.entryCount,
    transcript_bash_commands: session.bashCount,
    capture_generated_at: session.generatedAt,
  })
  return content.replace(/^---\n/, `---\n${fields}`)
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
  calibrationSampleSeed?: string
  updatedAt: string
  skippedReason?: string
}

function donePath(sessionId: string): string {
  return join(STATE_DIR, `${safeSessionStateId(sessionId)}.done`)
}

function statePath(sessionId: string): string {
  return join(STATE_DIR, `${safeSessionStateId(sessionId)}.json`)
}

function safeSessionStateId(sessionId: string): string {
  if (/^(?!\.{1,2}$)[a-zA-Z0-9._-]{1,120}$/.test(sessionId)) return sessionId
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`
}

function canonicalCaptureSessionId(sessionId: string): string {
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(sessionId)) return sessionId
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`
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
  writeAtomic(statePath(state.sessionId), `${JSON.stringify(state, null, 2)}\n`)
  writeAtomic(donePath(state.sessionId), state.updatedAt)
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

function writeAtomic(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(temporaryPath, content, 'utf-8')
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary file may already have been renamed or never created.
    }
    throw error
  }
}

function existingGeneratedCapture(fullPath: string, sessionId: string, allowLegacySession: boolean): boolean {
  if (!existsSync(fullPath)) return false
  try {
    const frontmatter = parseFrontmatter(readFileSync(fullPath, 'utf-8'))
    if (frontmatter.quelle !== 'knowledge-harvester') return false
    if (
      typeof frontmatter.session_id === 'string'
      && canonicalCaptureSessionId(frontmatter.session_id) === sessionId
    ) return true
    return allowLegacySession && !frontmatter.session_id
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

    if (
      typeof sessionId !== 'string'
      || !sessionId
      || typeof transcriptPath !== 'string'
      || !transcriptPath
    ) process.exit(0)
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
    const bashCount = entries.filter(e => e.type === 'tool_use' && e.toolName === 'Bash').length
    if (entries.length < 2) process.exit(0)

    const captureSessionId = canonicalCaptureSessionId(sessionId)
    const knowledge = extractKnowledge(entries, cwd, captureSessionId)
    if (!knowledge) {
      log(`Session ${sessionId.slice(0, 8)}: ${entries.length} entries, ${bashCount} bash — keine ausreichend salienten Wissensatome`)
      process.exit(0)
    }

    // If no client detected, check if we can suggest one
    if (!knowledge.client && knowledge.clientMatch.method === 'none') {
      const suggestion = suggestClientFromCwd(cwd)
      if (suggestion) {
        knowledge.clientMatch = {
          client: null,
          confidence: 'low',
          method: 'unknown_cwd',
          matched: null,
          candidate: suggestion,
          score: 0.5,
          reason: `CWD-Segment "${suggestion}" sieht wie ein unbekannter Kunden-/Projektname aus`,
        }
        logSuggestion(suggestion, cwd)
        log(`Session ${sessionId.slice(0, 8)}: Unbekannter Pfad — Vorschlag "${suggestion}" geloggt`)
      }
    } else if (knowledge.clientMatch.method === 'fuzzy_cwd' && knowledge.clientMatch.candidate) {
      logSuggestion(knowledge.clientMatch.candidate, cwd, knowledge.clientMatch.client)
      log(`Session ${sessionId.slice(0, 8)}: Fuzzy-Kunde ${knowledge.clientMatch.client} über "${knowledge.clientMatch.candidate}" als Review-Kandidat erkannt`)
    } else if (['ambiguous_cwd', 'ambiguous_content'].includes(knowledge.clientMatch.method)) {
      log(`Session ${sessionId.slice(0, 8)}: Kundenzuordnung bewusst offen — ${knowledge.clientMatch.reason}`)
    }

    log(`Session ${sessionId.slice(0, 8)}: "${knowledge.title}" — ${knowledge.selection.facts.length}/${knowledge.selection.candidateCount} Wissensatome, ${knowledge.procedures.length} belegte Änderungen, tags: [${knowledge.tags.join(',')}]`)

    // Determine folder:
    // 1. If client detected → Kunden/{Client}
    // 2. Else classify into Technik/{Category}
    // 3. Fallback → Referenz/ (wenn keine Kategorie passt)
    let folder = 'Referenz'
    if (knowledge.client) {
      folder = `Kunden/${knowledge.client}`
    } else {
      const content = [
        ...knowledge.selection.facts.map(fact => fact.statement),
        ...knowledge.routingActions,
      ].join('\n')
      // The chat-derived title is not classification evidence. If no Technik
      // category is supported by the selected evidence, classifyNote abstains
      // and the capture remains in the neutral Referenz folder.
      const classification = classifyNote('', content, knowledge.tags)
      if (classification.category) {
        folder = classification.subcategory
          ? `Technik/${classification.category}/${classification.subcategory}`
          : `Technik/${classification.category}`
        log(`  → Kategorisiert als ${folder} (${classification.reason})`)
      }
    }

    const safeTitle = knowledge.title.replace(/[/\\:*?"<>|]/g, '-').slice(0, 100)
    const previousState = readSessionCaptureState(sessionId)
    const calibrationSampleSeed = previousState?.calibrationSampleSeed
      && /^cs-[a-f0-9]{32}$/.test(previousState.calibrationSampleSeed)
      ? previousState.calibrationSampleSeed
      : `cs-${randomUUID().replaceAll('-', '')}`
    const proposedTarget = `${folder}/${safeTitle}.md`
    let relativeTarget = previousState?.capturePath ?? proposedTarget
    let fullPath = vaultJoin(VAULT_PATH, relativeTarget)
    let canUpdateExisting = existingGeneratedCapture(
      fullPath,
      captureSessionId,
      previousState?.capturePath === relativeTarget,
    )
    if (existsSync(fullPath) && !canUpdateExisting) {
      relativeTarget = uniqueRelativePath(VAULT_PATH, folder, `${safeTitle}.md`)
      fullPath = vaultJoin(VAULT_PATH, relativeTarget)
      canUpdateExisting = false
      log(`Capture target collision; using ${relativeTarget}`)
    }
    assertCanWriteTool('auto_capture', [relativeTarget])
    const fullDir = dirname(fullPath)

    mkdirSync(fullDir, { recursive: true })
    const captureGeneratedAt = new Date().toISOString()
    const rawNoteContent = generateNote(
      knowledge,
      captureGeneratedAt,
      calibrationSampleSeed,
    )
    const redaction = policy.hooks.captureSafety.secretRedaction
      ? (() => {
          const noteRedaction = redactSecrets(rawNoteContent)
          const sourceAudit = redactSecrets(entries.map(entry => entry.content).join('\n'))
          return {
            content: noteRedaction.content,
            count: noteRedaction.count + sourceAudit.count,
            types: [...new Set([...noteRedaction.types, ...sourceAudit.types])],
          }
        })()
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
      selection: knowledge.selection,
    })
    const noteContent = injectCaptureMetadata(redaction.content, redaction, scores, {
      sessionId: captureSessionId,
      transcriptHash: currentTranscriptHash,
      entryCount: entries.length,
      bashCount,
      generatedAt: captureGeneratedAt,
    })
    writeAtomic(fullPath, noteContent)
    markSessionCaptured({
      version: 2,
      sessionId,
      transcriptHash: currentTranscriptHash,
      entryCount: entries.length,
      bashCount,
      capturePath: relativeTarget,
      calibrationSampleSeed,
      updatedAt: new Date().toISOString(),
    })
    log(`${canUpdateExisting ? 'Updated capture' : 'Captured'}: ${relativeTarget}`)

    appendActionLog(VAULT_PATH, {
      tool: 'auto_capture',
      mode: 'apply',
      targets: [relativeTarget],
      summary: `${canUpdateExisting ? 'Session-Capture aktualisiert' : 'Session-Capture'}: "${knowledge.title}" (${knowledge.selection.facts.length} Wissensatome)`,
      meta: {
        sessionId: captureSessionId,
        tags: knowledge.tags,
        client: knowledge.client,
        clientMatch: knowledge.clientMatch,
        intent: knowledge.intent,
        redactions: redaction.count,
        scores,
        salience: {
          sessionId: knowledge.selection.sessionId,
          modelVersion: knowledge.selection.modelVersion,
          scoreScale: knowledge.selection.scoreScale,
          factIds: knowledge.selection.facts.map(fact => fact.id),
          salienceScores: knowledge.selection.facts.map(fact => fact.salienceScore),
          evidenceScores: knowledge.selection.facts.map(fact => fact.evidenceScore),
          candidateCount: knowledge.selection.candidateCount,
          excluded: knowledge.selection.excluded,
        },
      },
    })

    // Append to daily note
    const datum = new Date().toISOString().split('T')[0]
    const dailyRelativePath = `Daily/${datum}.md`
    try {
      const dailyPath = vaultJoin(VAULT_PATH, dailyRelativePath)
      if (!canUpdateExisting && policy.hooks.appendDailyCaptureLink && existsSync(dailyPath)) {
        assertCanWriteTool('daily_note', [dailyRelativePath])
        appendFileSync(dailyPath, `\n- Auto-Capture: [[${relativeTarget.replace(/\.md$/, '')}|${knowledge.title}]]\n`)
        appendActionLog(VAULT_PATH, {
          tool: 'daily_note',
          mode: 'apply',
          targets: [dailyRelativePath],
          summary: `Auto-Capture-Link in Daily Note eingetragen`,
          meta: { link: relativeTarget },
        })
      }
    } catch (error) {
      log(`Daily-Link übersprungen: ${error instanceof Error ? error.message : String(error)}`)
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
