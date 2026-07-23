/**
 * Shared, deterministic evidence model for extraction and persisted digests.
 *
 * These values are ordinal ranking inputs, not calibrated probabilities.
 * Bump the version whenever source strengths or corroboration rules change.
 */
export const EVIDENCE_SCORING_MODEL = {
  version: 'evidence-scoring-v1',
  scoreScale: 'ordinal_0_100_not_probability',
  sourceStrengths: {
    assistant_summary: 0.36,
    // Error/fix blocks originate in assistant prose unless independently
    // corroborated; relabelling the prose must not raise its evidence strength.
    error_fix: 0.44,
    phase: 0.5,
    bash_pair: 0.88,
  },
  corroboration: {
    perIndependentUnit: 0.04,
    maxIndependentUnits: 0.12,
    perAdditionalSourceType: 0.04,
    maxAdditionalSourceTypes: 0.08,
  },
  conflictScoreCeiling: 44,
} as const

export type EvidenceProvenanceSource = keyof typeof EVIDENCE_SCORING_MODEL.sourceStrengths

export interface EvidenceScoreItem {
  source: EvidenceProvenanceSource
  hash: string
  /**
   * Optional stable evidence unit. Different parser views of one transcript
   * span must not corroborate each other.
   */
  origin?: string
}

export interface EvidenceScoreSummaryInput {
  sourceTypes: readonly EvidenceProvenanceSource[]
  independentUnitCount: number
}

export interface EvidenceSummary extends EvidenceScoreSummaryInput {
  rawScore: number
}

export function isEvidenceProvenanceSource(value: string): value is EvidenceProvenanceSource {
  return Object.hasOwn(EVIDENCE_SCORING_MODEL.sourceStrengths, value)
}

function compareEvidenceItems(left: EvidenceScoreItem, right: EvidenceScoreItem): number {
  const strengths = EVIDENCE_SCORING_MODEL.sourceStrengths
  return strengths[right.source] - strengths[left.source]
    || left.source.localeCompare(right.source, 'en')
    || left.hash.localeCompare(right.hash, 'en')
    || (left.origin ?? '').localeCompare(right.origin ?? '', 'en')
}

function sameEvidenceComponent(left: EvidenceScoreItem, right: EvidenceScoreItem): boolean {
  return left.hash === right.hash
    || (!!left.origin && !!right.origin && left.origin === right.origin)
}

/**
 * Produces sufficient statistics after canonical, transitive deduplication.
 * Hash and stable-origin links form connected components; only the strongest
 * deterministic representation of each component contributes evidence.
 */
export function summarizeEvidence(items: readonly EvidenceScoreItem[]): EvidenceSummary | null {
  if (items.length === 0) return null

  const ordered = [...items].sort(compareEvidenceItems)
  const parent = ordered.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    while (parent[index] !== index) {
      const next = parent[index]
      parent[index] = root
      index = next
    }
    return root
  }
  const union = (left: number, right: number): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }

  for (let left = 0; left < ordered.length; left++) {
    for (let right = left + 1; right < ordered.length; right++) {
      if (sameEvidenceComponent(ordered[left], ordered[right])) union(left, right)
    }
  }

  const strongestByComponent = new Map<number, EvidenceScoreItem>()
  for (let index = 0; index < ordered.length; index++) {
    const root = find(index)
    const current = strongestByComponent.get(root)
    if (!current || compareEvidenceItems(ordered[index], current) < 0) {
      strongestByComponent.set(root, ordered[index])
    }
  }
  const independent = [...strongestByComponent.values()].sort(compareEvidenceItems)
  const sourceTypes = [...new Set(independent.map(item => item.source))].sort()
  const independentUnitCount = independent.length
  const rawScore = scoreEvidenceSummary({ sourceTypes, independentUnitCount })
  if (rawScore === null) return null
  return { sourceTypes, independentUnitCount, rawScore }
}

/**
 * Reconstructs the score from a compact feature snapshot. This is also the
 * canonical formula used after full provenance has been deduplicated.
 */
export function scoreEvidenceSummary(input: EvidenceScoreSummaryInput): number | null {
  const sourceTypes = [...new Set(input.sourceTypes)]
  if (!Number.isInteger(input.independentUnitCount) || input.independentUnitCount < 0) {
    throw new Error('independentUnitCount muss eine nicht-negative Ganzzahl sein')
  }
  if (sourceTypes.length === 0) {
    if (input.independentUnitCount !== 0) {
      throw new Error('independentUnitCount muss ohne sourceTypes 0 sein')
    }
    return null
  }
  if (input.independentUnitCount < sourceTypes.length) {
    throw new Error('independentUnitCount darf nicht kleiner als die Zahl der sourceTypes sein')
  }

  const strengths = EVIDENCE_SCORING_MODEL.sourceStrengths
  const maxStrength = sourceTypes.reduce(
    (max, source) => Math.max(max, strengths[source]),
    0,
  )
  const rules = EVIDENCE_SCORING_MODEL.corroboration
  const corroboration = Math.min(
    rules.maxIndependentUnits,
    Math.max(0, input.independentUnitCount - 1) * rules.perIndependentUnit,
  ) + Math.min(
    rules.maxAdditionalSourceTypes,
    Math.max(0, sourceTypes.length - 1) * rules.perAdditionalSourceType,
  )

  return Math.round(Math.min(1, maxStrength + corroboration) * 100)
}

export function applyEvidenceConflictCeiling(score: number, conflict: boolean): number {
  return conflict ? Math.min(EVIDENCE_SCORING_MODEL.conflictScoreCeiling, score) : score
}

/**
 * Computes one ordinal evidence score from independent provenance units.
 * Equal hashes, or equal non-empty origins when present, count only once; the
 * strongest representation of that unit wins deterministically.
 */
export function scoreEvidence(items: readonly EvidenceScoreItem[]): number | null {
  return summarizeEvidence(items)?.rawScore ?? null
}
