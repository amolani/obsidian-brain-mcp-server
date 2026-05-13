import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { runBrainQualityHarness } from '../services/brain-quality-harness.ts'

describe('brain quality harness', () => {
  test('default golden fixtures pass hard gates', async () => {
    const result = await runBrainQualityHarness()
    assert.equal(result.status, 'pass', JSON.stringify(result.hardGateFailures.concat(result.fixtures.flatMap(fixture => fixture.failures)), null, 2))
    assert.equal(result.hardGateFailures.length, 0)
    assert.ok(result.score >= 90)
    assert.ok(result.fixtures.some(fixture => fixture.id === 'hug-late-session'))
    assert.ok(result.fixtures.some(fixture => fixture.id === 'surface-redaction'))
  })
})
