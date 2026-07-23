import { KNOWLEDGE_SALIENCE_MODEL, type KnowledgeConfidence, type KnowledgeFactKind } from './knowledge-salience.ts'
import {
  digestConfidence,
  digestEvidenceScore,
  SESSION_DIGEST_PRODUCER,
  SESSION_DIGEST_SCHEMA,
  sessionDigestIntegrity,
} from './session-digest-integrity.ts'

/**
 * Stable, deliberately small interchange format between the session digest and
 * downstream automation. The markdown remains readable, but downstream code
 * never has to mine arbitrary prose from an auto-capture again.
 */
export interface ParsedDigestProvenance {
  ref: string
  hash: string
  excerpt: string
}

export interface ParsedDigestFact {
  id: string
  kind: KnowledgeFactKind
  statement: string
  salienceScore: number
  evidenceScore: number
  confidence: KnowledgeConfidence
  provenance: ParsedDigestProvenance[]
  integrityVerified: boolean
}

export interface ParsedSessionDigest {
  hasDigest: boolean
  modelVersion: string | null
  facts: ParsedDigestFact[]
  integrityStatus: 'verified' | 'missing' | 'invalid'
  integrityReason: string | null
}

const SECTION_KIND: Readonly<Record<string, KnowledgeFactKind | 'open_or_constraint'>> = {
  problem: 'problem',
  'root cause': 'cause',
  entscheidung: 'decision',
  'änderung / fix': 'change',
  'aenderung / fix': 'change',
  verifikation: 'verification',
  ergebnis: 'result',
  'offene punkte / constraints': 'open_or_constraint',
}

