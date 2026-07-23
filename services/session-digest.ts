import type { ClientMatch } from './client-resolver.ts'
import type { ClassifiedIntent } from './intent-classifier.ts'
import {
  KNOWLEDGE_SALIENCE_MODEL,
  selectSalientKnowledge,
  type KnowledgeFactKind,
  type KnowledgeProvenance,
  type KnowledgeSalienceFact,
  type KnowledgeSalienceSelection,
} from './knowledge-salience.ts'
import { redactSecrets } from './secret-redaction.ts'
import {
  digestEvidenceScore,
  renderSessionDigestAttestation,
  sessionDigestIntegrity,
  type DigestIntegrityFact,
} from './session-digest-integrity.ts'

export interface SessionDigestPhase {
  userRequest: string
  outcome: string
  commandCount: number
  hadError: boolean
}

/**
 * `selection` is the preferred input. The remaining knowledge fields stay
 * available for callers that have not moved salience selection into their
 * capture pipeline yet; they are converted into the same typed selection and
 * are never rendered as raw assistant blocks or command lists.
 */
export interface SessionDigestInput {
  title: string
  sessionId?: string
  client?: string | null
  clientMatch?: ClientMatch
  intent?: ClassifiedIntent
  phases?: SessionDigestPhase[]
  summaries?: string[]
  procedures?: string[]
  errorFixes?: string[]
  redactionCount?: number
  selection?: KnowledgeSalienceSelection
}

interface RenderedFact {
  label: string
  fact: KnowledgeSalienceFact
}

const EMPTY = '- Keine belastbare Aussage erkannt'
const MAX_RENDERED_FACTS = 8
const MAX_FACT_LENGTH = 220
const MAX_PROVENANCE_ROWS = MAX_RENDERED_FACTS * 4
const MAX_PROVENANCE_PER_FACT = 4
const MAX_PROVENANCE_EXCERPT = 110
const MIN_DURABLE_EVIDENCE = KNOWLEDGE_SALIENCE_MODEL.confidenceThresholds.medium

const SECTION_KINDS: ReadonlyArray<{ title: string; kinds: readonly KnowledgeFactKind[] }> = [
  { title: 'Problem', kinds: ['problem'] },
  { title: 'Root Cause', kinds: ['cause'] },
  { title: 'Entscheidung', kinds: ['decision'] },
  { title: 'Änderung / Fix', kinds: ['change'] },
  { title: 'Verifikation', kinds: ['verification'] },
  { title: 'Ergebnis', kinds: ['result'] },
  { title: 'Offene Punkte / Constraints', kinds: ['open_question', 'constraint'] },
]

function truncateAtWord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const head = value.slice(0, maxLength + 1)
  const boundary = head.lastIndexOf(' ')
  return `${head.slice(0, boundary >= maxLength * 0.65 ? boundary : maxLength).trimEnd()}…`
}

function safeInline(value: string, maxLength: number): string {
  const withoutBlocks = value.replace(/```[\s\S]*?```/g, ' ')
  const redacted = redactSecrets(withoutBlocks).content
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return truncateAtWord(redacted, maxLength)
}

function selectedKnowledge(input: SessionDigestInput): KnowledgeSalienceSelection {
  if (input.selection) return input.selection
  const phases = input.phases ?? []
  return selectSalientKnowledge({
    sessionId: input.sessionId ?? input.title,
    task: [input.title, ...phases.map(phase => phase.userRequest)].filter(Boolean).join(' '),
    phases,
    assistantSummaries: input.summaries ?? [],
    errorFixes: input.errorFixes ?? [],
    maxFacts: MAX_RENDERED_FACTS,
  })
}

function isDurable(fact: KnowledgeSalienceFact): boolean {
  return !fact.evidenceConflict
    && fact.provenance.length > 0
    && fact.evidenceScore >= MIN_DURABLE_EVIDENCE
}

function factStatement(fact: KnowledgeSalienceFact): string {
  return safeInline(fact.abstraction?.slots.fact || fact.statement, MAX_FACT_LENGTH)
}

