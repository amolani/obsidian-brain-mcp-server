export type SessionIntent =
  | 'implementation'
  | 'troubleshooting'
  | 'research'
  | 'planning'
  | 'documentation'
  | 'meeting'
  | 'unknown'

export interface ClassifiedIntent {
  intent: SessionIntent
  confidence: 'low' | 'medium' | 'high'
  score: number
  reasons: string[]
}

type ScoredIntent = Exclude<SessionIntent, 'unknown'>

const INTENTS: ScoredIntent[] = [
  'implementation',
  'troubleshooting',
  'research',
  'planning',
  'documentation',
  'meeting',
]

function textSection(content: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^##\\s+|$)`, 'im')
  return content.match(pattern)?.[1]?.trim() ?? ''
}

export function performedCommands(content: string): string[] {
  const section = textSection(content, 'Durchgeführte Befehle') || textSection(content, 'Durchgefuehrte Befehle')
  return [...section.matchAll(/^\d+\.\s+`([^`]+)`/gm)].map(match => match[1])
}

export function isMutatingCommand(command: string): boolean {
  return /\b(systemctl\s+(start|stop|restart|reload|enable|disable)|docker\s+compose\s+up|docker\s+(restart|exec|compose)|apt(?:-get)?\s+(install|remove|upgrade|dist-upgrade)|cp\s+|mv\s+|rm\s+|sed\s+-i|tee\s+|chmod\s+|chown\s+|certbot|acme\.sh|opnsense-cli\s+.*\b(apply|set|restart)\b)\b/i.test(command)
}

function add(scores: Record<ScoredIntent, number>, reasons: Record<ScoredIntent, string[]>, intent: ScoredIntent, points: number, reason: string): void {
  scores[intent] += points
  reasons[intent].push(reason)
}

function confidence(score: number, second: number): ClassifiedIntent['confidence'] {
  if (score >= 7 && score - second >= 3) return 'high'
  if (score >= 4) return 'medium'
  return 'low'
}

export function classifyIntent(content: string, tags: string[] = []): ClassifiedIntent {
  const haystack = `${tags.join(' ')}\n${content}`.toLowerCase()
  const commands = performedCommands(content)
  const mutatingCommands = commands.filter(isMutatingCommand)
  const scores = Object.fromEntries(INTENTS.map(intent => [intent, 0])) as Record<ScoredIntent, number>
  const reasons = Object.fromEntries(INTENTS.map(intent => [intent, []])) as unknown as Record<ScoredIntent, string[]>

  if (mutatingCommands.length > 0) {
    add(scores, reasons, 'implementation', Math.min(6, 2 + mutatingCommands.length), `${mutatingCommands.length} umsetzende Befehl(e) erkannt`)
  }
  if (commands.length >= 3 && mutatingCommands.length === 0) {
    add(scores, reasons, 'research', 3, 'mehrere read-only Befehle ohne Umsetzung')
  }

  const patterns: Array<[ScoredIntent, number, RegExp, string]> = [
    ['implementation', 3, /\b(umgesetzt|eingerichtet|konfiguriert|aktiviert|deploy|deployed|restart|reload|angewendet|applied|installed)\b/i, 'Umsetzungsbegriffe im Inhalt'],
    ['troubleshooting', 4, /\b(fe(h|hl)er|error|failed|fix|workaround|gel(ö|oe)st|debug|troubleshoot|incident|root cause)\b/i, 'Fehler/Fix-Signale erkannt'],
    ['research', 4, /\b(recherche|befund|prüf|pruef|analys|lookup|dig|whois|nslookup|read-only|herausfinden|nachschauen)\b/i, 'Recherche-/Analyse-Signale erkannt'],
    ['planning', 4, /\b(plan|planung|entscheidung|entscheiden|festlegen|auswahl|abwägung|abwaegung|wartungsfenster|nächste schritte|naechste schritte|todo|soll|muss noch|offen|roadmap|konzept)\b/i, 'Planungs-, Entscheidungs- oder offene Punkte erkannt'],
    ['documentation', 3, /\b(dokumentiert|notiz|readme|doku|beschreibung|zusammenfassung|runbook)\b/i, 'Dokumentationssignale erkannt'],
    ['meeting', 5, /\b(meeting|besprechung|protokoll|teilnehmer|agenda|termin|abstimmung)\b/i, 'Meeting-/Protokollsignale erkannt'],
  ]
  for (const [intent, points, pattern, reason] of patterns) {
    if (pattern.test(haystack)) add(scores, reasons, intent, points, reason)
  }

  if (tags.includes('incident') || tags.includes('troubleshooting')) add(scores, reasons, 'troubleshooting', 3, 'Troubleshooting-Tag')
  if (tags.includes('runbook') || tags.includes('prozedur')) add(scores, reasons, 'implementation', 2, 'Prozedur-/Runbook-Tag')
  if (tags.includes('research')) add(scores, reasons, 'research', 3, 'Research-Tag')

  const ranked = INTENTS
    .map(intent => ({ intent, score: scores[intent], reasons: reasons[intent] }))
    .sort((a, b) => b.score - a.score || INTENTS.indexOf(a.intent) - INTENTS.indexOf(b.intent))
  const best = ranked[0]
  if (!best || best.score <= 0) {
    return {
      intent: 'unknown',
      confidence: 'low',
      score: 0,
      reasons: ['keine belastbaren Intent-Signale erkannt'],
    }
  }
  return {
    intent: best.intent,
    confidence: confidence(best.score, ranked[1]?.score ?? 0),
    score: best.score,
    reasons: best.reasons.slice(0, 4),
  }
}
