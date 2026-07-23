import { createHash } from 'node:crypto'
import {
  applyEvidenceConflictCeiling,
  EVIDENCE_SCORING_MODEL,
  scoreEvidence,
  type EvidenceProvenanceSource,
} from './evidence-scoring.ts'
import { redactSecrets } from './secret-redaction.ts'

/**
 * The scores produced here are deterministic ordinal rankings, not
 * probabilities. Bumping this version is required when weights, extraction,
 * or confidence thresholds change in a way that can alter persisted facts.
 */
export const KNOWLEDGE_SALIENCE_MODEL = {
  version: 'knowledge-salience-v1',
  scoreScale: 'ordinal_0_100_not_probability',
  evidenceModelVersion: EVIDENCE_SCORING_MODEL.version,
  weights: {
    taskRelevance: 0.3,
    decisionOutcomeUtility: 0.25,
    noveltyInformativeness: 0.2,
    reusability: 0.15,
    specificity: 0.1,
  },
  confidenceThresholds: {
    high: 75,
    medium: 45,
  },
} as const

export type KnowledgeFactKind =
  | 'cause'
  | 'decision'
  | 'change'
  | 'verification'
  | 'result'
  | 'problem'
  | 'open_question'
  | 'constraint'

export type KnowledgeConfidence = 'low' | 'medium' | 'high'

export type KnowledgeProvenanceSource = EvidenceProvenanceSource

export interface KnowledgeSessionPhase {
  id?: string
  userRequest: string
  outcome: string
  commandCount?: number
  hadError?: boolean
}

export interface KnowledgeAssistantSummary {
  id?: string
  text: string
}

export interface KnowledgeErrorFix {
  id?: string
  error: string
  fix: string
}

export interface KnowledgeBashEvidence {
  id?: string
  command: string
  result: string
  isError?: boolean
  exitCode?: number
}

export interface KnowledgeSalienceInput {
  sessionId: string
  task?: string
  phases?: KnowledgeSessionPhase[]
  assistantSummaries?: Array<string | KnowledgeAssistantSummary>
  errorFixes?: Array<string | KnowledgeErrorFix>
  bashEvidence?: KnowledgeBashEvidence[]
  /** Existing durable facts used only to estimate novelty. */
  knownKnowledge?: string[]
  maxFacts?: number
  minSalienceScore?: number
  /** Relevance share in maximal marginal relevance selection. */
  mmrLambda?: number
  /** Similarity at which a candidate is treated as redundant. */
  redundancyThreshold?: number
  /** Optional semantic scope explicitly requested by the user. */
  allowedKinds?: readonly KnowledgeFactKind[]
}

export interface KnowledgeFactFactors {
  taskRelevance: number
  decisionOutcomeUtility: number
  noveltyInformativeness: number
  reusability: number
  specificity: number
}

export function scoreKnowledgeSalienceFactors(factors: KnowledgeFactFactors): number {
  return Math.round(
    factors.taskRelevance * KNOWLEDGE_SALIENCE_MODEL.weights.taskRelevance * 100
      + factors.decisionOutcomeUtility * KNOWLEDGE_SALIENCE_MODEL.weights.decisionOutcomeUtility * 100
      + factors.noveltyInformativeness * KNOWLEDGE_SALIENCE_MODEL.weights.noveltyInformativeness * 100
      + factors.reusability * KNOWLEDGE_SALIENCE_MODEL.weights.reusability * 100
      + factors.specificity * KNOWLEDGE_SALIENCE_MODEL.weights.specificity * 100,
  )
}

export interface KnowledgeProvenance {
  ref: string
  source: KnowledgeProvenanceSource
  /** SHA-256 of the normalized, redacted evidence represented by this ref. */
  hash: string
  /** Short, redacted evidence only; never the full assistant message/output. */
  excerpt: string
  /** Stable evidence unit; one transcript span may not corroborate itself. */
  origin?: string
}

export interface KnowledgeFactAbstraction {
  template: string
  slots: Readonly<Record<'fact', string>>
  rendered: string
}

export interface KnowledgeSalienceFact {
  id: string
  modelVersion: string
  kind: KnowledgeFactKind
  statement: string
  abstraction: KnowledgeFactAbstraction
  factors: KnowledgeFactFactors
  salienceScore: number
  evidenceScore: number
  confidence: KnowledgeConfidence
  /** Opposing assertions are review-only even when one source is strong. */
  evidenceConflict?: boolean
  provenance: KnowledgeProvenance[]
  /** MMR rank score; an ordinal selector value, not a probability. */
  selectionScore: number
}

export interface KnowledgeSalienceSelection {
  sessionId: string
  modelVersion: string
  scoreScale: typeof KNOWLEDGE_SALIENCE_MODEL.scoreScale
  facts: KnowledgeSalienceFact[]
  /**
   * Safe, deduplicated pre-selection universe. This is used only to draw a
   * seeded, blinded calibration sample; it is never rendered as
   * durable knowledge or consumed by downstream automation.
   */
  calibrationCandidates?: Array<Omit<KnowledgeSalienceFact, 'selectionScore'>>
  candidateCount: number
  excluded: {
    unsafeOrNoisy: number
    belowSalienceThreshold: number
    redundant: number
  }
}

export const KNOWLEDGE_FACT_TEMPLATES: Readonly<Record<KnowledgeFactKind, string>> = {
  cause: 'Cause: {fact}',
  decision: 'Decision: {fact}',
  change: 'Change: {fact}',
  verification: 'Verification: {fact}',
  result: 'Result: {fact}',
  problem: 'Problem: {fact}',
  open_question: 'Open question: {fact}',
  constraint: 'Constraint: {fact}',
}

interface Candidate {
  kind: KnowledgeFactKind
  statement: string
  provenance: KnowledgeProvenance[]
  taskContexts: string[]
  explicitness: number
  evidenceConflict: boolean
}

interface DraftFact extends Omit<KnowledgeSalienceFact, 'selectionScore'> {}

const MAX_STATEMENT_LENGTH = 240
const MAX_EXCERPT_LENGTH = 180

const STOP_WORDS = new Set([
  'aber', 'also', 'auch', 'auf', 'aus', 'bei', 'das', 'dem', 'den', 'der', 'des', 'die', 'ein', 'eine',
  'einem', 'einen', 'einer', 'für', 'fuer', 'hat', 'haben', 'ist', 'mit', 'nach', 'oder', 'sich', 'sind',
  'und', 'von', 'war', 'waren', 'wird', 'wurde', 'wurden', 'zu', 'zum', 'zur', 'the', 'a', 'an', 'and',
  'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from', 'has', 'have', 'in', 'is', 'it', 'of', 'on', 'or',
  'that', 'this', 'to', 'was', 'were', 'will', 'with', 'decision', 'entscheidung',
])

