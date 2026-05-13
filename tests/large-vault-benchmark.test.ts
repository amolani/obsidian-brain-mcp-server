import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runLargeVaultBenchmark } from '../services/large-vault-benchmark.ts'

const roots: string[] = []

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('large vault benchmark', () => {
  test('creates a synthetic benchmark vault and report', async () => {
    const root = tempDir('obsidian-benchmark-')
    const outPath = join(root, 'vault')

    const result = await runLargeVaultBenchmark({ outPath, notes: 60 })

    assert.equal(result.notes, 60)
    assert.ok(result.timings.indexMs >= 0)
    assert.ok(result.timings.backgroundDryRunMs >= 0)
    assert.ok(existsSync(join(outPath, 'benchmark-report.md')))
    assert.ok(existsSync(join(outPath, 'benchmark-report.json')))
  })
})
