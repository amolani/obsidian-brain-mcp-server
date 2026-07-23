import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveClientContext } from '../services/client-resolver.ts'

describe('client resolver', () => {
  test('matches exact cwd aliases', () => {
    const result = resolveClientContext('/home/amo/Documents/code/amo/düsseldorf')
    assert.equal(result.client, 'Düsseldorf')
    assert.equal(result.confidence, 'high')
    assert.equal(result.method, 'exact_cwd')
    assert.match(result.reason, /CWD-Segment/)
  })

  test('does not treat an alias embedded in a cwd segment as exact evidence', () => {
    const result = resolveClientContext('/home/amo/Documents/code/amo/myhugproject')
    assert.equal(result.client, null)
    assert.equal(result.confidence, 'none')
    assert.equal(result.method, 'none')
  })

  test('matches content aliases when cwd is ambiguous', () => {
    const result = resolveClientContext('/tmp/session', 'Wir richten edulution in Düsseldorf ein.')
    assert.equal(result.client, 'Düsseldorf')
    assert.equal(result.method, 'exact_content')
    assert.equal(result.confidence, 'medium')
    assert.match(result.reason, /ausschließlich/)
  })

  test('abstains when content mentions multiple clients with equal evidence', () => {
    const result = resolveClientContext('/tmp/session', 'Wir vergleichen Düsseldorf mit HUG.')
    assert.equal(result.client, null)
    assert.equal(result.confidence, 'none')
    assert.equal(result.method, 'ambiguous_content')
    assert.match(result.reason, /Düsseldorf/)
    assert.match(result.reason, /HUG/)
    assert.match(result.reason, /keine automatische Zuordnung/)
  })

  test('abstains on multiple mentioned clients even when one is repeated', () => {
    const result = resolveClientContext('/tmp/session', 'Düsseldorf ist das Vorbild. Düsseldorf und HUG werden verglichen.')
    assert.equal(result.client, null)
    assert.equal(result.confidence, 'none')
    assert.equal(result.method, 'ambiguous_content')
  })

  test('does not confuse multiple aliases for the same client with multiple clients', () => {
    const result = resolveClientContext('/tmp/session', 'Düsseldorf wird auch als Duesseldorf geschrieben.')
    assert.equal(result.client, 'Düsseldorf')
    assert.equal(result.confidence, 'high')
    assert.equal(result.method, 'exact_content')
  })

  test('fuzzy matches common path typos', () => {
    const result = resolveClientContext('/home/amo/Documents/code/amo/düssledorf')
    assert.equal(result.client, 'Düsseldorf')
    assert.equal(result.method, 'fuzzy_cwd')
    assert.equal(result.candidate, 'düssledorf')
  })

  test('abstains when cwd contains exact segments for multiple clients', () => {
    const result = resolveClientContext('/srv/HUG/THG')
    assert.equal(result.client, null)
    assert.equal(result.confidence, 'none')
    assert.equal(result.method, 'ambiguous_cwd')
    assert.match(result.reason, /HUG/)
    assert.match(result.reason, /THG/)
  })
})
