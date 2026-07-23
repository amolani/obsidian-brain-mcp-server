import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KNOWLEDGE_FACT_TEMPLATES,
  KNOWLEDGE_SALIENCE_MODEL,
  type KnowledgeFactKind,
  type KnowledgeProvenanceSource,
  type KnowledgeSalienceFact,
  type KnowledgeSalienceSelection,
} from '../services/knowledge-salience.ts'
import { renderSessionDigest } from '../services/session-digest.ts'
import { parseSessionDigestFacts } from '../services/session-digest-facts.ts'

function fact(options: {
  id: string
  kind: KnowledgeFactKind
  statement: string
  salience?: number
  evidence: number
  source: KnowledgeProvenanceSource
  excerpt: string
}): KnowledgeSalienceFact {
  const template = KNOWLEDGE_FACT_TEMPLATES[options.kind]
  return {
    id: options.id,
    modelVersion: KNOWLEDGE_SALIENCE_MODEL.version,
    kind: options.kind,
    statement: options.statement,
    abstraction: {
      template,
      slots: { fact: options.statement },
      rendered: template.replace('{fact}', options.statement),
    },
    factors: {
      taskRelevance: 0.8,
      decisionOutcomeUtility: 0.9,
      noveltyInformativeness: 0.7,
      reusability: 0.75,
      specificity: 0.7,
    },
    salienceScore: options.salience ?? 78,
    evidenceScore: options.evidence,
    confidence: options.evidence >= 75 ? 'high' : options.evidence >= 45 ? 'medium' : 'low',
    provenance: [{
      ref: `${options.source}:${options.id}`,
      source: options.source,
      hash: 'a'.repeat(64),
      excerpt: options.excerpt,
    }],
    selectionScore: 0.61,
  }
}

function selection(facts: KnowledgeSalienceFact[], candidateCount = facts.length): KnowledgeSalienceSelection {
  return {
    sessionId: 'digest-test',
    modelVersion: KNOWLEDGE_SALIENCE_MODEL.version,
    scoreScale: KNOWLEDGE_SALIENCE_MODEL.scoreScale,
    facts,
    candidateCount,
    excluded: { unsafeOrNoisy: 0, belowSalienceThreshold: 0, redundant: 0 },
  }
}

function section(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return markdown.match(new RegExp(`### ${escaped}\\n\\n([\\s\\S]*?)(?=\\n### |$)`))?.[1]?.trim() ?? ''
}

