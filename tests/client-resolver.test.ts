import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveClientContext } from '../services/client-resolver.ts'

describe('client resolver', () => {
  test('matches exact cwd aliases', () => {
    const result = resolveClientContext('/home/amo/Documents/code/amo/düsseldorf')
    assert.equal(result.client, 'Düsseldorf')
    assert.equal(result.confidence, 'high')
    assert.equal(result.method, 'exact_cwd')
  })

  test('matches content aliases when cwd is ambiguous', () => {
    const result = resolveClientContext('/tmp/session', 'Wir richten edulution in Düsseldorf ein.')
    assert.equal(result.client, 'Düsseldorf')
    assert.equal(result.method, 'exact_content')
  })

  test('fuzzy matches common path typos', () => {
    const result = resolveClientContext('/home/amo/Documents/code/amo/düssledorf')
    assert.equal(result.client, 'Düsseldorf')
    assert.equal(result.method, 'fuzzy_cwd')
    assert.equal(result.candidate, 'düssledorf')
  })
})