function scoreSummary(fact: KnowledgeSalienceFact): string {
  return `Salienz ${fact.salienceScore}/100 · Evidenz ${fact.evidenceScore}/100 · ${fact.confidence}`
}

function factBullet(item: RenderedFact, prefix = ''): string {
  const statement = factStatement(item.fact)
  if (!statement) return ''
  return `- [${item.label}] ${prefix}${statement} _(${scoreSummary(item.fact)})_`
}

function sectionBullets(facts: RenderedFact[], kinds: readonly KnowledgeFactKind[]): string {
  const lines = facts
    .filter(item => isDurable(item.fact) && kinds.includes(item.fact.kind))
    .map(item => factBullet(item))
    .filter(Boolean)
  return lines.length > 0 ? lines.join('\n') : EMPTY
}

function routingReview(input: SessionDigestInput): string[] {
  const match = input.clientMatch
  if (!match) return []
  if (match.method === 'unknown_cwd' && match.candidate) {
    return [`Kunden-/Projektkandidat aus CWD prüfen: \`${safeInline(match.candidate, 80)}\`.`]
  }
  if (match.confidence === 'low' || ['fuzzy_cwd', 'exact_content', 'ambiguous_cwd', 'ambiguous_content'].includes(match.method)) {
    return [`Kundenzuordnung prüfen: ${safeInline(match.reason, 180)}.`]
  }
  return []
}

function reviewBullets(input: SessionDigestInput, facts: RenderedFact[]): string {
  const weakFacts = facts
    .filter(item => !isDurable(item.fact))
    .map(item => factBullet(item, item.fact.evidenceConflict ? 'Widersprüchlich: ' : 'Unbestätigt: '))
    .filter(Boolean)
  const contextReview = routingReview(input).map(value => `- ${value}`)
  if (input.intent?.confidence === 'low') {
    contextReview.push('- Session-Intent hat niedrige Confidence und sollte vor Promotion geprüft werden.')
  }
  const lines = [...weakFacts, ...contextReview]
  return lines.length > 0 ? lines.join('\n') : '- Kein zusätzlicher Review-Hinweis'
}

function provenanceExcerpt(item: KnowledgeProvenance): string {
  // Assistant/phase prose is deliberately not repeated. Its stable reference
  // and digest are enough to locate it without copying another prose block.
  if (item.source === 'assistant_summary' || item.source === 'phase' || item.source === 'error_fix') return ''
  return safeInline(item.excerpt, MAX_PROVENANCE_EXCERPT)
}

function integrityCandidate(item: KnowledgeProvenance) {
  return {
    ref: safeInline(item.ref, 100),
    hash: /^[a-f0-9]{64}$/i.test(item.hash) ? item.hash.toLowerCase() : 'ungültig',
    excerpt: provenanceExcerpt(item),
  }
}

/** Keep the smallest bounded evidence subset that reproduces the persisted score. */
function integrityProvenance(
  items: KnowledgeProvenance[],
  targetScore: number,
  modelVersion: string,
): KnowledgeProvenance[] {
  const byHash = new Map<string, KnowledgeProvenance>()
  for (const item of items) {
    const current = byHash.get(item.hash)
    const currentScore = current
      ? (digestEvidenceScore([integrityCandidate(current)], modelVersion) ?? -1)
      : -1
    const candidateScore = digestEvidenceScore(
      [integrityCandidate(item)],
      modelVersion,
    ) ?? -1
    if (!current || candidateScore > currentScore) byHash.set(item.hash, item)
  }
  const unique = [...byHash.values()]
  const selected: KnowledgeProvenance[] = []
  while (selected.length < MAX_PROVENANCE_PER_FACT && unique.length > 0) {
    unique.sort((left, right) => {
      const leftScore = digestEvidenceScore(
        [...selected, left].map(integrityCandidate),
        modelVersion,
      ) ?? -1
      const rightScore = digestEvidenceScore(
        [...selected, right].map(integrityCandidate),
        modelVersion,
      ) ?? -1
      return rightScore - leftScore || left.ref.localeCompare(right.ref, 'en')
    })
    const next = unique.shift()
    if (!next) break
    selected.push(next)
    if (digestEvidenceScore(selected.map(integrityCandidate), modelVersion) === targetScore) break
  }
  return selected
}

