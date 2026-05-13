import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'

export interface LargeVaultBenchmarkOptions {
  outPath: string
  notes?: number
  force?: boolean
}

export interface LargeVaultBenchmarkResult {
  outPath: string
  notes: number
  files: number
  timings: {
    generateMs: number
    indexMs: number
    searchMs: number
    dashboardDryRunMs: number
    backgroundDryRunMs: number
  }
  reportPath: string
  jsonPath: string
}

function clampNotes(value: number | undefined): number {
  return Math.max(10, Math.min(value ?? 1000, 20000))
}

function ensureWritableTarget(outPath: string, force: boolean): void {
  if (!existsSync(outPath)) return
  const entries = readdirSync(outPath)
  if (entries.length > 0 && !force) {
    throw new Error(`${outPath} existiert bereits und ist nicht leer. Nutze --force fuer eine neue Benchmark-Vault.`)
  }
  if (force) rmSync(outPath, { recursive: true, force: true })
}

function write(outPath: string, relativePath: string, content: string): void {
  const fullPath = join(outPath, relativePath)
  mkdirSync(join(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')
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
    const title = `Benchmark Note ${String(i).padStart(5, '0')}`
    const tags = i % 5 === 0
      ? ['auto-capture', 'benchmark']
      : i % 5 === 1
        ? ['claim', 'benchmark']
        : i % 5 === 2
          ? ['runbook', 'benchmark']
          : ['benchmark']
    write(outPath, `${folder}/${title}.md`, `---
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

| Step | Duration ms |
|---|---:|
| Generate | ${result.timings.generateMs} |
| Index | ${result.timings.indexMs} |
| Search | ${result.timings.searchMs} |
| Brain Dashboard Dry-Run | ${result.timings.dashboardDryRunMs} |
| Background Dry-Run | ${result.timings.backgroundDryRunMs} |

This benchmark uses synthetic local Markdown only.
`
}

export async function runLargeVaultBenchmark(options: LargeVaultBenchmarkOptions): Promise<LargeVaultBenchmarkResult> {
  if (!options.outPath?.trim()) throw new Error('outPath ist erforderlich')
  const notes = clampNotes(options.notes)
  ensureWritableTarget(options.outPath, options.force === true)

  const generateStart = Date.now()
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

    const dashboardStart = Date.now()
    vault.buildBrainDashboard({ dryRun: true })
    const dashboardDryRunMs = Date.now() - dashboardStart

    const backgroundStart = Date.now()
    vault.runBackgroundBrain({
      dryRun: true,
      jobs: ['brain_metrics', 'build_brain_dashboard', 'build_knowledge_inbox', 'brain_schedule'],
    })
    const backgroundDryRunMs = Date.now() - backgroundStart

    const result: LargeVaultBenchmarkResult = {
      outPath: options.outPath,
      notes,
      files,
      timings: {
        generateMs,
        indexMs,
        searchMs,
        dashboardDryRunMs,
        backgroundDryRunMs,
      },
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
