import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures')

describe('transcript fixtures', () => {
  test('all JSONL transcript fixtures are parseable and anonymized', () => {
    const files = readdirSync(FIXTURE_DIR).filter(file => file.endsWith('.jsonl'))
    assert.ok(files.length >= 3)

    for (const file of files) {
      const content = readFileSync(join(FIXTURE_DIR, file), 'utf-8')
      const rows = content.split('\n').filter(Boolean)
      assert.ok(rows.length >= 5, `${file} should contain enough transcript rows`)
      for (const row of rows) {
        const parsed = JSON.parse(row)
        assert.ok(parsed.role || parsed.type)
      }
      assert.doesNotMatch(content, /password|token=|secret=/i)
    }
  })
})
