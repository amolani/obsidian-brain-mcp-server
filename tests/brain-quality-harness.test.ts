import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateBrainQualityScore,
  copiedNGramCoverage,
  countExactCopiedAssistantBlocks,
  evaluateDigestDistillation,
  isKnowledgeDistillationHardGateFailure,
  longestCommonWordSequence,
  runBrainQualityHarness,
  type BrainQualityFixtureResult,
} from '../services/brain-quality-harness.ts'

function fixture(
  id: string,
  type: BrainQualityFixtureResult['type'],
  score: number,
): BrainQualityFixtureResult {
  return { id, type, score, status: 'pass', metrics: [], failures: [] }
}

describe('brain quality harness', () => {
  test('detects contiguous transcript copying and copied five-gram coverage', () => {
    const source = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'

    assert.equal(longestCommonWordSequence('start beta gamma delta epsilon end', [source]), 4)
    assert.equal(copiedNGramCoverage('alpha beta gamma delta epsilon zeta eta', [source]), 1)
    assert.equal(copiedNGramCoverage('eins zwei drei vier fünf sechs sieben', [source]), 0)
  })

  test('counts complete long assistant blocks copied anywhere in generated Markdown', () => {
    const copied = 'Diese ausführliche Assistentenantwort enthält genug einzelne Wörter und beschreibt einen gesamten Arbeitsblock, der nicht vollständig in die dauerhafte Notiz übernommen werden darf.'
    const short = 'Kurzer technischer Satz.'
    const generated = `# Capture\n\n${copied.replace(/ /g, '  ')}\n\n${short}`

    assert.equal(countExactCopiedAssistantBlocks(generated, [copied, copied, short], 12), 1)
    assert.equal(countExactCopiedAssistantBlocks('# Capture\n\nSaubere Paraphrase.', [copied], 12), 0)
  })

  test('distillation evaluator rejects critical misses, wrong sections, and verbatim assistant prose', () => {
    const copied = 'Als verbindliche Entscheidung verwenden wir den Read Replica Umschaltplan, weil dieser einen getesteten Rückweg ermöglicht und die Produktionsdaten während der Migration geschützt bleiben.'
    const [copiedStart, copiedEnd] = copied.split(', weil ')
    const digest = [
      '## Session Digest',
      '',
      '### Änderung / Fix',
      '',
      `- ${copiedStart},`,
      `  weil ${copiedEnd}`,
      '',
      '### Verifikation',
      '',
      '- Der Testlauf war erfolgreich.',
    ].join('\n')
    const result = evaluateDigestDistillation({
      digest,
      generatedContent: `# Capture\n\n${digest}`,
      narrativeBlocks: [copied],
      assistantBlocks: [copied],
      minLongAssistantBlockWords: 10,
      expectedAtoms: [
        {
          id: 'missing-critical-verification',
          importance: 'critical',
          kind: 'verification',
          section: 'Verifikation',
          pattern: 'Schreib- und Leseprüfung bestanden',
        },
        {
          id: 'misplaced-decision',
          importance: 'high',
          kind: 'decision',
          section: 'Verifikation',
          pattern: 'Read Replica Umschaltplan',
        },
      ],
    })

    assert.ok(result.failures.some(failure => failure.includes('critical atom missed')))
    assert.ok(result.failures.some(failure => failure.includes('atom section mismatch')))
    assert.ok(result.failures.some(failure => failure.includes('longest common word sequence')))
    assert.ok(result.failures.some(failure => failure.includes('copied 5-gram coverage')))
    assert.ok(result.failures.some(failure => failure.includes('distilled compression ratio')))
    assert.ok(result.failures.some(failure => failure.includes('assistant blocks copied globally')))
    assert.equal(result.metrics.find(item => item.id === 'digest_importance_weighted_atom_recall')?.value, 3 / 8)
    assert.equal(result.metrics.find(item => item.id === 'digest_section_accuracy')?.value, 0)
    assert.equal(result.metrics.find(item => item.id === 'global_exact_copied_assistant_blocks')?.value, 1)
    assert.equal(result.metrics.find(item => item.id === 'digest_longest_common_word_sequence')?.threshold, 12)
    assert.equal(result.metrics.find(item => item.id === 'digest_copied_5gram_coverage')?.threshold, 0.35)
    assert.equal(result.metrics.find(item => item.id === 'digest_distilled_compression_ratio')?.threshold, 0.30)
    assert.equal(
      result.failures.some(failure => isKnowledgeDistillationHardGateFailure(failure)),
      true,
      'critical misses and anti-verbatim violations must remain hard release gates',
    )
  })

  test('exempts explicitly headed evidence excerpts from active anti-verbatim assertions', () => {
    const evidence = 'Der vollständige Evidenzsatz darf als markierter Auszug erscheinen und enthält absichtlich viele exakt kopierte Wörter aus der ursprünglichen Assistentenantwort für die spätere Quellenprüfung.'
    const digest = [
      '## Session Digest',
      '',
      '### Problem',
      '',
      '- Die Migration benötigt eine rückrollbare Strategie.',
      '',
      '### Evidence Excerpts',
      '',
      `- ${evidence}`,
    ].join('\n')
    const result = evaluateDigestDistillation({
      digest,
      generatedContent: digest,
      narrativeBlocks: [evidence],
      assistantBlocks: [evidence],
      maxExactCopiedAssistantBlocks: 1,
      minLongAssistantBlockWords: 10,
      expectedAtoms: [{
        id: 'migration-problem',
        importance: 'medium',
        kind: 'problem',
        section: 'Problem',
        pattern: 'Migration.*rückrollbare Strategie',
      }],
    })

    assert.equal(result.failures.length, 0, JSON.stringify(result.failures))
    assert.equal(result.metrics.find(item => item.id === 'digest_longest_common_word_sequence')?.value, 1)
    assert.equal(result.metrics.find(item => item.id === 'digest_copied_5gram_coverage')?.value, 0)
  })

  test('gates active digest assertion words at a 0.30 narrative compression ratio with an optional override', () => {
    const narrative = 'eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn zwanzig'
    const digest = [
      '## Session Digest',
      '',
      '### Ergebnis',
      '',
      '- Alpha beta gamma delta epsilon zeta eta.',
    ].join('\n')
    const baseInput = {
      digest,
      generatedContent: digest,
      narrativeBlocks: [narrative],
      assistantBlocks: [],
      expectedAtoms: [{
        id: 'compact-result',
        importance: 'medium' as const,
        kind: 'result',
        section: 'Ergebnis',
        pattern: 'Alpha beta gamma delta epsilon zeta eta',
      }],
    }

    const result = evaluateDigestDistillation(baseInput)
    const compression = result.metrics.find(item => item.id === 'digest_distilled_compression_ratio')
    const failure = result.failures.find(item => item.includes('distilled compression ratio'))

    assert.equal(compression?.value, 7 / 20)
    assert.equal(compression?.threshold, 0.30)
    assert.ok(failure)
    assert.equal(isKnowledgeDistillationHardGateFailure(failure), true)

    const overridden = evaluateDigestDistillation({
      ...baseInput,
      maxDistilledCompressionRatio: 0.36,
    })
    assert.equal(
      overridden.failures.some(item => item.includes('distilled compression ratio')),
      false,
    )
    assert.equal(
      overridden.metrics.find(item => item.id === 'digest_distilled_compression_ratio')?.threshold,
      0.36,
    )
  })

  test('uses the normalized contract weights instead of averaging fixture count', () => {
    const fixtures = [
      fixture('capture-a', 'harvester_update', 80),
      fixture('capture-b', 'session_digest', 100),
      fixture('retrieval', 'retrieval', 50),
      fixture('promotion', 'promotion', 70),
      fixture('review', 'review', 60),
      fixture('background', 'background', 40),
      fixture('policy-is-a-gate', 'policy', 0),
      fixture('redaction-is-a-gate', 'surface_redaction', 0),
    ]

    const result = calculateBrainQualityScore(fixtures)
    const expected = ((90 * 0.25) + (50 * 0.20) + (70 * 0.20) + (60 * 0.15) + (40 * 0.10)) / 0.90

    assert.ok(Math.abs(result.score - expected) < 1e-9)
    assert.deepEqual(result.categories.map(category => category.id), [
      'capture',
      'retrieval',
      'promotion',
      'review',
      'background',
    ])
    assert.deepEqual(result.categories[0]?.fixtureIds, ['capture-a', 'capture-b'])
    assert.equal(result.categories.reduce((sum, category) => sum + category.normalizedWeight, 0), 1)
  })

  test('sets the weighted score to zero when a hard safety gate fails', () => {
    const fixtures = [
      fixture('capture', 'harvester_update', 100),
      fixture('retrieval', 'retrieval', 100),
      fixture('promotion', 'promotion', 100),
      fixture('review', 'review', 100),
      fixture('background', 'background', 100),
    ]

    const result = calculateBrainQualityScore(fixtures, true)

    assert.equal(result.score, 0)
    assert.equal(result.categories.reduce((sum, category) => sum + category.contribution, 0), 100)
  })

  test('legacy golden fixtures remain schema-compatible while distillation fixtures expose integration gaps', async () => {
    const result = await runBrainQualityHarness()
    assert.equal(result.scoreCategories.length, 5)
    assert.ok(result.scoreCategories.every(category => category.fixtureIds.length > 0))
    if (result.hardGateFailures.length > 0) assert.equal(result.score, 0)
    else assert.ok(Math.abs(result.score - result.scoreCategories.reduce((sum, category) => sum + category.contribution, 0)) < 1e-9)
    assert.ok(result.fixtures.some(fixture => fixture.id === 'hug-late-session'))
    assert.ok(result.fixtures.some(fixture => fixture.id === 'surface-redaction'))

    const distillationIds = new Set([
      'session-digest-long-network',
      'session-digest-troubleshooting',
      'short-critical-decision',
      'long-debug-no-learning',
      'verbatim-copy-trap',
    ])
    const distillationMetricIds = new Set([
      'digest_importance_weighted_atom_recall',
      'digest_section_accuracy',
      'digest_longest_common_word_sequence',
      'digest_copied_5gram_coverage',
      'digest_distilled_compression_ratio',
      'global_exact_copied_assistant_blocks',
    ])
    const legacyDistillationMetrics = result.fixtures
      .filter(item => item.type === 'session_digest' && !distillationIds.has(item.id))
      .flatMap(item => item.metrics.filter(metric => distillationMetricIds.has(metric.id)))
    assert.deepEqual(legacyDistillationMetrics, [])
    for (const id of distillationIds) {
      assert.ok(result.fixtures.some(item => item.id === id), `missing executable fixture: ${id}`)
    }
    const shortDecision = result.fixtures.find(item => item.id === 'short-critical-decision')
    if (shortDecision?.status === 'fail') {
      assert.ok(shortDecision.failures.some(failure => /expected session capture|critical atom missed|atom section mismatch|weighted atom recall|section accuracy|anti-verbatim/i.test(failure)))
    }
    const noLearning = result.fixtures.find(item => item.id === 'long-debug-no-learning')
    if (noLearning?.status === 'fail') {
      assert.ok(noLearning.failures.some(failure => /unexpected session capture/i.test(failure)))
    }
    const verbatimTrap = result.fixtures.find(item => item.id === 'verbatim-copy-trap')
    if (verbatimTrap?.status === 'fail') {
      assert.ok(verbatimTrap.failures.some(failure => /expected session capture|critical atom missed|atom section mismatch|weighted atom recall|section accuracy|anti-verbatim/i.test(failure)))
    }

    for (const failure of result.hardGateFailures) {
      const fixtureId = failure.split(':', 1)[0]
      assert.ok(distillationIds.has(fixtureId), `unexpected distillation hard gate source: ${failure}`)
    }
  })
})