const FACT_LINE = /^\s*-\s+\[([A-Za-z0-9._:-]+)\]\s+(.+?)\s+_?\(\s*Salienz\s+(\d{1,3})\/100\s*[·|]\s*Evidenz\s+(\d{1,3})\/100\s*[·|]\s*(low|medium|high)\s*\)_?\s*$/i
const PROVENANCE_LINE = /^\s*-\s+\[([A-Za-z0-9._:-]+)\]\s+`([^`]+)`\s*[·|]\s*Hash\s+`([a-f0-9]{12,64})`(?:\s+—\s+(.+))?\s*$/i
const MODEL_LINE = /^_Modell:\s*`([^`]+)`(?:\s+·.*)?_\s*$/i
const ATTESTATION_LINE = /^_Digest-Integrität:\s*`([^`]+)`\s+·\s+Erzeuger:\s*`([^`]+)`\s+·\s+SHA-256:\s*`([a-f0-9]{64})`_\s*$/i
const OPEN_QUESTION = /\?$|^(?:offen(?:e frage)?|open question|todo)\s*:/i

function normalizedHeading(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function factKind(sectionKind: KnowledgeFactKind | 'open_or_constraint', statement: string): KnowledgeFactKind {
  if (sectionKind !== 'open_or_constraint') return sectionKind
  return OPEN_QUESTION.test(statement.trim()) ? 'open_question' : 'constraint'
}

function validStatement(value: string): boolean {
  const statement = value.trim()
  return statement.length >= 8
    && statement.length <= 500
    && !/^(?:unbestätigt|unbestaetigt|keine belastbare aussage|kein zusätzlicher review|kein zusaetzlicher review)/i.test(statement)
    && !/\b(?:salienz|evidenz)\s+\d+\/100\b/i.test(statement)
}

/**
 * Parses only the versioned, typed bullets emitted below `## Session Digest`.
 * Review prose, routing hints, exclusion counters, and arbitrary surrounding
 * note text are intentionally invisible to this parser.
 */
export function parseSessionDigestFacts(content: string): ParsedSessionDigest {
  const facts = new Map<string, ParsedDigestFact>()
  const provenance = new Map<string, ParsedDigestProvenance[]>()
  let inDigest = false
  let section: string | null = null
  let hasDigest = false
  let modelVersion: string | null = null
  let modelLineCount = 0
  let attestationLineCount = 0
  let attestation: { schema: string; producer: string; integrity: string } | null = null

  for (const line of content.split(/\r?\n/)) {
    if (/^##\s+Session Digest\s*$/i.test(line)) {
      inDigest = true
      hasDigest = true
      section = null
      continue
    }
    if (!inDigest) continue
    if (/^##\s+/.test(line) && !/^###\s+/.test(line)) break

    const modelMatch = line.match(MODEL_LINE)
    if (modelMatch) {
      modelLineCount++
      modelVersion = modelMatch[1].trim().slice(0, 100) || null
      continue
    }

    const attestationMatch = line.match(ATTESTATION_LINE)
    if (attestationMatch) {
      attestationLineCount++
      attestation = {
        schema: attestationMatch[1],
        producer: attestationMatch[2],
        integrity: attestationMatch[3].toLowerCase(),
      }
      continue
    }

    const headingMatch = line.match(/^###\s+(.+?)\s*$/)
    if (headingMatch) {
      section = normalizedHeading(headingMatch[1])
      continue
    }

    if (section === 'evidenz') {
      const match = line.match(PROVENANCE_LINE)
      if (!match) continue
      const [, id, ref, hash, excerpt = ''] = match
      const rows = provenance.get(id) ?? []
      if (!rows.some(row => row.ref === ref.trim() && row.hash === hash.toLowerCase())) {
        rows.push({ ref: ref.trim(), hash: hash.toLowerCase(), excerpt: excerpt.trim() })
      }
      provenance.set(id, rows)
      continue
    }

    const sectionKind = section ? SECTION_KIND[section] : undefined
    if (!sectionKind) continue
    const match = line.match(FACT_LINE)
    if (!match) continue
    const [, id, rawStatement, rawSalience, rawEvidence, rawConfidence] = match
    if (facts.has(id)) continue
    const statement = rawStatement.trim()
    const salienceScore = Number(rawSalience)
    const evidenceScore = Number(rawEvidence)
    if (!validStatement(statement) || salienceScore > 100 || evidenceScore > 100) continue
    facts.set(id, {
      id,
      kind: factKind(sectionKind, statement),
      statement,
      salienceScore,
      evidenceScore,
      confidence: rawConfidence.toLowerCase() as KnowledgeConfidence,
      provenance: [],
      integrityVerified: false,
    })
  }

  let parsedFacts = [...facts.values()].map(fact => ({
    ...fact,
    provenance: provenance.get(fact.id) ?? [],
  }))
  let integrityStatus: ParsedSessionDigest['integrityStatus'] = 'invalid'
  let integrityReason: string | null = null
  if (!hasDigest) {
    integrityStatus = 'missing'
    integrityReason = 'Kein Session Digest vorhanden'
  } else if (modelLineCount !== 1 || !modelVersion) {
    integrityReason = 'Genau eine gültige Modellzeile ist erforderlich'
  } else if (attestationLineCount === 0) {
    integrityStatus = 'missing'
    integrityReason = 'Digest-Integritätsnachweis fehlt'
  } else if (attestationLineCount !== 1 || !attestation) {
    integrityReason = 'Genau ein Digest-Integritätsnachweis ist erforderlich'
  } else if (attestation.schema !== SESSION_DIGEST_SCHEMA || attestation.producer !== SESSION_DIGEST_PRODUCER) {
    integrityReason = 'Digest-Schema oder Erzeuger ist nicht erlaubt'
  } else if (modelVersion !== KNOWLEDGE_SALIENCE_MODEL.version) {
    integrityReason = 'Digest-Modell ist nicht erlaubt'
  } else if (parsedFacts.length > 8 || parsedFacts.some(fact => !/^F[1-8]$/.test(fact.id))) {
    integrityReason = 'Digest-Fakt-IDs oder Faktanzahl sind ungültig'
  } else {
    const inconsistent = parsedFacts.find(fact => {
      const evidence = digestEvidenceScore(fact.provenance)
      return evidence === null
        || evidence !== fact.evidenceScore
        || digestConfidence(evidence) !== fact.confidence
    })
    if (inconsistent) {
      integrityReason = `Evidenzmetadaten für ${inconsistent.id} sind nicht reproduzierbar`
    } else {
      const expected = sessionDigestIntegrity(modelVersion, parsedFacts)
      if (expected !== attestation.integrity) {
        integrityReason = 'Digest-Inhalt stimmt nicht mit dem Integritätsnachweis überein'
      } else {
        integrityStatus = 'verified'
        parsedFacts = parsedFacts.map(fact => ({ ...fact, integrityVerified: true }))
      }
    }
  }
  return { hasDigest, modelVersion, facts: parsedFacts, integrityStatus, integrityReason }
}

export function hasCompleteDigestProvenance(fact: ParsedDigestFact): boolean {
  return fact.integrityVerified
    && fact.provenance.length > 0
    && fact.provenance.every(item => item.ref.length > 0 && /^[a-f0-9]{64}$/i.test(item.hash))
}
