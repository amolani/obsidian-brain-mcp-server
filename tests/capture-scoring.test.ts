import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreCapture } from '../services/capture-scoring.ts'
import type {
  KnowledgeFactKind,
  KnowledgeSalienceFact,
  KnowledgeSalienceSelection,
} from '../services/knowledge-salience.ts'

function fact(kind: KnowledgeFactKind, salienceScore: number, evidenceScore: number): KnowledgeSalienceFact {
  const statement = `${kind} example with durable operational meaning`
  return {
    id: `ks-${kind}`,
    modelVersion: 'knowledge-salience-v1',
    kind,
    statement,
    abstraction: { template: '{fact}', slots: { fact: statement }, rendered: statement },
    factors: {
      taskRelevance: 0.8,
      decisionOutcomeUtility: 0.8,
      noveltyInformativeness: 0.8,
      reusability: 0.8,
      specificity: 0.8,
    },
    salienceScore,
    evidenceScore,
    confidence: evidenceScore >= 75 ? 'high' : evidenceScore >= 45 ? 'medium' : 'low',
    provenance: [{ ref: `phase:${kind}`, source: 'phase', hash: 'a'.repeat(64), excerpt: statement }],
    selectionScore: 0.5,
  }
}

function selection(facts: KnowledgeSalienceFact[]): KnowledgeSalienceSelection {
  return {
    sessionId: 'capture-score-test',
    modelVersion: 'knowledge-salience-v1',
    scoreScale: 'ordinal_0_100_not_probability',
    facts,
    candidateCount: facts.length,
    excluded: { unsafeOrNoisy: 0, belowSalienceThreshold: 0, redundant: 0 },
  }
}

describe('semantic capture scoring', () => {
  test('keeps an important weakly supported decision in review instead of treating it as verified', () => {
    const scores = scoreCapture({
      content: 'irrelevant formatting',
      intent: { intent: 'planning' },
      clientMatchMethod: 'none',
      selection: selection([fact('decision', 91, 36)]),
    })

    assert.ok(scores.captureValue >= 90)
    assert.ok(scores.reviewNeed >= 45)
    assert.equal(scores.runbookReadiness, 0)
    assert.ok(scores.reasons.some(reason => /schwacher Evidenz/i.test(reason)))
  })

  test('requires a strongly evidenced change and verification for runbook readiness', () => {
    const incomplete = scoreCapture({
      content: '',
      intent: { intent: 'implementation' },
      selection: selection([fact('change', 82, 88)]),
    })
    const complete = scoreCapture({
      content: '',
      intent: { intent: 'implementation' },
      selection: selection([fact('change', 82, 88), fact('verification', 79, 88)]),
    })

    assert.ok(incomplete.runbookReadiness <= 55)
    assert.ok(complete.runbookReadiness >= 90)
    assert.ok(complete.reasons.some(reason => /Änderung und Verifikation/i.test(reason)))
  })

  test('raises review need for ambiguous routing independently of salience', () => {
    const exact = scoreCapture({
      content: '',
      clientMatchMethod: 'exact_cwd',
      selection: selection([fact('result', 72, 88)]),
    })
    const ambiguous = scoreCapture({
      content: '',
      clientMatchMethod: 'ambiguous_content',
      selection: selection([fact('result', 72, 88)]),
    })

    assert.ok(ambiguous.reviewNeed > exact.reviewNeed)
  })
})
