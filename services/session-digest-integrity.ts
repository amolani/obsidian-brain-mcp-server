import { createHash } from 'node:crypto'
import {
  type EvidenceProvenanceSource,
} from './evidence-scoring.ts'
import type { KnowledgeConfidence } from './knowledge-salience.ts'

export const LEGACY_SESSION_DIGEST_SCHEMA = 'session-digest-v1'
export const SESSION_DIGEST_SCHEMA = 'session-digest-v2'
export const SESSION_DIGEST_PRODUCER = 'knowledge-harvester'
export type SessionDigestSchema =
  | typeof LEGACY_SESSION_DIGEST_SCHEMA
  | typeof SESSION_DIGEST_SCHEMA

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

function provenanceSource(ref: string): EvidenceProvenanceSource | null {
  const source = ref.slice(0, ref.indexOf(':'))
  return (
    source === 'phase'
    || source === 'assistant_summary'
    || source === 'error_fix'
    || source === 'bash_pair'
  )
    ? source
    : null
}

export function isAllowedDigestProvenance(item: DigestIntegrityProvenance): boolean {
  return /^(?:phase|assistant_summary|error_fix|bash_pair):[\p{L}\p{N}._:@-]{1,180}$/u.test(item.ref)
    && /^[a-f0-9]{64}$/.test(item.hash)
}

function parsedEvidenceItems(items: DigestIntegrityProvenance[]) {
  const scored = []
  for (const item of items) {
    if (!isAllowedDigestProvenance(item)) return null
    const source = provenanceSource(item.ref)
    if (!source) return null
    scored.push({ source, hash: item.hash })
  }
  return scored
}

function frozenEvidenceScoreV1(
  items: DigestIntegrityProvenance[],
  errorFixStrength: 0.44 | 0.67,
): number | null {
  const scored = parsedEvidenceItems(items)
  if (!scored || scored.length === 0) return null
  const sourceStrengths: Record<EvidenceProvenanceSource, number> = {
    assistant_summary: 0.36,
    error_fix: errorFixStrength,
    phase: 0.5,
    bash_pair: 0.88,
  }
  const byHash = new Map<string, EvidenceProvenanceSource>()
  for (const item of scored) {
    const current = byHash.get(item.hash)
    if (!current || sourceStrengths[item.source] > sourceStrengths[current]) {
      byHash.set(item.hash, item.source)
    }
  }
  const independent = [...byHash.values()]
  const maxStrength = independent.reduce(
    (max, source) => Math.max(max, sourceStrengths[source]),
    0,
  )
  const sourceTypeCount = new Set(independent).size
  const corroboration = Math.min(0.12, Math.max(0, independent.length - 1) * 0.04)
    + Math.min(0.08, Math.max(0, sourceTypeCount - 1) * 0.04)
  return Math.round(Math.min(1, maxStrength + corroboration) * 100)
}

/**
 * Frozen digest verification registry. Every salience/schema pair dispatches
 * through an immutable evidence verifier; changing the active scorer cannot
 * reinterpret historical digests.
 */
export const SESSION_DIGEST_MODEL_REGISTRY = {
  'knowledge-salience-v1': {
    evidenceModelVersion: 'evidence-scoring-v1',
    confidenceThresholds: {
      high: 75,
      medium: 45,
    },
    evidenceVerifiers: {
      [LEGACY_SESSION_DIGEST_SCHEMA]: (items: DigestIntegrityProvenance[]) => {
        const current = frozenEvidenceScoreV1(items, 0.44)
        const historical = frozenEvidenceScoreV1(items, 0.67)
        return [...new Set(
          [current, historical].filter((score): score is number => score !== null),
        )]
      },
      [SESSION_DIGEST_SCHEMA]: (items: DigestIntegrityProvenance[]) => {
        const score = frozenEvidenceScoreV1(items, 0.44)
        return score === null ? [] : [score]
      },
    },
  },
} as const

export function isSupportedSessionDigestSchema(value: string): value is SessionDigestSchema {
  return value === SESSION_DIGEST_SCHEMA || value === LEGACY_SESSION_DIGEST_SCHEMA
}

/** Recomputes the registered ordinal evidence score for digest rendering. */
export function digestEvidenceScore(
  items: DigestIntegrityProvenance[],
  modelVersion: string = 'knowledge-salience-v1',
): number | null {
  const model = SESSION_DIGEST_MODEL_REGISTRY[
    modelVersion as keyof typeof SESSION_DIGEST_MODEL_REGISTRY
  ]
  if (!model) return null
  const verifier = model.evidenceVerifiers[SESSION_DIGEST_SCHEMA]
  return verifier(items)[0] ?? null
}

/**
 * V1 briefly used a stronger error_fix value in its verifier than in the
 * selector. Both historical outcomes remain readable; V2 has one shared score.
 */
export function digestEvidenceScoreCandidates(
  items: DigestIntegrityProvenance[],
  schema: string,
  modelVersion: string = 'knowledge-salience-v1',
): number[] {
  if (!isSupportedSessionDigestModel(modelVersion, schema)) return []
  const model = SESSION_DIGEST_MODEL_REGISTRY[modelVersion]
  const verifier = model.evidenceVerifiers[schema as keyof typeof model.evidenceVerifiers]
  return verifier(items)
}

export function isSupportedSessionDigestModel(
  modelVersion: string,
  schema: string,
): modelVersion is keyof typeof SESSION_DIGEST_MODEL_REGISTRY {
  const model = SESSION_DIGEST_MODEL_REGISTRY[
    modelVersion as keyof typeof SESSION_DIGEST_MODEL_REGISTRY
  ]
  return !!model && Object.hasOwn(model.evidenceVerifiers, schema)
}

export function digestConfidence(
  score: number,
  modelVersion: keyof typeof SESSION_DIGEST_MODEL_REGISTRY = 'knowledge-salience-v1',
): KnowledgeConfidence {
  const thresholds = SESSION_DIGEST_MODEL_REGISTRY[modelVersion].confidenceThresholds
  if (score >= thresholds.high) return 'high'
  if (score >= thresholds.medium) return 'medium'
  return 'low'
}

function canonicalDigestPayload(
  schema: SessionDigestSchema,
  modelVersion: string,
  facts: DigestIntegrityFact[],
): string {
  return JSON.stringify({
    schema,
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
export function sessionDigestIntegrity(
  modelVersion: string,
  facts: DigestIntegrityFact[],
  schema: SessionDigestSchema = SESSION_DIGEST_SCHEMA,
): string {
  return createHash('sha256').update(canonicalDigestPayload(schema, modelVersion, facts)).digest('hex')
}

export function renderSessionDigestAttestation(integrity: string): string {
  return `_Digest-Integrität: \`${SESSION_DIGEST_SCHEMA}\` · Erzeuger: \`${SESSION_DIGEST_PRODUCER}\` · SHA-256: \`${integrity}\`_`
}
