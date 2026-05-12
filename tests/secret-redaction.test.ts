import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../services/secret-redaction.ts'

describe('secret redaction', () => {
  test('redacts common token and password patterns', () => {
    const result = redactSecrets([
      'token=supersecretvalue12345',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      'https://user:pass@example.org/path',
    ].join('\n'))

    assert.equal(result.count, 3)
    assert.ok(result.types.includes('api_key'))
    assert.ok(!result.content.includes('supersecretvalue12345'))
    assert.ok(!result.content.includes('user:pass'))
  })
})
