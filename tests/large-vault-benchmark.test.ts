import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  evaluateLargeVaultRegression,
  runLargeVaultBenchmark,
  type LargeVaultBenchmarkBaseline,
} from '../services/large-vault-benchmark.ts'
import type { DuplicateScanStats } from '../services/duplicate-analyzer.ts'
import { Vault } from '../vault.ts'

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
  test('evaluates the checked runtime rule at a 20 percent regression boundary', () => {
    const baseline: LargeVaultBenchmarkBaseline = {
      schemaVersion: 1,
      profile: 'test-profile',
      notes: 5000,
      tolerancePercent: 20,
      timings: { dashboardDryRunMs: 100 },
    }
    const timings = {
      generateMs: 0,
      indexMs: 0,
      searchMs: 0,
      duplicateScanMs: 0,
      linkSuggestionsMs: 0,
      dashboardDryRunMs: 120,
      backgroundDryRunMs: 0,
    }

    assert.equal(evaluateLargeVaultRegression(5000, timings, baseline).status, 'pass')
    assert.equal(evaluateLargeVaultRegression(5000, { ...timings, dashboardDryRunMs: 121 }, baseline).status, 'fail')
    assert.equal(evaluateLargeVaultRegression(1000, timings, baseline).status, 'not_applicable')
  })

  test('creates a synthetic benchmark vault and report', async () => {
    const root = tempDir('obsidian-benchmark-')
    const outPath = join(root, 'vault')

    const result = await runLargeVaultBenchmark({ outPath, notes: 60 })

    assert.equal(result.notes, 60)
    assert.ok(result.timings.indexMs >= 0)
    assert.ok(result.timings.duplicateScanMs >= 0)
    assert.ok(result.timings.linkSuggestionsMs >= 0)
    assert.ok(result.timings.backgroundDryRunMs >= 0)
    assert.equal(result.workload.duplicateScan.mode, 'exact')
    assert.equal(result.stability.status, 'pass')
    assert.ok(existsSync(join(outPath, 'benchmark-report.md')))
    assert.ok(existsSync(join(outPath, 'benchmark-report.json')))
    assert.match(readFileSync(join(outPath, 'benchmark-report.md'), 'utf-8'), /Deterministic Stability Gate/)

    const repeated = await runLargeVaultBenchmark({ outPath, notes: 10, force: true })
    assert.equal(repeated.notes, 10)
  })

  test('bounds duplicate work deterministically above the exact-scan threshold', async () => {
    const root = tempDir('obsidian-benchmark-bounded-')
    const outPath = join(root, 'vault')

    const result = await runLargeVaultBenchmark({ outPath, notes: 1100 })

    assert.equal(result.workload.duplicateScan.mode, 'blocked')
    assert.equal(result.workload.duplicateScan.maxCandidatesPerNote, 256)
    assert.ok(result.workload.duplicateScan.scoredPairs <= 1100 * 256)
    assert.ok(result.workload.duplicateMatches >= 1)
    assert.ok(result.workload.duplicateMatches <= 20)
    assert.ok(result.workload.linkSuggestions >= 1)
    assert.ok(result.workload.linkSuggestions <= 100)
    assert.equal(result.stability.status, 'pass')
    assert.deepEqual(result.stability.violations, [])

    const vault = new Vault(outPath)
    await vault.init()
    try {
      const stats: DuplicateScanStats = {
        mode: 'exact', notes: 0, candidatePairs: 0, scoredPairs: 0,
        oversizedBuckets: 0, maxCandidatesPerNote: null, resultLimit: null,
      }
      vault.findDuplicates(40, {
        focusPath: 'Kunden/Kunde-00/Captures/Benchmark Note 00000.md',
        maxResults: 5,
        stats,
      })
      assert.equal(stats.mode, 'exact')
      assert.ok(stats.scoredPairs <= stats.notes - 1)
    } finally {
      vault.shutdown()
    }
  })
})