// Removing grammatical glue creates a compact proposition instead of an
// extractive quote. Negation and modality (for example "not" and "must") are
// deliberately absent from this set because changing them changes the fact.
const ABSTRACTION_GLUE = new Set([
  ...STOP_WORDS,
  'am', 'been', 'being', 'could', 'did', 'does', 'doing', 'had', 'having', 'our', 'their', 'them',
  'they', 'we', 'were', 'which', 'who', 'would', 'you', 'your', 'als', 'dabei', 'dann', 'dass', 'diese',
  'diesem', 'diesen', 'dieser', 'dieses', 'durch', 'hatte', 'hier', 'ihre', 'ihrem', 'ihren', 'ihrer',
  'ihres', 'kann', 'konnte', 'noch', 'nun', 'sehr', 'sie', 'sowie', 'über', 'ueber', 'unser', 'unsere',
])

const RELATION_TOKENS = new Set([
  'für', 'fuer', 'gegen', 'wenn', 'falls', 'über', 'ueber', 'unter', 'vor', 'nach',
  'between', 'against', 'for', 'if', 'when', 'over', 'under', 'before', 'after',
])

const SECRET_VALUE = /(?:-----BEGIN\s+(?:OPENSSH|RSA|DSA|EC|ED25519)?\s*PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{12,}\b|\b(?:authorization\s*:\s*bearer|api[_-]?key|token|secret|passw(?:ort|örter|oerter)?|password|passwd|pwd|credential)\s*[:=]\s*[`"']?\S{8,}|--(?:newpassword|password|passwd|token|secret)(?:=|\s+)\S+)/i
const COMMAND_START = /^(?:\$\s*)?(?:sudo\s+|ssh\s+|docker\s+|kubectl\s+|systemctl\s+|journalctl\s+|curl\s+|wget\s+|sed\s+|awk\s+|grep\s+|find\s+|npm\s+|pnpm\s+|yarn\s+|git\s+)/i
const NOISE = /^(?:ok(?:ay|ey)?|alles klar|verstanden|ich (?:prüfe|pruefe|schaue|werde|kann)|wir (?:prüfen|pruefen|schauen)|hier ist|lass mich|let me|i(?:'ll| will) (?:check|inspect)|zwei|drei|mehrere hinweise sind wichtig|(?:die\s+)?dauerhafte notiz soll|gleichzeitig\s+(?:war|ist|wurde).*konfiguriert|(?:zusammenfassung:\s*)?(?:frühe|fruehe) planung (?:ist )?dokumentiert|(?:zusammenfassung:\s*)?das ist noch nicht der endbefund)\b/i
const RESULT_SIGNAL = /\b(?:ergebnis|result|erfolgreich|success|succeeded|completed|abgeschlossen|funktioniert|works?|wiederhergestellt|ready|bereit|installed|installiert|erreichbar|available|verfügbar|verfuegbar)\b/i
const CAUSE_SIGNAL = /\b(?:root cause|ursache|caused by|because|because of|due to|lag an|ausgelöst durch|ausgeloest durch|zurückzuführen|zurueckzufuehren|deshalb|therefore)\b/i
const DECISION_SIGNAL = /\b(?:entscheidung|entschieden|festgelegt|verbindlich festgehalten|gewählt|gewaehlt|beschlossen|decided|decision|selected|chosen|chose|we will use|wir nutzen)\b/i
const CHANGE_SIGNAL = /\b(?:änderung|aenderung|change|geändert|geaendert|umgestellt|angepasst|ersetzt|entfernt|eingetragen|vorbereitet|verschoben|umbenannt|installiert|konfiguriert|migriert|aktualisiert|behoben|repariert|neu gestartet|restarted|changed|updated|replaced|removed|installed|configured|migrated|fixed|enabled|disabled)\b/i
const VERIFICATION_SIGNAL = /\b(?:verifiziert|validiert|bestätigt|bestaetigt|verified|validated|confirmed|test(?:s)? (?:passed|bestanden)|active|running|lauscht|listening|healthy|erreichbar|responded)\b/i
const PROBLEM_SIGNAL = /(?:\b(?:fehler|problem|exception|failed|failure|fehlgeschlagen|inactive|unavailable|nicht erreichbar|not found|missing|fehlt|kaputt|broken|timeout|linkdown|no-carrier)\b|\bkein(?:e[nrms]?)?\s+(?:[\w.-]+\s+){0,2}(?:block|eintrag|record|resolver|konfiguration|config|route|datei|file)\b)/i
const OPEN_QUESTION_SIGNAL = /\b(?:offen(?:e|er|es)?|unklar|zu prüfen|zu pruefen|nächster schritt|naechster schritt|todo|open question|needs investigation|to investigate)\b/i
const CONSTRAINT_SIGNAL = /\b(?:wenn|falls|muss|müssen|muessen|darf nicht|nur wenn|voraussetzung|[a-zäöüß]*bedingung|schwellenwert|threshold|beschränkung|beschraenkung|constraint|requires?|must|must not|only if|cannot|limitation)\b/i
const NON_DURABLE_NEGATIVE = /\b(?:nicht\s+(?:mehr\s+)?reproduzierbar|kein(?:e[nrms]?)?\s+(?:auffällig(?:er|en|es)?|auffaellig(?:er|en|es)?|verwertbar(?:er|en|es)?|reproduzierbar(?:er|en|es)?|belastbar(?:er|en|es)?)\s+(?:zustand|hinweis|befund|ergebnis|lehre)|keine\s+(?:änderung|aenderung|entscheidung|belastbare\s+lehre)|einzigen?\s+dauerhaften?\s+informationen?\s+(?:dieser\s+)?session)\b/i

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function redactExtraSecrets(value: string): string {
  return redactSecrets(value).content
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, '[REDACTED_TOKEN]')
}

function containsSecret(value: string): boolean {
  return SECRET_VALUE.test(value) || redactSecrets(value).count > 0
}

function truncateAtWord(value: string, maxLength: number): string {
  const clean = normalizeSpace(value)
  if (clean.length <= maxLength) return clean
  const head = clean.slice(0, maxLength + 1)
  const boundary = head.lastIndexOf(' ')
  return `${head.slice(0, boundary >= maxLength * 0.65 ? boundary : maxLength).trimEnd()}…`
}

function cleanMarkdown(value: string): string {
  return normalizeSpace(value
    .replace(/<task-notification[\s\S]*?(?:<\/task-notification>|$)/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    // Keep underscores because they are part of technical identifiers such as
    // `request_timestamp`; asterisks still remove Markdown emphasis.
    .replace(/[`~>#]/g, ' ')
    .replace(/^(?:[-+]\s+|\d{1,3}[.)]\s+)/, ' '))
}

