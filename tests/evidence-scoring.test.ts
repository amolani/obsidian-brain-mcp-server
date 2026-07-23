import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyEvidenceConflictCeiling,
  EVIDENCE_SCORING_MODEL,
  scoreEvidence,
  scoreEvidenceSummary,
  summarizeEvidence,
} from '../services/evidence-scoring.ts'

const hash = (value: string) => value.repeat(64)

describe('shared evidence scoring', () => {
  test('keeps versioned source strengths explicit and error/fix prose conservative', () => {
    assert.equal(EVIDENCE_SCORING_MODEL.version, 'evidence-scoring-v1')
    assert.equal(EVIDENCE_SCORING_MODEL.scoreScale, 'ordinal_0_100_not_probability')
    assert.equal(scoreEvidence([{ source: 'assistant_summary', hash: hash('a') }]), 36)
    assert.equal(scoreEvidence([{ source: 'error_fix', hash: hash('b') }]), 44)
    assert.equal(scoreEvidence([{ source: 'phase', hash: hash('c') }]), 50)
    assert.equal(scoreEvidence([{ source: 'bash_pair', hash: hash('d') }]), 88)
  })

  test('corroborates independent phase and error/fix evidence with the shared formula', () => {
    assert.equal(scoreEvidence([
      { source: 'phase', hash: hash('a'), origin: 'phase:one' },
      { source: 'error_fix', hash: hash('b'), origin: 'assistant:two' },
    ]), 58)
    assert.equal(scoreEvidenceSummary({
      sourceTypes: ['phase', 'error_fix'],
      independentUnitCount: 2,
    }), 58)
  })

  test('deduplicates equal hashes and optional stable origins before corroboration', () => {
    assert.equal(scoreEvidence([
      { source: 'error_fix', hash: hash('a'), origin: 'assistant:shared' },
      { source: 'phase', hash: hash('b'), origin: 'assistant:shared' },
    ]), 50)
    assert.equal(scoreEvidence([
      { source: 'error_fix', hash: hash('c') },
      { source: 'phase', hash: hash('c') },
    ]), 50)
    assert.equal(scoreEvidence([]), null)
  })

  test('deduplicates transitive hash/origin components independently of input order', () => {
    const items = [
      { source: 'bash_pair' as const, hash: hash('a'), origin: 'tool:one' },
      { source: 'assistant_summary' as const, hash: hash('a'), origin: 'assistant:bridge' },
      { source: 'phase' as const, hash: hash('b'), origin: 'assistant:bridge' },
    ]
    const expected = {
      sourceTypes: ['bash_pair'],
      independentUnitCount: 1,
      rawScore: 88,
    }
    assert.deepEqual(summarizeEvidence(items), expected)
    assert.deepEqual(summarizeEvidence([...items].reverse()), expected)
    assert.equal(scoreEvidence(items), 88)
  })

  test('validates compact provenance summaries and applies the versioned conflict ceiling', () => {
    assert.equal(scoreEvidenceSummary({ sourceTypes: [], independentUnitCount: 0 }), null)
    assert.equal(scoreEvidenceSummary({
      sourceTypes: ['phase', 'bash_pair'],
      independentUnitCount: 2,
    }), 96)
    assert.equal(applyEvidenceConflictCeiling(96, true), 44)
    assert.equal(applyEvidenceConflictCeiling(96, false), 96)
    assert.equal(applyEvidenceConflictCeiling(36, true), 36)
    assert.equal(scoreEvidenceSummary({
      sourceTypes: ['assistant_summary', 'error_fix', 'phase', 'bash_pair'],
      independentUnitCount: 4,
    }), 100)
    assert.equal(scoreEvidenceSummary({
      sourceTypes: ['phase'],
      independentUnitCount: 100,
    }), 62)
    assert.throws(
      () => scoreEvidenceSummary({
        sourceTypes: ['phase', 'bash_pair'],
        independentUnitCount: 1,
      }),
      /nicht kleiner/,
    )
  })
})
