import { createHash } from 'node:crypto'
import { KNOWLEDGE_SALIENCE_MODEL, type KnowledgeConfidence } from './knowledge-salience.ts'

export const SESSION_DIGEST_SCHEMA = 'session-digest-v1'
export const SESSION_DIGEST_PRODUCER = 'knowledge-harvester'

export interface DigestIntegrityProvenance {
  ref: string
  hash: string
  excerpt: string
}

export interface DigestIntegrityFact {
  id: string
  kind: string
  statement: string
  salienceScore: number
  evidenceScore: number
  confidence: KnowledgeConfidence
  provenance: DigestIntegrityProvenance[]
}

const SOURCE_STRENGTH = {
  assistant_summary: 0.36,
  phase: 0.5,
  error_fix: 0.67,
  bash_pair: 0.88,
} as const

type DigestProvenanceSource = keyof typeof SOURCE_STRENGTH

function provenanceSource(ref: string): DigestProvenanceSource | null {
  const source = ref.slice(0, ref.indexOf(':')) as DigestProvenanceSource
  return Object.hasOwn(SOURCE_STRENGTH, source) ? source : null
}

export function isAllowedDigestProvenance(item: DigestIntegrityProvenance): boolean {
  return /^(?:phase|assistant_summary|error_fix|bash_pair):[\p{L}\p{N}._:@-]{1,180}$/u.test(item.ref)
    && /^[a-f0-9]{64}$/.test(item.hash)
}

/** Recomputes the ordinal evidence score from the evidence types persisted in the digest. */
export function digestEvidenceScore(items: DigestIntegrityProvenance[]): number | null {
  const byHash = new Map<string, DigestProvenanceSource>()
  for (const item of items) {
    if (!isAllowedDigestProvenance(item)) return null
    const source = provenanceSource(item.ref)
    if (!source) return null
    const current = byHash.get(item.hash)
    if (!current || SOURCE_STRENGTH[source] > SOURCE_STRENGTH[current]) byHash.set(item.hash, source)
  }
  const independent = [...byHash.values()]
  if (independent.length === 0) return null
  const maxStrength = independent.reduce((max, source) => Math.max(max, SOURCE_STRENGTH[source]), 0)
  const sourceTypes = new Set(independent).size
  const corroboration = Math.min(0.12, Math.max(0, independent.length - 1) * 0.04)
    + Math.min(0.08, Math.max(0, sourceTypes - 1) * 0.04)
  return Math.round(Math.min(1, maxStrength + corroboration) * 100)
}

export function digestConfidence(score: number): KnowledgeConfidence {
  if (score >= KNOWLEDGE_SALIENCE_MODEL.confidenceThresholds.high) return 'high'
  if (score >= KNOWLEDGE_SALIENCE_MODEL.confidenceThresholds.medium) return 'medium'
  return 'low'
}

function canonicalDigestPayload(modelVersion: string, facts: DigestIntegrityFact[]): string {
  return JSON.stringify({
    schema: SESSION_DIGEST_SCHEMA,
    producer: SESSION_DIGEST_PRODUCER,
    modelVersion,
    facts: [...facts].sort((left, right) => left.id.localeCompare(right.id, 'en')).map(fact => ({
      id: fact.id,
      kind: fact.kind,
      statement: fact.statement,
      salienceScore: fact.salienceScore,
      evidenceScore: fact.evidenceScore,
      confidence: fact.confidence,
      provenance: fact.provenance.map(item => ({
        ref: item.ref,
        hash: item.hash,
        excerpt: item.excerpt,
      })),
    })),
  })
}

/**
 * Tamper-evident digest over the exact machine-readable facts and their full
 * provenance hashes. This is deliberately local and deterministic: it catches
 * persisted Markdown edits, but is not a signature against an attacker who can
 * execute project code or rewrite both the evidence and this checksum.
 */
export function sessionDigestIntegrity(modelVersion: string, facts: DigestIntegrityFact[]): string {
  return createHash('sha256').update(canonicalDigestPayload(modelVersion, facts)).digest('hex')
}

export function renderSessionDigestAttestation(integrity: string): string {
  return `_Digest-Integrität: \`${SESSION_DIGEST_SCHEMA}\` · Erzeuger: \`${SESSION_DIGEST_PRODUCER}\` · SHA-256: \`${integrity}\`_`
}
