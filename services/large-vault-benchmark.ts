import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Vault } from '../vault.ts'
import {
  DUPLICATE_MAX_CANDIDATES_PER_NOTE,
  type DuplicateScanStats,
} from './duplicate-analyzer.ts'
import { markGeneratedOutput, prepareGeneratedOutputTarget } from './generated-output-target.ts'

export interface LargeVaultBenchmarkOptions {
  outPath: string
  notes?: number
  force?: boolean
  baselinePath?: string
  runs?: number
}

export interface LargeVaultBenchmarkBaseline {
  schemaVersion: 1
  profile: string
  notes: number
  tolerancePercent: number
  timings: Partial<Record<keyof LargeVaultBenchmarkResult['timings'], number>>
}

export interface LargeVaultRegressionResult {
  status: 'pass' | 'fail' | 'not_applicable'
  profile: string
  tolerancePercent: number
  comparisons: Array<{
    metric: keyof LargeVaultBenchmarkResult['timings']
    baselineMs: number
    actualMs: number
    regressionPercent: number
    status: 'pass' | 'fail'
  }>
  reason?: string
}

export interface LargeVaultBenchmarkResult {
  outPath: string
  notes: number
  files: number
  measurementRuns: number
  timings: {
    generateMs: number
    indexMs: number
    searchMs: number
    duplicateScanMs: number
    linkSuggestionsMs: number
    dashboardDryRunMs: number
    backgroundDryRunMs: number
  }
  workload: {
    duplicateMatches: number
    linkSuggestions: number
    duplicateScan: DuplicateScanStats
  }
  stability: {
    status: 'pass' | 'fail'
    maxDuplicatePairs: number
    violations: string[]
  }
  regression: LargeVaultRegressionResult
  reportPath: string
  jsonPath: string
}

const DEFAULT_BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmarks', 'large-vault-baseline.json')

function clampNotes(value: number | undefined): number {
  return Math.max(10, Math.min(value ?? 1000, 20000))
}

function clampRuns(value: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(value ?? 1), 7))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function write(outPath: string, relativePath: string, content: string): void {
  const fullPath = join(outPath, relativePath)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
}

function duplicatePairLimit(stats: DuplicateScanStats): number {
  return stats.mode === 'blocked'
    ? stats.notes * DUPLICATE_MAX_CANDIDATES_PER_NOTE
    : stats.notes * Math.max(0, stats.notes - 1) / 2
}

function loadBaseline(path: string): LargeVaultBenchmarkBaseline {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LargeVaultBenchmarkBaseline>
  if (parsed.schemaVersion !== 1 || typeof parsed.profile !== 'string' || !Number.isFinite(parsed.notes)
    || !Number.isFinite(parsed.tolerancePercent) || !parsed.timings || typeof parsed.timings !== 'object') {
    throw new Error(`Ungültige Benchmark-Baseline: ${path}`)
  }
  return parsed as LargeVaultBenchmarkBaseline
}

export function evaluateLargeVaultRegression(
  notes: number,
  timings: LargeVaultBenchmarkResult['timings'],
  baseline: LargeVaultBenchmarkBaseline,
): LargeVaultRegressionResult {
  if (notes !== baseline.notes) {
    return {
      status: 'not_applicable',
      profile: baseline.profile,
      tolerancePercent: baseline.tolerancePercent,
      comparisons: [],
      reason: `Baseline gilt für ${baseline.notes} Notes, Benchmark enthält ${notes}.`,
    }
  }

  const comparisons: LargeVaultRegressionResult['comparisons'] = []
  for (const [rawMetric, rawBaseline] of Object.entries(baseline.timings)) {
    const metric = rawMetric as keyof LargeVaultBenchmarkResult['timings']
    const baselineMs = Number(rawBaseline)
    if (!Number.isFinite(baselineMs) || baselineMs <= 0) continue
    const actualMs = timings[metric]
    const regressionPercent = Number((((actualMs - baselineMs) / baselineMs) * 100).toFixed(1))
    comparisons.push({
      metric,
      baselineMs,
      actualMs,
      regressionPercent,
      status: regressionPercent <= baseline.tolerancePercent ? 'pass' : 'fail',
    })
  }
  return {
    status: comparisons.some(item => item.status === 'fail') ? 'fail' : 'pass',
    profile: baseline.profile,
    tolerancePercent: baseline.tolerancePercent,
    comparisons,
  }
}

