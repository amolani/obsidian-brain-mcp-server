import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  KNOWLEDGE_FACT_TEMPLATES,
  KNOWLEDGE_SALIENCE_MODEL,
  selectSalientKnowledge,
  type KnowledgeSalienceInput,
} from '../services/knowledge-salience.ts'

function factContaining(input: KnowledgeSalienceInput, pattern: RegExp) {
  const fact = selectSalientKnowledge(input).facts.find(item => pattern.test(item.statement))
  assert.ok(fact, `expected a fact matching ${pattern}`)
  return fact
}

function words(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}._/@:+-]+/gu) ?? []
}

function longestSharedWordRun(left: string, right: string): number {
  const a = words(left)
  const b = words(right)
  let longest = 0
  let previous = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== b[j - 1]) continue
      current[j] = previous[j - 1] + 1
      longest = Math.max(longest, current[j])
    }
    previous = current
  }
  return longest
}

describe('knowledge salience selection', () => {
  test('ranks task-relevant decisions above incidental evidence while keeping salience and evidence separate', () => {
    const input: KnowledgeSalienceInput = {
      sessionId: 'session-ranking',
      task: 'Choose a durable database for persistent audit events',
      assistantSummaries: [
        'We decided to use PostgreSQL as the durable database for persistent audit events.',
      ],
      bashEvidence: [
        { id: 'host-check', command: 'uname --kernel-release', result: '6.8.0-52-generic' },
      ],
      maxFacts: 8,
    }

    const selection = selectSalientKnowledge(input)
    const decision = selection.facts.find(fact => fact.kind === 'decision')
    const incidental = selection.facts.find(fact => fact.provenance.some(source => source.ref === 'bash_pair:host-check'))
    assert.ok(decision)
    assert.ok(incidental)
    assert.ok(decision.salienceScore > incidental.salienceScore)
    assert.ok(incidental.evidenceScore > decision.evidenceScore)
    assert.equal(decision.confidence, 'low')
    assert.equal(incidental.confidence, 'high')
    assert.notEqual(decision.salienceScore, decision.evidenceScore)
    assert.equal(selection.scoreScale, 'ordinal_0_100_not_probability')
  })

  test('uses MMR to keep one of two redundant decision formulations', () => {
    const input: KnowledgeSalienceInput = {
      sessionId: 'session-mmr',
      task: 'Select persistent storage for audit events',
      assistantSummaries: [
        { id: 'summary-a', text: 'Decision: PostgreSQL was selected to persist audit events.' },
        { id: 'summary-b', text: 'We decided to use PostgreSQL for persistent audit events.' },
        { id: 'summary-c', text: 'Open question: The backup retention period still needs investigation.' },
      ],
      maxFacts: 8,
    }

    const selection = selectSalientKnowledge(input)
    const postgresFacts = selection.facts.filter(fact => /PostgreSQL/i.test(fact.statement))
    assert.equal(postgresFacts.length, 1)
    assert.ok(selection.excluded.redundant >= 1)
    assert.ok(selection.facts.some(fact => fact.kind === 'open_question'))
  })

  test('abstracts an assistant block into short atomic typed facts instead of copying it', () => {
    const sourceSentences = [
      'Zusammenfassung: Root Cause: The worker failed because the lock file was stale.',
      'We decided to replace the process-local lock with an atomic filesystem lock.',
      'Verification: The concurrency test passed 40 consecutive runs.',
      'Result: PostgreSQL 16.4 stored tenant_id actor_id request_timestamp policy_version change_reason verification_outcome rollback_reference incident_correlation retention_class and checksum_sha256 without data loss.',
    ]
    const assistantBlock = sourceSentences.join(' ')
    const selection = selectSalientKnowledge({
      sessionId: 'session-abstraction',
      task: 'Prevent concurrent background workers',
      assistantSummaries: [assistantBlock],
      maxFacts: 8,
    })

    assert.ok(selection.facts.length >= 4)
    assert.ok(selection.facts.some(fact => fact.kind === 'cause'))
    assert.ok(selection.facts.some(fact => fact.kind === 'decision'))
    assert.ok(selection.facts.some(fact => fact.kind === 'verification'))
    for (const fact of selection.facts) {
      assert.notEqual(fact.statement, assistantBlock)
      assert.ok(fact.statement.length <= 240)
      assert.ok(sourceSentences.every(sentence => longestSharedWordRun(fact.statement, sentence) <= 12))
      assert.ok(sourceSentences.every(sentence => fact.statement !== sentence))
      assert.equal(fact.abstraction.template, KNOWLEDGE_FACT_TEMPLATES[fact.kind])
      assert.match(fact.abstraction.rendered, /^(Cause|Decision|Change|Verification|Result|Problem|Open question|Constraint): /)
    }
    const technicalFact = selection.facts.find(fact => /PostgreSQL/i.test(fact.statement))
    assert.ok(technicalFact)
    assert.match(technicalFact.statement, /16\.4/)
    assert.match(technicalFact.statement, /checksum_sha256/)
    assert.deepEqual(Object.keys(KNOWLEDGE_FACT_TEMPLATES).sort(), [
      'cause', 'change', 'constraint', 'decision', 'open_question', 'problem', 'result', 'verification',
    ])
  })

  test('carries stable refs, hashes and brief redacted excerpts for paired Bash evidence', () => {
    const input: KnowledgeSalienceInput = {
      sessionId: 'session-provenance',
      task: 'Verify that the web service recovered',
      bashEvidence: [{
        id: 'web-service-check',
        command: 'systemctl is-active linuxmuster-webui.service',
        result: 'active',
        exitCode: 0,
      }],
    }

    const first = selectSalientKnowledge(input)
    const second = selectSalientKnowledge(input)
    assert.deepEqual(second, first)
    assert.equal(first.modelVersion, KNOWLEDGE_SALIENCE_MODEL.version)
    assert.equal(first.facts.length, 1)
    const fact = first.facts[0]
    assert.match(fact.id, /^ks-[a-f0-9]{20}$/)
    assert.equal(fact.provenance[0].ref, 'bash_pair:web-service-check')
    assert.match(fact.provenance[0].hash, /^[a-f0-9]{64}$/)
    assert.match(fact.provenance[0].excerpt, /systemctl is-active linuxmuster-webui\.service/i)
    assert.match(fact.provenance[0].excerpt, /result: active/i)
    assert.ok(fact.provenance[0].excerpt.length <= 180)
    assert.equal(fact.confidence, 'high')
    assert.ok(['low', 'medium', 'high'].includes(fact.confidence))
  })

  test('excludes secret-bearing and verbose command noise but retains a safe adjacent result', () => {
    const secret = 'supersecretvalue12345'
    const selection = selectSalientKnowledge({
      sessionId: 'session-secret-filter',
      task: 'Complete and verify the migration',
      assistantSummaries: [[
        'The migration completed successfully.',
        `Password: ${secret}.`,
      ].join(' ')],
      bashEvidence: [
        {
          id: 'secret-write',
          command: `deploy --token=${secret} production`,
          result: 'deployed',
        },
        {
          id: 'verbose-scan',
          command: 'find /srv -type f | grep config | awk "{print $1}" | sort | uniq | head -100',
          result: 'hundreds of diagnostic lines',
        },
      ],
      maxFacts: 8,
    })

    const serialized = JSON.stringify(selection)
    assert.doesNotMatch(serialized, new RegExp(secret))
    assert.doesNotMatch(serialized, /secret-write|verbose-scan/)
    assert.ok(selection.facts.some(fact => /migration completed successfully/i.test(fact.statement)))
    assert.ok(selection.excluded.unsafeOrNoisy >= 3)
  })

  test('keeps paired error/fix facts atomic with shared evidence provenance', () => {
    const selection = selectSalientKnowledge({
      sessionId: 'session-error-fix',
      task: 'Restore the API worker',
      errorFixes: [{
        id: 'worker-recovery',
        error: 'Error: The API worker failed because the stale lock prevented startup.',
        fix: 'Fix: The stale lock was removed and an atomic lock was configured.',
      }],
      maxFacts: 8,
    })

    const problem = factContaining({
      sessionId: 'session-error-fix',
      task: 'Restore the API worker',
      errorFixes: [{ id: 'worker-recovery', error: 'The API worker failed at startup.', fix: 'The stale lock was removed.' }],
    }, /worker failed/i)
    assert.equal(problem.kind, 'problem')
    assert.ok(selection.facts.some(fact => fact.kind === 'cause' || fact.kind === 'problem'))
    assert.ok(selection.facts.some(fact => fact.kind === 'change'))
    assert.ok(selection.facts.every(fact => fact.provenance.every(source => source.source === 'error_fix')))
    assert.ok(selection.facts.every(fact => fact.evidenceScore <= 44))
    assert.ok(selection.facts.every(fact => fact.confidence === 'low'))
  })

  test('does not turn unreproducible read-only debug chatter into durable knowledge', () => {
    const selection = selectSalientKnowledge({
      sessionId: 'session-no-learning',
      task: 'Inspect a one-off slow local test',
      phases: [{
        userRequest: 'Der Effekt ist nicht mehr reproduzierbar. Wir ändern nichts und treffen keine Entscheidung.',
        outcome: 'Kein reproduzierbarer Befund; keine Änderung und keine belastbare Lehre.',
      }],
      bashEvidence: [
        { id: 'pwd', command: 'pwd', result: '/tmp/sandbox-debug' },
        { id: 'listing', command: 'ls -la', result: 'ordinary files only' },
        { id: 'status', command: 'git status --short', result: 'clean' },
        { id: 'grep', command: 'grep -R latency logs || true', result: 'no matches' },
      ],
    })

    assert.equal(selection.candidateCount, 0)
    assert.deepEqual(selection.facts, [])
  })

  test('keeps opposite-polarity claims in review and never transfers Bash provenance', () => {
    const selection = selectSalientKnowledge({
      sessionId: 'polarity-conflict',
      task: 'do not restart nginx service',
      assistantSummaries: ['Change: Service nginx was not restarted; result: ok.'],
      bashEvidence: [{
        id: 'restart',
        command: 'systemctl restart nginx',
        result: 'ok',
        exitCode: 0,
      }],
      minSalienceScore: 0,
    })

    const nginx = selection.facts.filter(fact => /nginx/i.test(fact.statement))
    assert.equal(nginx.length, 2)
    assert.ok(nginx.every(fact => fact.evidenceConflict && fact.evidenceScore <= 44))
    const negative = nginx.find(fact => /\bnot\b/i.test(fact.statement))
    assert.ok(negative)
    assert.ok(negative.provenance.every(item => item.source !== 'bash_pair'))
  })

  test('counts one assistant error/fix block as one low-confidence origin', () => {
    const text = 'Fehler: Die Firewall blockierte Port 443. Fix: Port 443 wurde freigegeben und der Dienst ist erreichbar.'
    const selection = selectSalientKnowledge({
      sessionId: 'duplicate-origin',
      task: 'Dienst wieder erreichbar machen',
      assistantSummaries: [text],
      errorFixes: [text],
      minSalienceScore: 0,
    })

    assert.ok(selection.facts.length > 0)
    assert.ok(selection.facts.every(fact => fact.evidenceScore <= 44))
    assert.ok(selection.facts.every(fact => fact.confidence === 'low'))
  })

  test('does not treat masked or negative test output as verification', () => {
    const selection = selectSalientKnowledge({
      sessionId: 'masked-test-failure',
      task: 'verify the test suite',
      bashEvidence: [{
        id: 'tests',
        command: 'npm test || true',
        result: '0 tests passed; 1 test did not pass',
        exitCode: 0,
      }],
      minSalienceScore: 0,
    })

    assert.ok(selection.facts.some(fact => fact.kind === 'problem'))
    assert.ok(!selection.facts.some(fact => fact.kind === 'verification'))
  })

  test('retains silent successful mutations as changes without inventing verification', () => {
    const selection = selectSalientKnowledge({
      sessionId: 'silent-mutation',
      task: 'update the service configuration',
      bashEvidence: [{
        id: 'sed-change',
        command: "sed -i 's/old/new/' /etc/example.conf",
        result: '',
        exitCode: 0,
      }],
      minSalienceScore: 0,
    })

    assert.ok(selection.facts.some(fact => fact.kind === 'change'))
    assert.ok(!selection.facts.some(fact => fact.kind === 'verification'))
  })

  test('classifies an explicitly open decision as an open question', () => {
    const selection = selectSalientKnowledge({
      sessionId: 'open-decision',
      task: 'Klärt die Datenbankentscheidung',
      assistantSummaries: ['Die Entscheidung zur Datenbank ist noch offen.'],
      minSalienceScore: 0,
    })

    assert.equal(selection.facts[0]?.kind, 'open_question')
  })

  test('preserves directional relation words in decision abstractions', () => {
    const selection = selectSalientKnowledge({
      sessionId: 'directional-decision',
      task: 'Datenbank auswählen',
      assistantSummaries: ['Wir haben uns gegen PostgreSQL und für SQLite entschieden.'],
      minSalienceScore: 0,
    })

    const decision = selection.facts.find(fact => fact.kind === 'decision')
    assert.ok(decision)
    assert.match(decision.statement, /gegen PostgreSQL/i)
    assert.match(decision.statement, /für SQLite/i)
  })

  test('keeps complementary semantic roles that share one technical subject', () => {
    const selection = selectSalientKnowledge({
      sessionId: 'typed-complements',
      task: 'Repair and verify the Ajenti bind configuration',
      assistantSummaries: [
        'Root Cause: bind.mode was unix while bind.socket was missing.',
        'Change: bind.mode was changed from unix to tcp.',
        'Verification: Ajenti is active and listening on port 443.',
      ],
      maxFacts: 3,
      minSalienceScore: 0,
    })

    assert.deepEqual(new Set(selection.facts.map(fact => fact.kind)), new Set(['cause', 'change', 'verification']))
  })

  test('covers each explicitly requested fact kind before selecting duplicates', () => {
    const selection = selectSalientKnowledge({
      sessionId: 'explicit-kind-coverage',
      task: 'Record only the decision, change and verification',
      assistantSummaries: [
        'Decision: use the replica cutover instead of the direct cutover.',
        'Change: MIGRATION_MODE was changed to replica.',
        'Verification: read and write checks passed.',
        'Verification: rollback check passed.',
      ],
      allowedKinds: ['decision', 'change', 'verification'],
      maxFacts: 3,
      minSalienceScore: 0,
    })

    assert.deepEqual(new Set(selection.facts.map(fact => fact.kind)), new Set(['decision', 'change', 'verification']))
  })
})