describe('session digest', () => {
  test('renders typed facts by semantic section and keeps weak evidence in Review', () => {
    const rawAssistantParagraph = 'We decided to use PostgreSQL for audit events after a long discussion that must not be repeated as raw prose.'
    const digest = renderSessionDigest({
      title: 'Restore the worker',
      selection: selection([
        fact({
          id: 'cause',
          kind: 'cause',
          statement: 'A stale lock prevented the worker from starting.',
          evidence: 44,
          source: 'error_fix',
          excerpt: 'Error: worker failed; fix: stale lock removed',
        }),
        fact({
          id: 'decision',
          kind: 'decision',
          statement: 'PostgreSQL will store durable audit events.',
          evidence: 36,
          source: 'assistant_summary',
          excerpt: rawAssistantParagraph,
        }),
        fact({
          id: 'verification',
          kind: 'verification',
          statement: 'The worker health check returned healthy.',
          evidence: 88,
          source: 'bash_pair',
          excerpt: 'Command: workerctl health; result: healthy',
        }),
      ]),
    })

    assert.equal(section(digest, 'Root Cause'), '- Keine belastbare Aussage erkannt')
    assert.match(section(digest, 'Verifikation'), /health check returned healthy/)
    assert.equal(section(digest, 'Entscheidung'), '- Keine belastbare Aussage erkannt')
    assert.match(section(digest, 'Review'), /Unbestätigt: A stale lock prevented the worker/)
    assert.match(section(digest, 'Review'), /Unbestätigt: PostgreSQL will store durable audit events/)
    assert.match(digest, /Salienz 78\/100 · Evidenz 44\/100 · low/)
    assert.match(section(digest, 'Evidenz'), /error_fix:cause.*Hash `a{64}`/)
    assert.match(digest, /Digest-Integrität: `session-digest-v2` .* Erzeuger: `knowledge-harvester` .* SHA-256: `[a-f0-9]{64}`/)
    assert.match(section(digest, 'Evidenz'), /Command: workerctl health; result: healthy/)
    assert.doesNotMatch(section(digest, 'Evidenz'), new RegExp(rawAssistantParagraph))
    assert.doesNotMatch(digest, /Ajenti|vmbr-trunk|interfaces\.d/)
    const parsed = parseSessionDigestFacts(digest)
    assert.equal(parsed.integrityStatus, 'verified')
    assert.deepEqual(parsed.facts.map(item => item.id), ['F3'])
  })

  test('round-trips independent phase and error/fix provenance with one shared score', () => {
    const mixed = fact({
      id: 'mixed-cause',
      kind: 'cause',
      statement: 'A stale lock prevented the worker from starting.',
      evidence: 58,
      source: 'phase',
      excerpt: 'Phase outcome identified the stale lock.',
    })
    mixed.provenance = [
      {
        ref: 'phase:worker-outcome',
        source: 'phase',
        hash: 'a'.repeat(64),
        excerpt: 'Phase outcome identified the stale lock.',
        origin: 'phase:worker',
      },
      {
        ref: 'error_fix:worker-recovery',
        source: 'error_fix',
        hash: 'b'.repeat(64),
        excerpt: 'Error: worker failed; fix: stale lock removed',
        origin: 'assistant:worker-recovery',
      },
    ]

    const digest = renderSessionDigest({
      title: 'Restore the worker',
      selection: selection([mixed]),
    })
    const parsed = parseSessionDigestFacts(digest)

    assert.equal(parsed.integrityStatus, 'verified')
    assert.equal(parsed.facts.length, 1)
    assert.equal(parsed.facts[0].evidenceScore, 58)
    assert.deepEqual(parsed.facts[0].provenance.map(item => item.ref), [
      'phase:worker-outcome',
      'error_fix:worker-recovery',
    ])
  })

  test('uses the salience selector for legacy input without copying assistant blocks or command lists', () => {
    const assistantBlock = [
      'Summary: The worker failed because its lock file was stale.',
      'We decided to use an atomic filesystem lock.',
      'Verification: The concurrency test passed 40 consecutive runs.',
    ].join(' ')
    const rawCommand = 'curl -H "Authorization: Bearer top-secret-token-value" https://example.invalid/debug'
    const digest = renderSessionDigest({
      title: 'Prevent concurrent workers',
      sessionId: 'legacy-session',
      summaries: [assistantBlock],
      procedures: [rawCommand],
      redactionCount: 1,
    })

    assert.match(digest, /knowledge-salience-v\d/)
    assert.match(section(digest, 'Review'), /Unbestätigt:/)
    assert.doesNotMatch(digest, new RegExp(assistantBlock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(digest, /top-secret-token-value|example\.invalid\/debug/)
    assert.match(section(digest, 'Nicht übernommen'), /1 ungebundene Befehle/)
    assert.match(section(digest, 'Nicht übernommen'), /1 sensible Fundstelle/)
  })

  test('bounds facts and provenance even if a caller supplies a larger selection', () => {
    const facts = Array.from({ length: 12 }, (_, index) => fact({
      id: `result-${index + 1}`,
      kind: 'result',
      statement: `Result ${index + 1} was recorded with a stable outcome.`,
      evidence: 50,
      source: 'phase',
      excerpt: `Raw phase outcome ${index + 1}`,
    }))
    const digest = renderSessionDigest({ title: 'Bounded digest', selection: selection(facts, 12) })
    const resultSection = section(digest, 'Ergebnis')
    const provenanceSection = section(digest, 'Evidenz')

    assert.match(digest, /8\/12 Fakten ausgewählt/)
    assert.equal((resultSection.match(/^- \[F\d+]/gm) ?? []).length, 8)
    assert.equal((provenanceSection.match(/^- \[F\d+]/gm) ?? []).length, 8)
    assert.doesNotMatch(digest, /\[F9]/)
    assert.doesNotMatch(provenanceSection, /Raw phase outcome/)
  })
})