function renderedProvenance(fact: KnowledgeSalienceFact): KnowledgeProvenance[] {
  return isDurable(fact)
    ? integrityProvenance(fact.provenance, fact.evidenceScore, fact.modelVersion)
    : fact.provenance.slice(0, 1)
}

function provenanceBullets(facts: RenderedFact[]): string {
  const rows: string[] = []
  for (const { label, fact } of facts) {
    for (const source of renderedProvenance(fact)) {
      const ref = safeInline(source.ref, 100)
      const hash = /^[a-f0-9]{64}$/i.test(source.hash) ? source.hash.toLowerCase() : 'ungültig'
      const excerpt = provenanceExcerpt(source)
      rows.push(`- [${label}] \`${ref}\` · Hash \`${hash}\`${excerpt ? ` — ${excerpt}` : ''}`)
      if (rows.length >= MAX_PROVENANCE_ROWS) return rows.join('\n')
    }
  }
  return rows.length > 0 ? rows.join('\n') : '- Keine verwertbare Provenienz vorhanden'
}

function attestedFacts(facts: RenderedFact[]): DigestIntegrityFact[] {
  return facts
    .filter(item => isDurable(item.fact))
    .map(({ label, fact }) => ({
      id: label,
      kind: fact.kind,
      statement: factStatement(fact),
      salienceScore: fact.salienceScore,
      evidenceScore: fact.evidenceScore,
      confidence: fact.confidence,
      provenance: renderedProvenance(fact).map(integrityCandidate),
    }))
}

function excludedBullets(input: SessionDigestInput, selection: KnowledgeSalienceSelection): string {
  const lines: string[] = []
  const excluded = selection.excluded
  if (excluded.unsafeOrNoisy > 0 || excluded.belowSalienceThreshold > 0 || excluded.redundant > 0) {
    lines.push(
      `Nicht ausgewählt: ${excluded.unsafeOrNoisy} unsicher/rauschend, `
      + `${excluded.belowSalienceThreshold} unter Salienzschwelle, ${excluded.redundant} redundant.`,
    )
  }
  if ((input.procedures?.length ?? 0) > 0) {
    lines.push(`${input.procedures?.length ?? 0} ungebundene Befehle wurden ohne Ergebnisbeleg nicht übernommen.`)
  }
  if ((input.redactionCount ?? 0) > 0) {
    lines.push(`${input.redactionCount} sensible Fundstelle(n) wurden vor der Wissensauswahl redigiert.`)
  }
  if (lines.length === 0) lines.push('Keine weiteren Kandidaten verworfen.')
  return lines.map(line => `- ${line}`).join('\n')
}

/**
 * Renders a bounded digest of typed facts. Salience determines what is worth
 * showing; evidence independently determines whether it belongs in a durable
 * semantic section or only in Review.
 */
export function renderSessionDigest(input: SessionDigestInput): string {
  const selection = selectedKnowledge(input)
  const facts: RenderedFact[] = selection.facts
    .slice(0, MAX_RENDERED_FACTS)
    .map((fact, index) => ({ label: `F${index + 1}`, fact }))
  const body: string[] = [
    '## Session Digest',
    '',
    `_Modell: \`${safeInline(selection.modelVersion, 80)}\` · ${facts.length}/${selection.candidateCount} Fakten ausgewählt · ordinale Scores, keine Wahrscheinlichkeiten_`,
    '',
    renderSessionDigestAttestation(sessionDigestIntegrity(selection.modelVersion, attestedFacts(facts))),
  ]

  for (const section of SECTION_KINDS) {
    body.push('', `### ${section.title}`, '', sectionBullets(facts, section.kinds))
  }

  body.push(
    '',
    '### Review',
    '',
    reviewBullets(input, facts),
    '',
    '### Evidenz',
    '',
    provenanceBullets(facts),
    '',
    '### Nicht übernommen',
    '',
    excludedBullets(input, selection),
  )
  return body.join('\n')
}