function generateVault(outPath: string, notes: number): number {
  mkdirSync(outPath, { recursive: true })
  write(outPath, '.brain-auto-build-manifest.json', '{"version":1,"sources":{}}\n')
  write(outPath, '.action-log.jsonl', '')

  for (let i = 0; i < notes; i++) {
    const client = `Kunde-${String(i % 25).padStart(2, '0')}`
    const folder = i % 5 === 0
      ? `Kunden/${client}/Captures`
      : i % 5 === 1
        ? 'Knowledge/Claims'
        : i % 5 === 2
          ? 'Knowledge/Runbooks'
          : i % 5 === 3
            ? 'Technik/Netzwerk'
            : 'Referenz'
    const fileTitle = `Benchmark Note ${String(i).padStart(5, '0')}`
    // Keep one known duplicate pair so the blocked scan proves recall as well
    // as bounded work on every large synthetic vault.
    const title = i === 1 ? 'Benchmark Note 00000' : fileTitle
    const previousTitle = i > 0 ? `Benchmark Note ${String(i - 1).padStart(5, '0')}` : null
    const tags = i % 5 === 0
      ? ['auto-capture', 'benchmark']
      : i % 5 === 1
        ? ['claim', 'benchmark']
        : i % 5 === 2
          ? ['runbook', 'benchmark']
          : ['benchmark']
    write(outPath, `${folder}/${fileTitle}.md`, `---
status: aktiv
tags:
${tags.map(tag => `  - ${tag}`).join('\n')}
datum: 2026-05-12
quelle: benchmark
kunde: ${client}
confidence: medium
source_stage: stop_capture
session_intent: implementation
runbook_readiness: ${i % 5 === 0 ? 70 : 20}
---

# ${title}

Synthetic benchmark note ${i} for ${client}.
${previousTitle ? `Related reference: ${previousTitle}.` : ''}

## Kontext

- Netzwerk, Firewall, DHCP, DNS und Monitoring.
- Diese Datei ist synthetisch und enthaelt keine privaten Vault-Daten.

## Durchgeführte Befehle

1. \`systemctl status service-${i % 10}\`
2. \`journalctl -u service-${i % 10} -n 50\`
${i % 5 === 0 ? '3. `systemctl restart service-benchmark`\n' : ''}
`)
  }
  return notes + 2
}

function formatReport(result: LargeVaultBenchmarkResult): string {
  return `# Large Vault Benchmark

- Vault: \`${result.outPath}\`
- Notes: ${result.notes}
- Files: ${result.files}
- Measurement runs: ${result.measurementRuns} (median)

| Step | Duration ms |
|---|---:|
| Generate | ${result.timings.generateMs} |
| Index | ${result.timings.indexMs} |
| Search | ${result.timings.searchMs} |
| Duplicate Scan | ${result.timings.duplicateScanMs} |
| Link Suggestions | ${result.timings.linkSuggestionsMs} |
| Brain Dashboard Dry-Run | ${result.timings.dashboardDryRunMs} |
| Background Dry-Run | ${result.timings.backgroundDryRunMs} |

## Deterministic Stability Gate

- Status: **${result.stability.status}**
- Duplicate scan mode: \`${result.workload.duplicateScan.mode}\`
- Duplicate pairs scored: ${result.workload.duplicateScan.scoredPairs} / ${result.stability.maxDuplicatePairs}
- Duplicate results retained: ${result.workload.duplicateMatches}
- Link suggestions retained: ${result.workload.linkSuggestions}
${result.stability.violations.length > 0 ? result.stability.violations.map(value => `- Violation: ${value}`).join('\n') : '- Violations: none'}

## Runtime Baseline

- Profile: \`${result.regression.profile}\`
- Status: **${result.regression.status}**
- Tolerance: ${result.regression.tolerancePercent}%
${result.regression.comparisons.length > 0
  ? result.regression.comparisons.map(item => `- ${item.metric}: ${item.actualMs} ms vs ${item.baselineMs} ms (${item.regressionPercent >= 0 ? '+' : ''}${item.regressionPercent}%, ${item.status})`).join('\n')
  : `- ${result.regression.reason ?? 'No comparable timings.'}`}

This benchmark uses synthetic local Markdown only.
`
}