function atomicSegments(value: string): string[] {
  const withoutBlocks = value
    .replace(/<task-notification[\s\S]*?(?:<\/task-notification>|$)/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\r/g, '')
    .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, '\n')
  const lines = withoutBlocks
    .split(/\n+|(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9`])/u)
    .flatMap(part => {
      const marker = /\s+und\s+/gi
      const splitAt: number[] = []
      for (const match of part.matchAll(marker)) {
        const right = part.slice((match.index ?? 0) + match[0].length)
        const left = part.slice(0, match.index)
        if (CHANGE_SIGNAL.test(right) && (DECISION_SIGNAL.test(left) || CHANGE_SIGNAL.test(left))) {
          splitAt.push(match.index ?? 0)
          break
        }
      }
      if (splitAt.length === 0) return [part]
      const index = splitAt[0]
      return [part.slice(0, index), part.slice(index).replace(/^\s*und\s+/i, '')]
    })
    .flatMap(part => part.length > MAX_STATEMENT_LENGTH ? part.split(/;\s+|\s+[–—]\s+/) : [part])
    .map(cleanMarkdown)
    .map(part => truncateAtWord(part, MAX_STATEMENT_LENGTH))
    .filter(part => part.length >= 12)
  return [...new Set(lines)]
}

function isUnsafeOrNoisyText(value: string, trustedSynthetic = false): boolean {
  const clean = normalizeSpace(value)
  if (!clean || containsSecret(clean) || NOISE.test(clean) || NON_DURABLE_NEGATIVE.test(clean)) return true
  if (/^<(?:command|system|local-command|user-prompt)\b/i.test(clean)) return true
  if (!trustedSynthetic && COMMAND_START.test(clean)) return true
  if (/^[\W_]*(?:progress|debug|trace|verbose)\b/i.test(clean)) return true
  const punctuation = (clean.match(/[|;&]/g) ?? []).length
  return clean.length > 180 && punctuation >= 4
}

function sourceKey(id: string | undefined, fallback: string): string {
  const clean = id?.trim()
  if (clean && /^[\p{L}\p{N}._:@-]{1,80}$/u.test(clean) && !containsSecret(clean)) return clean
  return sha256(normalizeSpace(fallback)).slice(0, 16)
}

function provenance(
  source: KnowledgeProvenanceSource,
  key: string,
  evidence: string,
  excerpt = evidence,
  origin = `${source}:${key}`,
): KnowledgeProvenance {
  const safeEvidence = normalizeSpace(redactExtraSecrets(evidence))
  return {
    ref: `${source}:${key}`,
    source,
    hash: sha256(safeEvidence),
    excerpt: truncateAtWord(redactExtraSecrets(excerpt), MAX_EXCERPT_LENGTH),
    origin: truncateAtWord(redactExtraSecrets(origin), 120),
  }
}

function classifyKind(value: string, fallback: KnowledgeFactKind = 'result'): KnowledgeFactKind {
  if (/^\s*(?:root cause|ursache)(?:\b|\s*[:&-])/i.test(value)) return 'cause'
  if (OPEN_QUESTION_SIGNAL.test(value) || /\?$/.test(value.trim())) return 'open_question'
  if (DECISION_SIGNAL.test(value)) return 'decision'
  if (CONSTRAINT_SIGNAL.test(value)) return 'constraint'
  if (CAUSE_SIGNAL.test(value) && PROBLEM_SIGNAL.test(value)) return 'cause'
  if (PROBLEM_SIGNAL.test(value)) return 'problem'
  if (/^\s*(?:verifikation|verification|verifiziert|verified|validiert|validated)\b/i.test(value)) return 'verification'
  if (CHANGE_SIGNAL.test(value)) return 'change'
  if (VERIFICATION_SIGNAL.test(value)) return 'verification'
  if (CAUSE_SIGNAL.test(value)) return 'cause'
  if (RESULT_SIGNAL.test(value)) return 'result'
  return fallback
}

function abstractionTokens(value: string): string[] {
  const tokens = value.match(/https?:\/\/[^\s]+|\/[\w./@:+-]+|[\p{L}\p{N}][\p{L}\p{N}._/@:+-]*/gu) ?? []
  const retained = tokens.filter(token => {
    const normalized = token.toLowerCase()
    return RELATION_TOKENS.has(normalized) || !ABSTRACTION_GLUE.has(normalized)
  })
  const selected = retained.slice(0, 6)

  // Preserve one late technical literal within the fixed compression budget.
  for (const token of retained.slice(6).reverse()) {
    const durableAnchor = /(?:\d|[/@:]|\.[\p{L}\p{N}]|disabled|missing|fehlt|linkdown|inactive|rollback|rückroll|rueckroll)/iu.test(token)
      || /^[A-ZÄÖÜ][A-ZÄÖÜ0-9-]{1,}$/.test(token)
    if (!durableAnchor || selected.includes(token)) continue
    if (selected.length === 0) selected.push(token)
    else selected[selected.length - 1] = token
    break
  }
  return selected
}

function compressClause(value: string): string {
  const tokens = abstractionTokens(value)
  if (tokens.length === 0) return ''
  const chunks: string[] = []
  for (let index = 0; index < tokens.length; index += 6) {
    chunks.push(tokens.slice(index, index + 6).join(' '))
  }
  // The canonical detail marker also provides a hard anti-verbatim boundary:
  // no emitted statement can copy more than six consecutive source words.
  return chunks.join('; detail: ')
}

function normalizedStatement(value: string, kind: KnowledgeFactKind): string {
  let clean = cleanMarkdown(value)
    .replace(/^(?:zusammenfassung|summary|erledigt|befund|ergebnis|result)\s*:\s*/i, '')
  const original = clean

  const kindPrefix: Partial<Record<KnowledgeFactKind, RegExp>> = {
    cause: /^(?:root cause|ursache)(?:\s+(?:war|ist|was))?\s*:?\s*/i,
    decision: /^(?:(?:wir|we)\s+(?:haben\s+)?(?:uns\s+)?(?:entschieden|decided)|entscheidung)\s*[:,]?\s*/i,
    change: /^(?:änderung|aenderung|change|fix)\s*:\s*/i,
    verification: /^(?:verifikation|verification|verifiziert|verified)\s*:\s*/i,
    problem: /^(?:problem|fehler|error)\s*:\s*/i,
    open_question: /^(?:offene frage|open question|todo)\s*:\s*/i,
    constraint: /^(?:voraussetzung|beschränkung|beschraenkung|constraint)\s*:\s*/i,
  }
  const prefix = kindPrefix[kind]
  if (prefix) clean = clean.replace(prefix, '')

  const wrongPortTarget = original.match(/port\s+(\d+)[\s\S]*?\b(OPNsense)\b[\s\S]*?\b(?:statt(?:\s+auf)?|instead of)\s+(\d+(?:\.\d+){3})/i)
  const linkdownDefaultRoute = kind === 'problem'
    && /(?:default-route|\bdefault\b)/i.test(original)
    && /\blinkdown\b/i.test(original)
    ? original.match(/\b(vmbr[\w.-]+)\b/i)
    : null
  const sourcedDisabledFile = kind === 'cause'
    ? original.match(/\bsource\s+(\/[^\s,;]*\*)[\s\S]*?\b(?:jede|all|every)\b[\s\S]*?\b(?:datei|file)\b[\s\S]*?\.disabled\b/i)
    : null
  if (linkdownDefaultRoute) {
    clean = `Default-Route über ${linkdownDefaultRoute[1]}: linkdown`
  } else if (wrongPortTarget) {
    clean = `Port ${wrongPortTarget[1]}: ${wrongPortTarget[2]} statt ${wrongPortTarget[3]}`
  } else if (sourcedDisabledFile) {
    // Keep the operational rule, not the assistant's sentence: sourced globs
    // do not ignore a file merely because its suffix says ".disabled".
    clean = `Glob ${sourcedDisabledFile[1]}: jede Datei einschließlich .disabled geladen`
  } else if (kind === 'constraint' && /(?:rollback|rückroll|rueckroll)/i.test(original) && /fehlerrate/i.test(original)) {
    const percentage = original.match(/(?:über|ueber|mehr\s+als)?\s*(\d+(?:[.,]\d+)?|fünf|fuenf|funf|five)\s*(?:prozent|percent|%)/i)?.[1]
    const duration = original.match(/(\d+|zehn|ten)\s*minuten?/i)?.[1]
    clean = `Rollback bei ${percentage ? `${percentage} Prozent` : 'definierter'} Fehlerrate${duration ? ` innerhalb ${duration} Minuten` : ''}`
  } else if (kind === 'cause') {
    const causal = clean.match(/^(.+?)\s+(?:because|weil|due to|caused by|ausgelöst durch|ausgeloest durch)\s+(.+)$/i)
    if (causal) {
      const effect = compressClause(causal[1])
      const cause = compressClause(causal[2])
      clean = `${cause}; caused: ${effect}`
    } else {
      clean = compressClause(clean)
    }
  } else {
    clean = compressClause(clean)
  }

  clean = truncateAtWord(clean, MAX_STATEMENT_LENGTH)
  if (!clean) return clean
  const punctuation = kind === 'open_question' ? '?' : '.'
  const withoutTerminal = clean.replace(/[.!?]+$/, '')
  return `${withoutTerminal.charAt(0).toUpperCase()}${withoutTerminal.slice(1)}${punctuation}`
}

function meaningfulTokens(value: string): string[] {
  const normalized = normalizeSpace(value.toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}._/@:-]+/gu, ' '))
    .split(' ')
    .map(token => token.replace(/[.,]+$/u, ''))
    .filter(token => token.length >= 3 && !STOP_WORDS.has(token))
    .map(token => {
      if (/postgres(?:ql)?/.test(token)) return 'postgresql'
      if (/^(?:select(?:ed)?|chos(?:e|en)|choose|using|uses?|gewahlt|waehlt|entschieden)$/.test(token)) return 'use'
      if (/^persist(?:ent|ed|ence|ieren|iert)?$/.test(token) || /^speicher(?:n|t)?$/.test(token)) return 'persist'
      if (/^[\p{L}]{7,}$/u.test(token)) return token.replace(/(?:ungen|igkeit|keiten|ung|ern|en|er|es|e|s)$/u, '')
      return token
    })
  return normalized.flatMap(token => {
    const parts = token
      .split(/[._/@:-]+/)
      .filter(part => part.length >= 3 && /\p{L}/u.test(part) && !STOP_WORDS.has(part))
    return [...new Set([token, ...parts])]
  })
}

function tokenSimilarity(left: string, right: string): number {
  const a = new Set(meaningfulTokens(left))
  const b = new Set(meaningfulTokens(right))
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection++
  const union = a.size + b.size - intersection
  const jaccard = intersection / Math.max(1, union)
  const containment = intersection / Math.max(1, Math.min(a.size, b.size))
  return clamp(jaccard * 0.58 + containment * 0.42)
}

function redundancySimilarity(left: string, right: string): number {
  const base = tokenSimilarity(left, right)
  const a = new Set(meaningfulTokens(left))
  const b = new Set(meaningfulTokens(right))
  if (a.size === 0 || b.size === 0) return base
  let shared = 0
  const sharedTokens: string[] = []
  for (const token of a) {
    if (!b.has(token)) continue
    shared++
    sharedTokens.push(token)
  }
  const containment = shared / Math.max(1, Math.min(a.size, b.size))
  const sharedNumericAnchors = sharedTokens.filter(token =>
    /\d/.test(token)
      || /^(?:null|zero|ein|eins|eine|one|zwei|two|drei|three|vier|four|fünf|funf|fuenf|five|sechs|six|sieben|seven|acht|eight|neun|nine|zehn|ten)$/.test(token)).length
  const sharedTechnicalAnchors = sharedTokens.filter(token =>
    /(?:\/|(?:\d+\.){2,}|:\d|[\p{L}\p{N}]+[._-][\p{L}\p{N}]+)/u.test(token)).length
  // Repeated formulations often differ in glue verbs while retaining the
  // same target, value and time/threshold. Three shared content anchors with
  // majority containment are therefore a duplicate, not additional evidence.
  return (shared >= 3 && containment >= 0.4)
      || sharedNumericAnchors >= 2
      || (sharedTechnicalAnchors >= 1 && shared >= 2)
    ? Math.max(base, 0.9)
    : base
}

type AssertionPolarity = -1 | 0 | 1

const POLARITY_PREDICATE = '(?:restart(?:ed)?|start(?:ed)?|stop(?:ped)?|chang(?:e|ed)|replac(?:e|ed)|remov(?:e|ed)|install(?:ed)?|configur(?:e|ed)|migrat(?:e|ed)|enable(?:d)?|disable(?:d)?|verif(?:y|ied)|validat(?:e|ed)|pass(?:ed)?|activ(?:e|ated)|running|available|reachable|neu\\s+gestartet|geändert|geaendert|ersetzt|entfernt|installiert|konfiguriert|migriert|aktiv|erreichbar)'
const NEGATED_PREDICATE = new RegExp(`\\b(?:not|never|nicht)\\s+(?:\\w+\\s+){0,3}${POLARITY_PREDICATE}\\b|\\b(?:kein|keine|keinen|keinem|keiner)\\s+(?:\\w+\\s+){0,3}(?:änderung|aenderung|migration|verifikation|validierung|erfolg|neustart)\\b`, 'i')
const POSITIVE_PREDICATE = new RegExp(`\\b${POLARITY_PREDICATE}\\b`, 'i')

function assertionPolarity(value: string): AssertionPolarity {
  if (NEGATED_PREDICATE.test(value)) return -1
  if (POSITIVE_PREDICATE.test(value) || CHANGE_SIGNAL.test(value) || VERIFICATION_SIGNAL.test(value)) return 1
  return 0
}

function polarityCompatible(left: string, right: string): boolean {
  const a = assertionPolarity(left)
  const b = assertionPolarity(right)
  return a === 0 || b === 0 || a === b
}

function semanticKey(candidate: Candidate): string {
  return `${candidate.kind}:${[...new Set(meaningfulTokens(candidate.statement))].sort().join('|')}`
}

function factAbstraction(kind: KnowledgeFactKind, statement: string): KnowledgeFactAbstraction {
  const template = KNOWLEDGE_FACT_TEMPLATES[kind]
  return {
    template,
    slots: { fact: statement },
    rendered: template.replace('{fact}', statement),
  }
}

function makeCandidate(
  raw: string,
  provenanceItem: KnowledgeProvenance,
  taskContext: string,
  fallbackKind: KnowledgeFactKind,
  explicitness = 0.5,
  trustedSynthetic = false,
): Candidate | null {
  if (isUnsafeOrNoisyText(raw, trustedSynthetic)) return null
  const kind = classifyKind(raw, fallbackKind)
  const statement = normalizedStatement(raw, kind)
  if (statement.length < 12 || meaningfulTokens(statement).length < 2) return null
  return {
    kind,
    statement,
    provenance: [provenanceItem],
    taskContexts: taskContext ? [taskContext] : [],
    explicitness,
    evidenceConflict: false,
  }
}

function addTextCandidates(
  candidates: Candidate[],
  value: string,
  source: KnowledgeProvenanceSource,
  refBase: string,
  taskContext: string,
  fallbackKind: KnowledgeFactKind,
  explicitness: number,
  origin?: string,
): number {
  let excluded = 0
  const segments = atomicSegments(value)
  if (segments.length === 0 && normalizeSpace(value)) excluded++
  for (const segment of segments) {
    const ref = `${refBase}:${sha256(segment).slice(0, 10)}`
    const item = provenance(source, ref, segment, segment, origin)
    const candidate = makeCandidate(segment, item, taskContext, fallbackKind, explicitness)
    if (candidate) candidates.push(candidate)
    else excluded++
  }
  return excluded
}

function parseErrorFix(value: string): { error: string; fix: string } | null {
  const match = value.match(/(?:\*{0,2})(?:fehler|error)(?:\*{0,2})\s*:\s*([\s\S]*?)(?=(?:\*{0,2})(?:fix|lösung|loesung|workaround)(?:\*{0,2})\s*:)(?:\*{0,2})(?:fix|lösung|loesung|workaround)(?:\*{0,2})\s*:\s*([\s\S]+)/i)
  if (!match) return null
  return { error: cleanMarkdown(match[1]), fix: cleanMarkdown(match[2]) }
}

function isSensitiveOrVerboseCommand(command: string): boolean {
  const clean = command.trim()
  if (!clean || containsSecret(clean)) return true
  if (clean.length > 260 || /\n|<<|\bbase64\b|\b(?:\.env|id_rsa|credentials?)\b/i.test(clean)) return true
  return (clean.match(/(?:&&|\|\||[|;])/g) ?? []).length > 3
}

function stripSsh(command: string): string {
  const clean = normalizeSpace(command)
  const quoted = clean.match(/^ssh\s+(?:(?:-[^\s]+)(?:\s+[^\s]+)?\s+)*[^\s]+\s+["']([\s\S]+)["']$/i)
  return quoted?.[1]?.trim() || clean
}

function shortResult(result: string): string | null {
  const safe = redactExtraSecrets(result)
  const lines: string[] = []
  for (const line of safe.split(/\n+/)) {
    const clean = cleanMarkdown(line)
    if (!clean || containsSecret(line)) continue
    if (/^(?:progress|debug|trace|npm warn|download(?:ing)?|\d+%)\b/i.test(clean)) continue
    lines.push(clean)
    if (lines.length >= 2) break
  }
  return lines.length > 0 ? truncateAtWord(lines.join('; '), 140) : null
}

function bashSubject(command: string): string {
  const service = command.match(/\bsystemctl\s+(?:--\S+\s+)*(?:is-active|status|restart|start|stop|enable|disable)\s+(?:--\S+\s+)*([\w@.-]+)/i)?.[1]
  if (service) return `service ${service}`
  const port = command.match(/(?::|-p\s+)(\d{2,5})\b/)?.[1]
  if (/\b(?:ss|netstat|lsof|nmap)\b/i.test(command) && port) return `port ${port}`
  if (/\b(?:npm|pnpm|yarn|node)\s+(?:run\s+)?test\b|\b(?:pytest|cargo test|go test)\b/i.test(command)) return 'test run'
  if (/\bdocker\s+compose\b/i.test(command)) return 'Docker Compose services'
  if (/\b(?:apt|apt-get|dnf|yum|pacman)\s+(?:-\S+\s+)*install\b/i.test(command)) return 'package installation'
  const executable = command.match(/^(?:sudo\s+)?([\w./-]+)/)?.[1]?.split('/').pop()
  return executable ? `${executable} operation` : 'command'
}

function bashMutationTarget(command: string): string | null {
  const move = command.match(/\b(?:mv|cp)\s+(?:-\S+\s+)*([^\s]+)\s+([^\s;&|]+)/i)
  if (move) return `${move[1]} -> ${move[2]}`
  const file = command.match(/\b(?:tee(?:\s+-\S+)*|sed\s+-i(?:\s+[^\s]+)?)\s+([^\s;&|]+)/i)?.[1]
  return file ?? null
}

function bashRedirectChange(command: string): string | null {
  const match = command.match(/\bprintf\s+['"]?([^'"\s]+)['"]?\s*>\s*([^\s;&|]+)/i)
  if (!match) return null
  return `${match[2]} set to ${match[1]}`
}

function bashSedChange(command: string): string | null {
  const match = command.match(/\bsed\s+-i\s+['"]s\/([^/]+)\/([^/]+)\/[g]?['"]\s+([^\s;&|"']+)/i)
  if (!match) return null
  const from = cleanMarkdown(match[1]).replace(/^[\^\s]+/, '').trim()
  const to = cleanMarkdown(match[2]).trim()
  const target = match[3]
  return `${target}: ${from} -> ${to}`
}

function bashCandidate(pair: KnowledgeBashEvidence, taskContext: string): Candidate | null {
  const inner = stripSsh(pair.command)
  if (isSensitiveOrVerboseCommand(inner) || containsSecret(pair.result)) return null
  const mutation = /\b(?:restart|start|stop|enable|disable|install|remove|purge|update|upgrade|apply|create|delete|write|set|replace|mv|cp|tee|sed\s+-i|docker\s+compose\s+up)\b/i.test(inner)
    || /(?:^|\s)(?:>|>>)\s*\S+/.test(inner)
  const result = shortResult(pair.result)
    ?? (mutation && pair.exitCode === 0 ? 'exit code 0; no output' : null)
  if (!result) return null

  if (/^(?:pwd|ls(?:\s|$)|find(?:\s|$)|git\s+status(?:\s|$))/i.test(inner)) return null
  if (/^ip\s+-br\s+(?:link|addr|a)(?:\s+show)?\s*$/i.test(inner)) return null
  if (/\s--version(?:\s|$)|^(?:\S+\s+)?--version(?:\s|$)/i.test(inner)) return null
  if (/^grep\b/i.test(inner)) return null
  if (/^sudo\s+-n\b/i.test(inner) && /password (?:is )?required/i.test(result)) return null
  if (/^timeout\b/i.test(inner) && /^(?:ok|success)$/i.test(result)) return null

  const subject = bashSubject(inner)
  const testCommand = /\b(?:npm|pnpm|yarn|node)\s+(?:run\s+)?test\b|\b(?:pytest|cargo test|go test)\b/i.test(inner)
  const maskedExit = /\|\|\s*true\b|;\s*(?:exit\s+0|true)\b/i.test(inner)
  const negativeTestResult = testCommand && /(?:\bnot pass(?:ed)?\b|\bdid not pass\b|\b0 tests? passed\b|\bno tests? (?:found|run)\b|\b[1-9]\d* (?:tests? )?failed\b|\bfailures?\s*[:=]\s*[1-9]\d*)/i.test(result)
  const explicitPositiveTest = /\b(?:[1-9]\d* tests? passed|all tests? passed|test(?:s)? passed|ok)\b/i.test(result)
  const negativeResult = negativeTestResult
    || /\b(?:inactive|dead|failed|failure|error|exception|keyerror|not found|missing|unavailable|unreachable|linkdown|no-carrier|permission denied|not permitted|timeout|timed out)\b/i.test(result)
  const failed = pair.isError === true || (pair.exitCode !== undefined && pair.exitCode !== 0) || negativeResult
  const verification = /\b(?:is-active|status|show|check|test|verify|ss\s|netstat|lsof|nmap|curl|ping|grep)\b/i.test(inner)
    && (!testCommand || !maskedExit || explicitPositiveTest)
  let kind: KnowledgeFactKind
  let statement: string
  const route = result.match(/(\d+(?:\.\d+){3}\/\d+)\s+via\s+\d+(?:\.\d+){3}\s+dev\s+([\w.-]+)/i)
  const failedDefaultRoute = result.match(/\bdefault\s+via\s+(\d+(?:\.\d+){3})\s+dev\s+([\w.-]+)[^;\n]*\blinkdown\b/i)
  const synologyHosts = [...result.matchAll(/(\d+(?:\.\d+){3})[^;]*?(?:synology|DSM)/gi)]

  if (failed) {
    kind = 'problem'
    statement = failedDefaultRoute
      ? `Default-Route via ${failedDefaultRoute[1]} dev ${failedDefaultRoute[2]}: linkdown`
      : `${subject} failed: ${result}`
  } else if (verification) {
    kind = 'verification'
    statement = route
      ? `Route ${route[1]} via ${route[2]} verified`
      : synologyHosts.length > 0
        ? `${synologyHosts.at(-1)?.[1]} Synology DSM verified`
        : `${subject} was verified: ${result}`
  } else if (mutation) {
    kind = 'change'
    const action = inner.match(/\bsystemctl\s+(restart|start|stop|enable|disable)\s+(?:--\S+\s+)*([\w@.-]+)/i)
    const target = bashMutationTarget(inner)
    const sedChange = bashSedChange(inner)
    const redirectChange = bashRedirectChange(inner)
    const pastTense: Record<string, string> = {
      restart: 'restarted', start: 'started', stop: 'stopped', enable: 'enabled', disable: 'disabled',
    }
    if (sedChange) statement = `${sedChange} changed; result: ${result}`
    else if (redirectChange) statement = `${redirectChange} changed; result: ${result}`
    else if (action) statement = `Service ${action[2]} was ${pastTense[action[1].toLowerCase()]}; result: ${result}`
    else if (/\bdocker\s+compose\s+up\b/i.test(inner)) statement = `Docker Compose services were started; result: ${result}`
    else if (/\b(?:apt|apt-get|dnf|yum|pacman)\b.*\binstall\b/i.test(inner)) statement = `Package installation completed; result: ${result}`
    else if (target) statement = `${target} changed; result: ${result}`
    else statement = `${subject} completed a change; result: ${result}`
  } else {
    kind = 'result'
    statement = `${subject} reported: ${result}`
  }

  const key = sourceKey(pair.id, `${pair.command}\0${pair.result}`)
  const commandExcerpt = truncateAtWord(redactExtraSecrets(inner), 92)
  const item = provenance(
    'bash_pair',
    key,
    `${inner}\0${pair.result}\0${failed ? 'error' : 'success'}`,
    `Command: ${commandExcerpt}; result: ${result}`,
    `bash:${key}`,
  )
  return makeCandidate(statement, item, taskContext, kind, 0.95, true)
}

function mergeCandidates(candidates: Candidate[]): Candidate[] {
  const grouped = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const key = semanticKey(candidate)
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, { ...candidate, provenance: [...candidate.provenance], taskContexts: [...candidate.taskContexts] })
      continue
    }
    const statement = [existing.statement, candidate.statement]
      .sort((a, b) => a.length - b.length || a.localeCompare(b, 'en'))[0]
    existing.statement = statement
    existing.provenance.push(...candidate.provenance)
    existing.taskContexts.push(...candidate.taskContexts)
    existing.explicitness = Math.max(existing.explicitness, candidate.explicitness)
    existing.evidenceConflict ||= candidate.evidenceConflict
  }

  const merged = [...grouped.values()].sort((a, b) => semanticKey(a).localeCompare(semanticKey(b), 'en'))

  // Similar wording is never sufficient to transfer provenance. Opposing
  // polarity is instead an explicit conflict that keeps every involved fact
  // in review and blocks downstream auto-promotion.
  for (let i = 0; i < merged.length; i++) {
    for (let j = i + 1; j < merged.length; j++) {
      if (merged[i].kind !== merged[j].kind) continue
      if (tokenSimilarity(merged[i].statement, merged[j].statement) < 0.58) continue
      if (polarityCompatible(merged[i].statement, merged[j].statement)) continue
      merged[i].evidenceConflict = true
      merged[j].evidenceConflict = true
    }
  }

  for (const candidate of merged) {
    const unique = new Map(candidate.provenance.map(item => [`${item.ref}:${item.hash}`, item]))
    candidate.provenance = [...unique.values()].sort((a, b) => a.ref.localeCompare(b.ref, 'en') || a.hash.localeCompare(b.hash, 'en'))
    candidate.taskContexts = [...new Set(candidate.taskContexts)].sort((a, b) => a.localeCompare(b, 'en'))
  }
  return merged
}

function taskRelevance(statement: string, contexts: string[]): number {
  const context = contexts.join(' ')
  if (meaningfulTokens(context).length === 0) return 0.5
  const similarity = tokenSimilarity(statement, context)
  return clamp(0.15 + similarity * 1.15)
}

function outcomeUtility(kind: KnowledgeFactKind, explicitness: number): number {
  const base: Record<KnowledgeFactKind, number> = {
    cause: 0.94,
    decision: 0.96,
    change: 0.82,
    verification: 0.78,
    result: 0.6,
    problem: 0.76,
    open_question: 0.72,
    constraint: 0.76,
  }
  return clamp(base[kind] * 0.86 + explicitness * 0.14)
}

function noveltyInformativeness(statement: string, knownKnowledge: string[]): number {
  const tokens = meaningfulTokens(statement)
  const uniqueRatio = new Set(tokens).size / Math.max(1, tokens.length)
  const usefulLength = clamp(tokens.length / 10)
  const detail = /(?:\b\d+(?:\.\d+){1,3}\b|\b\d+(?:\.\d+)+\b|:\d{2,5}\b|[/@._-])/u.test(statement) ? 1 : 0
  const informativeness = clamp(0.22 + uniqueRatio * 0.34 + usefulLength * 0.3 + detail * 0.14)
  // Missing comparison data means novelty is unknown, not maximal.
  if (knownKnowledge.length === 0) return 0.5
  const maxKnownSimilarity = knownKnowledge.reduce((max, known) => Math.max(max, tokenSimilarity(statement, known)), 0)
  return clamp(informativeness * 0.58 + (1 - maxKnownSimilarity) * 0.42)
}

function reusability(statement: string, kind: KnowledgeFactKind): number {
  const base: Record<KnowledgeFactKind, number> = {
    cause: 0.88,
    decision: 0.84,
    change: 0.68,
    verification: 0.76,
    result: 0.66,
    problem: 0.64,
    open_question: 0.56,
    constraint: 0.9,
  }
  let score = base[kind]
  if (/\b(?:wenn|falls|whenever|when|requires?|muss|ursache|because)\b/i.test(statement)) score += 0.07
  if (/\b(?:heute|morgen|diese session|this session|temporär|temporaer|temporary)\b|\/tmp\//i.test(statement)) score -= 0.25
  if (/\b(?:ich|mir|mein|we just|i just)\b/i.test(statement)) score -= 0.12
  return clamp(score)
}

function specificity(statement: string): number {
  const tokens = meaningfulTokens(statement)
  let score = 0.28 + clamp(tokens.length / 12) * 0.34
  const details = [
    /\b\d+(?:\.\d+){1,3}\b/,
    /:\d{2,5}\b/,
    /\b\d+(?:\.\d+)+\b/,
    /(?:\/[^\s]+|[\w.-]+\.(?:service|yml|yaml|json|toml|conf|ts|js))\b/i,
    /\b[A-Za-z][\w-]*@[\w.-]+\b/,
  ].filter(pattern => pattern.test(statement)).length
  score += Math.min(0.32, details * 0.09)
  if (/\b(?:ding|sache|etwas|stuff|thing|it|dies|das)\b/i.test(statement)) score -= 0.12
  return clamp(score)
}

function evidenceScore(provenanceItems: KnowledgeProvenance[]): number {
  return scoreEvidence(provenanceItems) ?? 0
}

function confidenceForEvidence(score: number): KnowledgeConfidence {
  if (score >= KNOWLEDGE_SALIENCE_MODEL.confidenceThresholds.high) return 'high'
  if (score >= KNOWLEDGE_SALIENCE_MODEL.confidenceThresholds.medium) return 'medium'
  return 'low'
}

function draftFact(candidate: Candidate, knownKnowledge: string[]): DraftFact {
  const factors: KnowledgeFactFactors = {
    taskRelevance: round(taskRelevance(candidate.statement, candidate.taskContexts)),
    decisionOutcomeUtility: round(outcomeUtility(candidate.kind, candidate.explicitness)),
    noveltyInformativeness: round(noveltyInformativeness(candidate.statement, knownKnowledge)),
    reusability: round(reusability(candidate.statement, candidate.kind)),
    specificity: round(specificity(candidate.statement)),
  }
  const salienceScore = scoreKnowledgeSalienceFactors(factors)
  const rawEvidence = evidenceScore(candidate.provenance)
  const evidence = applyEvidenceConflictCeiling(rawEvidence, candidate.evidenceConflict)
  const canonical = `${KNOWLEDGE_SALIENCE_MODEL.version}\0${candidate.kind}\0${semanticKey(candidate)}`
  return {
    id: `ks-${sha256(canonical).slice(0, 20)}`,
    modelVersion: KNOWLEDGE_SALIENCE_MODEL.version,
    kind: candidate.kind,
    statement: candidate.statement,
    abstraction: factAbstraction(candidate.kind, candidate.statement),
    factors,
    salienceScore,
    evidenceScore: evidence,
    confidence: confidenceForEvidence(evidence),
    evidenceConflict: candidate.evidenceConflict,
    provenance: candidate.provenance,
  }
}

function selectWithMmr(
  facts: DraftFact[],
  maxFacts: number,
  lambda: number,
  redundancyThreshold: number,
  seedFacts: KnowledgeSalienceFact[] = [],
): { facts: KnowledgeSalienceFact[]; redundant: number } {
  const remaining = [...facts]
  const selected: KnowledgeSalienceFact[] = []
  const comparisonSet: KnowledgeSalienceFact[] = [...seedFacts]
  let redundant = 0

  while (remaining.length > 0 && comparisonSet.length < maxFacts) {
    const scored = remaining.map(fact => {
      const similarity = comparisonSet.reduce((max, chosen) => {
        const semanticRoleFactor = chosen.kind === fact.kind ? 1 : 0.2
        return Math.max(max, tokenSimilarity(fact.statement, chosen.statement) * semanticRoleFactor)
      }, 0)
      const redundantSimilarity = comparisonSet.reduce((max, chosen) =>
        chosen.kind === fact.kind
          && !chosen.evidenceConflict
          && !fact.evidenceConflict
          && polarityCompatible(fact.statement, chosen.statement)
          ? Math.max(max, redundancySimilarity(fact.statement, chosen.statement))
          : max, 0)
      // Evidence is intentionally not folded into relevance: MMR selects on
      // salience, while evidence remains an independent promotion/review axis.
      const relevance = fact.salienceScore / 100
      // A bounded preference for an interpreted semantic assertion over a
      // generated shell wrapper improves abstraction without raising evidence
      // confidence. More than five salience points still outweigh it.
      const interpretationBonus = fact.provenance.some(item =>
        item.source === 'phase' || item.source === 'assistant_summary') ? 0.04 : 0
      const kindDiversityBonus = comparisonSet.some(item => item.kind === fact.kind) ? 0 : 0.04
      return {
        fact,
        similarity,
        redundantSimilarity,
        mmr: lambda * relevance - (1 - lambda) * similarity + interpretationBonus + kindDiversityBonus,
      }
    })
    const eligible = scored.filter(item => comparisonSet.length === 0 || item.redundantSimilarity < redundancyThreshold)
    redundant += scored.length - eligible.length
    if (eligible.length === 0) break
    eligible.sort((a, b) =>
      b.mmr - a.mmr
        || b.fact.salienceScore - a.fact.salienceScore
        || b.fact.evidenceScore - a.fact.evidenceScore
        || a.fact.id.localeCompare(b.fact.id, 'en'))
    const winner = eligible[0]
    const selectedFact = { ...winner.fact, selectionScore: round(winner.mmr, 4) }
    selected.push(selectedFact)
    comparisonSet.push(selectedFact)

    const chosenId = winner.fact.id
    for (let index = remaining.length - 1; index >= 0; index--) {
      const item = scored.find(entry => entry.fact.id === remaining[index].id)
      if (remaining[index].id === chosenId || (item && comparisonSet.length > 0 && item.redundantSimilarity >= redundancyThreshold)) {
        remaining.splice(index, 1)
      }
    }
  }

  return { facts: selected, redundant }
}

/**
 * Extracts atomic, reusable session facts and selects them with maximal
 * marginal relevance. It is pure: no files, clocks, random values, or model
 * calls influence the result.
 */
export function selectSalientKnowledge(input: KnowledgeSalienceInput): KnowledgeSalienceSelection {
  const task = normalizeSpace(redactExtraSecrets(input.task ?? ''))
  const candidates: Candidate[] = []
  let unsafeOrNoisy = 0

  for (const phase of input.phases ?? []) {
    const phaseKey = sourceKey(phase.id, `${phase.userRequest}\0${phase.outcome}`)
    const context = normalizeSpace(`${task} ${containsSecret(phase.userRequest) ? '' : phase.userRequest}`)
    unsafeOrNoisy += addTextCandidates(candidates, phase.outcome, 'phase', `${phaseKey}:outcome`, context, 'result', 0.68)

    for (const segment of atomicSegments(phase.userRequest)) {
      const hasRequestFact = DECISION_SIGNAL.test(segment)
        || OPEN_QUESTION_SIGNAL.test(segment)
        || PROBLEM_SIGNAL.test(segment)
        || CONSTRAINT_SIGNAL.test(segment)
        || /\?$/.test(segment.trim())
      if (!hasRequestFact) continue
      if (/\b(?:bitte\s+)?(?:halte|haltet|bewahre|bewahrt|dokumentiere|dokumentiert|finde|findet|prüfe|pruefe|analysiere|lege\s+fest)\b/i.test(segment)) {
        unsafeOrNoisy++
        continue
      }
      if (/\b(?:müssen|muessen|need to)\b.*\b(?:festlegen|klären|klaeren|entscheiden|prüfen|pruefen)\b/i.test(segment)) {
        unsafeOrNoisy++
        continue
      }
      if (/\b(?:muss|must)\b.*\b(?:erreichbar|reachable)\b.*\b(?:werden|become)\b/i.test(segment)) {
        // A desired end state is task context, not an observed constraint.
        // The eventual finding or verification remains independently eligible.
        unsafeOrNoisy++
        continue
      }
      const item = provenance(
        'phase',
        `${phaseKey}:request:${sha256(segment).slice(0, 10)}`,
        segment,
      )
      const candidate = makeCandidate(segment, item, task, 'problem', 0.58)
      if (candidate) candidates.push(candidate)
      else unsafeOrNoisy++
    }
  }

  for (const summaryInput of input.assistantSummaries ?? []) {
    const summary = typeof summaryInput === 'string' ? { text: summaryInput } : summaryInput
    const key = sourceKey(summary.id, summary.text)
    unsafeOrNoisy += addTextCandidates(
      candidates,
      summary.text,
      'assistant_summary',
      key,
      task,
      'result',
      0.52,
      `assistant:${key}`,
    )
  }

  for (const errorFixInput of input.errorFixes ?? []) {
    const parsed = typeof errorFixInput === 'string' ? parseErrorFix(errorFixInput) : errorFixInput
    if (!parsed) {
      const key = sourceKey(undefined, String(errorFixInput))
      unsafeOrNoisy += addTextCandidates(
        candidates,
        String(errorFixInput),
        'error_fix',
        key,
        task,
        'problem',
        0.72,
        `assistant:${key}`,
      )
      continue
    }
    const key = sourceKey(typeof errorFixInput === 'string' ? undefined : errorFixInput.id, `${parsed.error}\0${parsed.fix}`)
    const originKey = typeof errorFixInput === 'string'
      ? sourceKey(undefined, errorFixInput)
      : key
    const combinedExcerpt = `Error: ${truncateAtWord(parsed.error, 80)}; fix: ${truncateAtWord(parsed.fix, 80)}`
    for (const [kind, text] of [['problem', parsed.error], ['change', parsed.fix]] as const) {
      for (const segment of atomicSegments(text)) {
        if (isUnsafeOrNoisyText(segment)) {
          unsafeOrNoisy++
          continue
        }
        const item = provenance(
          'error_fix',
          `${key}:${kind}:${sha256(segment).slice(0, 10)}`,
          `${parsed.error}\0${parsed.fix}`,
          combinedExcerpt,
          `assistant:${originKey}`,
        )
        const candidate = makeCandidate(segment, item, task, kind, 0.82)
        if (candidate) candidates.push(candidate)
        else unsafeOrNoisy++
      }
    }
  }

  for (const pair of input.bashEvidence ?? []) {
    const candidate = bashCandidate(pair, task)
    if (candidate) candidates.push(candidate)
    else unsafeOrNoisy++
  }

  const knownKnowledge = (input.knownKnowledge ?? [])
    .flatMap(atomicSegments)
    .filter(value => !isUnsafeOrNoisyText(value))
  const allowedKinds = input.allowedKinds && input.allowedKinds.length > 0
    ? new Set(input.allowedKinds)
    : null
  const merged = mergeCandidates(candidates)
    .filter(candidate => !allowedKinds || allowedKinds.has(candidate.kind))
  const minSalience = clamp(Number.isFinite(input.minSalienceScore) ? Number(input.minSalienceScore) / 100 : 0.3) * 100
  const allFacts = merged.map(candidate => draftFact(candidate, knownKnowledge))
  const eligible = allFacts.filter(fact => fact.salienceScore >= minSalience)
  const maxFacts = Math.max(1, Math.min(50, Math.floor(input.maxFacts ?? 8)))
  const lambda = clamp(input.mmrLambda ?? 0.75, 0.5, 0.95)
  const redundancyThreshold = clamp(input.redundancyThreshold ?? 0.55, 0.55, 0.98)
  let selection: { facts: KnowledgeSalienceFact[]; redundant: number }
  if (allowedKinds) {
    // When the user explicitly scopes the digest to N semantic roles, a
    // duplicate of one role must not crowd out the sole atom of another.
    const requiredFacts: KnowledgeSalienceFact[] = []
    for (const kind of allowedKinds) {
      if (requiredFacts.length >= maxFacts) break
      const strongest = eligible
        .filter(fact => fact.kind === kind)
        .sort((a, b) =>
          (lambda * b.salienceScore / 100
            + (b.provenance.some(item => item.source === 'phase' || item.source === 'assistant_summary') ? 0.04 : 0))
            - (lambda * a.salienceScore / 100
              + (a.provenance.some(item => item.source === 'phase' || item.source === 'assistant_summary') ? 0.04 : 0))
            || b.evidenceScore - a.evidenceScore
            || a.id.localeCompare(b.id, 'en'))[0]
      if (!strongest) continue
      requiredFacts.push({
        ...strongest,
        selectionScore: round(
          lambda * strongest.salienceScore / 100
            + (strongest.provenance.some(item => item.source === 'phase' || item.source === 'assistant_summary') ? 0.04 : 0),
          4,
        ),
      })
    }
    const requiredIds = new Set(requiredFacts.map(fact => fact.id))
    const continuation = selectWithMmr(
      eligible.filter(fact => !requiredIds.has(fact.id)),
      maxFacts,
      lambda,
      redundancyThreshold,
      requiredFacts,
    )
    selection = {
      facts: [...requiredFacts, ...continuation.facts],
      redundant: continuation.redundant,
    }
  } else {
    selection = selectWithMmr(eligible, maxFacts, lambda, redundancyThreshold)
  }

  return {
    sessionId: normalizeSpace(input.sessionId),
    modelVersion: KNOWLEDGE_SALIENCE_MODEL.version,
    scoreScale: KNOWLEDGE_SALIENCE_MODEL.scoreScale,
    facts: selection.facts,
    calibrationCandidates: allFacts,
    candidateCount: allFacts.length,
    excluded: {
      unsafeOrNoisy,
      belowSalienceThreshold: allFacts.length - eligible.length,
      redundant: selection.redundant,
    },
  }
}
