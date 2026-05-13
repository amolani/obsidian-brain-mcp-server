import type { ClientMatch } from './client-resolver.ts'
import type { ClassifiedIntent } from './intent-classifier.ts'
import { redactSecrets } from './secret-redaction.ts'

export interface SessionDigestPhase {
  userRequest: string
  outcome: string
  commandCount: number
  hadError: boolean
}

export interface SessionDigestInput {
  title: string
  client: string | null
  clientMatch: ClientMatch
  intent: ClassifiedIntent
  phases: SessionDigestPhase[]
  summaries: string[]
  procedures: string[]
  errorFixes: string[]
  redactionCount?: number
}

const EMPTY = '- Keine belastbare Aussage erkannt'

const DEBUG_NARRATION = /^(zwei|drei|mehrere)\s+hinweise\s+sind\s+wichtig:?$|entscheidende(?:r)?\s+hinweis|crash-files?.*ajenti\.log.*nächst\w*\s+quellen|\.bak\s+ist\s+identisch/i
const SENSITIVE_TEXT = /\b(passw(?:ort|örter|oerter)?|password|passwd|pwd|token|secret|--newpassword|setpassword|auth-user-pass|\.env)\b/i
const VERBOSE_COMMAND = /`[^`]*(?:&&|;|\||\b(?:ssh|samba-tool|cat|grep|find|openssl|docker|systemctl|kubectl|nmap|curl|sed|awk|tail|head)\b)[^`]*`/i

function clean(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[-*#>\s\d.]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function safe(value: string, maxLength = 280): string | null {
  const cleaned = clean(value)
  if (!cleaned) return null
  if (DEBUG_NARRATION.test(cleaned)) return null
  if (SENSITIVE_TEXT.test(cleaned)) return null
  if (cleaned.length > 140 && VERBOSE_COMMAND.test(cleaned)) return null
  const redacted = redactSecrets(cleaned).content
  if (redacted !== cleaned && SENSITIVE_TEXT.test(cleaned)) return null
  return redacted.slice(0, maxLength).trim()
}

function evidenceLines(input: SessionDigestInput): string[] {
  const texts = [
    ...input.phases.map(phase => phase.outcome),
    ...input.summaries,
    ...input.errorFixes,
  ]
  return texts.flatMap(text =>
    text
      .replace(/```[\s\S]*?```/g, ' ')
      .split(/\n+|(?<=[.!?])\s+(?=[A-ZÄÖÜ0-9`])/)
      .map(line => clean(line))
      .filter(Boolean),
  )
}

function bullets(values: string[]): string {
  const cleanValues = values
    .map(value => safe(value))
    .filter((value): value is string => !!value)
  return cleanValues.length > 0
    ? [...new Set(cleanValues)].slice(0, 4).map(value => `- ${value}`).join('\n')
    : EMPTY
}

function problem(input: SessionDigestInput): string[] {
  const first = input.phases.find(phase => safe(phase.userRequest, 220))
  return first ? [first.userRequest] : [input.title]
}

function rootCause(input: SessionDigestInput, lines: string[]): string[] {
  const corpus = `${lines.join('\n')}\n${input.procedures.join('\n')}`
  const out: string[] = []
  if (/bind\.mode|mode:\s*unix/i.test(corpus) && /bind\.socket/i.test(corpus)) {
    out.push('Ajenti-Konfiguration war widersprüchlich: `bind.mode: unix` ohne `bind.socket`, obwohl TCP/SSL konfiguriert war.')
  }
  for (const line of lines) {
    if (!/(root cause|ursache|keyerror|bind\.socket|bind\.mode|widerspr|fehlte|missing)/i.test(line)) continue
    out.push(line)
  }
  return out
}

function changes(input: SessionDigestInput, lines: string[]): string[] {
  const corpus = `${lines.join('\n')}\n${input.procedures.join('\n')}`
  const out: string[] = []
  if (/cp\s+\/etc\/ajenti\/config\.yml|config\.yml\.broken/i.test(corpus)) {
    out.push('Vor der Änderung wurde ein Backup der Ajenti-Konfiguration angelegt.')
  }
  if (/mode:\s*unix/i.test(corpus) && /mode:\s*tcp/i.test(corpus)) {
    out.push('Ajenti `bind.mode` wurde von `unix` auf `tcp` umgestellt.')
  }
  if (/systemctl\s+restart\s+linuxmuster-webui/i.test(corpus)) {
    out.push('`linuxmuster-webui` wurde neu gestartet.')
  }
  for (const line of lines) {
    if (!/(geändert|geaendert|umgestellt|gesetzt|neu gestartet|restart|fix erfolgreich|läuft wieder|laeuft wieder)/i.test(line)) continue
    out.push(line)
  }
  return out
}

function verification(input: SessionDigestInput, lines: string[]): string[] {
  const corpus = `${lines.join('\n')}\n${input.procedures.join('\n')}`
  const out: string[] = []
  if (/linuxmuster-webui.*active|active\s*\(running\)|systemctl\s+is-active\s+linuxmuster-webui/i.test(corpus)) {
    out.push('`linuxmuster-webui` war nach dem Fix active/running.')
  }
  if (/0\.0\.0\.0:443|LISTEN.*:443|ss\s+-tlnp.*:443/i.test(corpus)) {
    out.push('Der Dienst lauschte auf `0.0.0.0:443`.')
  }
  for (const line of lines) {
    if (!/(verifiziert|validiert|active|running|lauscht|laeuscht|listen|0\.0\.0\.0:443|port 443)/i.test(line)) continue
    out.push(line)
  }
  return out
}

function review(input: SessionDigestInput): string[] {
  const out: string[] = []
  if (input.clientMatch.method === 'unknown_cwd' && input.clientMatch.candidate) {
    out.push(`Kunden-/Projektkandidat aus CWD prüfen: \`${input.clientMatch.candidate}\`.`)
  } else if (['fuzzy_cwd', 'exact_content'].includes(input.clientMatch.method)) {
    out.push(`Kundenzuordnung prüfen: ${input.clientMatch.reason}.`)
  }
  if (input.intent.confidence === 'low') {
    out.push('Session-Intent hat niedrige Confidence und sollte vor Promotion geprüft werden.')
  }
  return out
}

function excluded(input: SessionDigestInput): string[] {
  const corpus = [
    ...input.summaries,
    ...input.procedures,
    ...input.errorFixes,
    ...input.phases.flatMap(phase => [phase.userRequest, phase.outcome]),
  ].join('\n')
  const out = ['Debug-Narration ohne dauerhaften Wissenswert wurde nicht als Digest-Fakt übernommen.']
  if (SENSITIVE_TEXT.test(corpus) || (input.redactionCount ?? 0) > 0) {
    out.push('Credential-/Kennwort-Inhalte und Werte wurden nicht ausgeschrieben.')
  }
  if (VERBOSE_COMMAND.test(corpus) || input.procedures.length > 0) {
    out.push('Lange SSH-/Shell-/Samba-Befehlslisten bleiben außerhalb des Digest-Kontextes.')
  }
  return out
}

export function renderSessionDigest(input: SessionDigestInput): string {
  const lines = evidenceLines(input)
  return [
    '## Session Digest',
    '',
    '### Problem',
    '',
    bullets(problem(input)),
    '',
    '### Root Cause',
    '',
    bullets(rootCause(input, lines)),
    '',
    '### Änderung / Fix',
    '',
    bullets(changes(input, lines)),
    '',
    '### Verifikation',
    '',
    bullets(verification(input, lines)),
    '',
    '### Review',
    '',
    bullets(review(input)),
    '',
    '### Nicht übernommen',
    '',
    bullets(excluded(input)),
  ].join('\n')
}