export async function runLargeVaultBenchmark(options: LargeVaultBenchmarkOptions): Promise<LargeVaultBenchmarkResult> {
  if (!options.outPath?.trim()) throw new Error('outPath ist erforderlich')
  const notes = clampNotes(options.notes)
  const measurementRuns = clampRuns(options.runs)
  prepareGeneratedOutputTarget(options.outPath, options.force === true, 'large-vault-benchmark')

  const generateStart = Date.now()
  mkdirSync(options.outPath, { recursive: true })
  markGeneratedOutput(options.outPath, 'large-vault-benchmark')
  const files = generateVault(options.outPath, notes)
  const generateMs = Date.now() - generateStart

  const indexStart = Date.now()
  const vault = new Vault(options.outPath)
  await vault.init()
  const indexMs = Date.now() - indexStart

  try {
    const searchStart = Date.now()
    vault.search({ query: 'Firewall DHCP Monitoring' })
    const searchMs = Date.now() - searchStart

    const samples = {
      duplicateScanMs: [] as number[],
      linkSuggestionsMs: [] as number[],
      dashboardDryRunMs: [] as number[],
      backgroundDryRunMs: [] as number[],
    }
    let duplicateStats: DuplicateScanStats = {
      mode: 'exact', notes: 0, candidatePairs: 0, scoredPairs: 0,
      oversizedBuckets: 0, maxCandidatesPerNote: null, resultLimit: null,
    }
    let duplicates: ReturnType<Vault['findDuplicates']> = []
    let linkSuggestions: ReturnType<Vault['suggestLinksV2']> = []
    for (let run = 0; run < measurementRuns; run++) {
      duplicateStats = {
        mode: 'exact', notes: 0, candidatePairs: 0, scoredPairs: 0,
        oversizedBuckets: 0, maxCandidatesPerNote: null, resultLimit: null,
      }
      const duplicateStart = Date.now()
      duplicates = vault.findDuplicates(60, { maxResults: 20, stats: duplicateStats })
      samples.duplicateScanMs.push(Date.now() - duplicateStart)

      const linkSuggestionsStart = Date.now()
      linkSuggestions = vault.suggestLinksV2({ minConfidence: 0.8, maxPerNote: 5, maxTotal: 100 })
      samples.linkSuggestionsMs.push(Date.now() - linkSuggestionsStart)

      const dashboardStart = Date.now()
      vault.buildBrainDashboard({ dryRun: true })
      samples.dashboardDryRunMs.push(Date.now() - dashboardStart)

      const backgroundStart = Date.now()
      vault.runBackgroundBrain({
        dryRun: true,
        jobs: ['brain_metrics', 'build_brain_dashboard', 'build_knowledge_inbox', 'brain_schedule'],
        // Benchmark service work, not child-process startup/isolation overhead.
        isolateJobs: false,
      })
      samples.backgroundDryRunMs.push(Date.now() - backgroundStart)
    }
    const duplicateScanMs = median(samples.duplicateScanMs)
    const linkSuggestionsMs = median(samples.linkSuggestionsMs)
    const dashboardDryRunMs = median(samples.dashboardDryRunMs)
    const backgroundDryRunMs = median(samples.backgroundDryRunMs)
    const maxDuplicatePairs = duplicatePairLimit(duplicateStats)
    const violations: string[] = []
    if (duplicateStats.scoredPairs > maxDuplicatePairs) {
      violations.push(`duplicate scored pairs ${duplicateStats.scoredPairs} exceed ${maxDuplicatePairs}`)
    }
    if (duplicates.length > 20) violations.push(`duplicate result limit exceeded: ${duplicates.length}`)
    if (linkSuggestions.length > 100) violations.push(`link suggestion result limit exceeded: ${linkSuggestions.length}`)

    const timings = {
      generateMs,
      indexMs,
      searchMs,
      duplicateScanMs,
      linkSuggestionsMs,
      dashboardDryRunMs,
      backgroundDryRunMs,
    }
    const baselinePath = options.baselinePath ?? DEFAULT_BASELINE_PATH
    const regression = existsSync(baselinePath)
      ? evaluateLargeVaultRegression(notes, timings, loadBaseline(baselinePath))
      : {
          status: 'not_applicable' as const,
          profile: 'none',
          tolerancePercent: 20,
          comparisons: [],
          reason: `Keine Baseline gefunden: ${baselinePath}`,
        }
    const result: LargeVaultBenchmarkResult = {
      outPath: options.outPath,
      notes,
      files,
      measurementRuns,
      timings,
      workload: {
        duplicateMatches: duplicates.length,
        linkSuggestions: linkSuggestions.length,
        duplicateScan: duplicateStats,
      },
      stability: {
        status: violations.length === 0 ? 'pass' : 'fail',
        maxDuplicatePairs,
        violations,
      },
      regression,
      reportPath: 'benchmark-report.md',
      jsonPath: 'benchmark-report.json',
    }

    write(options.outPath, result.reportPath, formatReport(result))
    write(options.outPath, result.jsonPath, `${JSON.stringify(result, null, 2)}\n`)
    return result
  } finally {
    vault.shutdown()
  }
}
