import { writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Vault, VaultStats } from '../vault.ts'
import { findDuplicates, type DuplicateMatch } from './duplicate-analyzer.ts'
import { findBrokenLinks, type BrokenLink } from './broken-link-analyzer.ts'
import { lintFrontmatter, type LintIssue } from './frontmatter-linter.ts'
import { generateMocs, type MocResult } from './moc-generator.ts'

export interface MaintenanceReport {
  datum: string
  duplicates: { total: number; high: number; medium: number; low: number }
  brokenLinks: { total: number; autoFixable: number }
  lintIssues: { total: number; error: number; warning: number; info: number; autoFixable: number }
  mocs: { existing: number; missing: number }
  staleNotes: number
  orphanNotes: number
  reportPath: string
}

export function runMaintenance(vault: Vault): MaintenanceReport {
  const datum = new Date().toISOString().split('T')[0]

  // Run all analyzers (read-only)
  const duplicates = findDuplicates(vault, 40)
  const brokenLinks = findBrokenLinks(vault)
  const lintIssues = lintFrontmatter(vault)
  const mocs = generateMocs(vault, true) // dry run
  const stats = vault.getOverview()

  const report: MaintenanceReport = {
    datum,
    duplicates: {
      total: duplicates.length,
      high: duplicates.filter(d => d.confidence === 'high').length,
      medium: duplicates.filter(d => d.confidence === 'medium').length,
      low: duplicates.filter(d => d.confidence === 'low').length,
    },
    brokenLinks: {
      total: brokenLinks.length,
      autoFixable: brokenLinks.filter(b => b.candidates.length === 1 && b.candidates[0].confidence === 'high').length,
    },
    lintIssues: {
      total: lintIssues.length,
      error: lintIssues.filter(i => i.severity === 'error').length,
      warning: lintIssues.filter(i => i.severity === 'warning').length,
      info: lintIssues.filter(i => i.severity === 'info').length,
      autoFixable: lintIssues.filter(i => i.autoFixable).length,
    },
    mocs: {
      existing: mocs.filter(m => m.action === 'updated' || m.action === 'skipped').length,
      missing: mocs.filter(m => m.action === 'created').length,
    },
    staleNotes: stats.staleNotes.length,
    orphanNotes: stats.orphanNotes.length,
    reportPath: `Maintenance/${datum}-review.md`,
  }

  // Write report as Obsidian note
  const reportContent = formatReportMd(report, { duplicates, brokenLinks, lintIssues, mocs, stats })
  const fullDir = join(vault.vaultPath, 'Maintenance')
  const fullPath = join(fullDir, `${datum}-review.md`)
  mkdirSync(fullDir, { recursive: true })
  writeFileSync(fullPath, reportContent, 'utf-8')

  // Index the new note
  const stat = statSync(fullPath)
  vault.indexNote(fullPath, stat.mtimeMs)
  vault.buildLinkIndex()

  return report
}

export function formatReportMd(report: MaintenanceReport, details: {
  duplicates: DuplicateMatch[]
  brokenLinks: BrokenLink[]
  lintIssues: LintIssue[]
  mocs: MocResult[]
  stats: VaultStats
}): string {
  const datum = report.datum
  const sections: string[] = []

  sections.push(`---
status: aktiv
tags:
  - maintenance
  - review-queue
aktualisiert: ${datum}
quelle: vault-gardener
---

# Vault-Maintenance-Report — ${datum}

> [!info] Review-Queue
> Automatisch generiert. Nichts wurde geändert — nur Vorschläge.
> Reihenfolge: 🔴 Sofort prüfen → 🟡 Bald prüfen → 🟢 Optional

## Übersicht

| Bereich | Problem | Auto-fixbar |
|---------|---------|-------------|
| Duplikate | ${report.duplicates.total} | — |
| Kaputte Links | ${report.brokenLinks.total} | ${report.brokenLinks.autoFixable} |
| Frontmatter-Issues | ${report.lintIssues.total} | ${report.lintIssues.autoFixable} |
| Fehlende MOCs | ${report.mocs.missing} | alle |
| Stale Notes (>180 Tage) | ${report.staleNotes} | — |
| Verwaiste Notes | ${report.orphanNotes} | — |`)

  // High-priority: High-confidence duplicates
  const highDups = details.duplicates.filter(d => d.confidence === 'high')
  if (highDups.length > 0) {
    sections.push(`\n## 🔴 High-Confidence Duplikate\n\n${highDups.slice(0, 10).map(d =>
      `- **${d.titleA}** ↔ **${d.titleB}** (Score ${d.score})\n  \`${d.noteA}\` vs \`${d.noteB}\`\n  → ${d.suggestion}`,
    ).join('\n\n')}`)
  }

  // High-priority: Broken links with auto-fix
  const fixableLinks = details.brokenLinks.filter(b => b.candidates.length === 1 && b.candidates[0].confidence === 'high')
  if (fixableLinks.length > 0) {
    sections.push(`\n## 🟡 Auto-fixbare kaputte Links (${fixableLinks.length})\n\n${fixableLinks.slice(0, 10).map(b =>
      `- \`${b.source}\`: [[${b.target}]] → [[${b.candidates[0].path.replace(/\.md$/, '')}]]`,
    ).join('\n')}`)
  }

  // Stale notes
  if (details.stats.staleNotes.length > 0) {
    sections.push(`\n## 🟢 Stale Notes (${details.stats.staleNotes.length})\n\nNotizen mit \`status: aktiv\`, aber >180 Tage nicht bearbeitet.\n\n${details.stats.staleNotes.slice(0, 10).map(s =>
      `- \`${s.path}\` — ${s.daysAgo} Tage`,
    ).join('\n')}`)
  }

  // Missing MOCs
  const missingMocs = details.mocs.filter(m => m.action === 'created')
  if (missingMocs.length > 0) {
    sections.push(`\n## 🟢 Fehlende MOCs (${missingMocs.length})\n\n${missingMocs.slice(0, 15).map(m =>
      `- \`${m.path}\` (${m.noteCount} Notizen)`,
    ).join('\n')}`)
  }

  // Lint issues (info)
  if (details.lintIssues.length > 0) {
    const warningsOnly = details.lintIssues.filter(i => i.severity === 'warning').slice(0, 10)
    if (warningsOnly.length > 0) {
      sections.push(`\n## 🟢 Frontmatter-Warnings (${warningsOnly.length})\n\n${warningsOnly.map(i =>
        `- \`${i.path}\` [${i.field}]: ${i.issue}`,
      ).join('\n')}`)
    }
  }

  sections.push(`\n---\n\n## Empfohlene Aktionen

1. **High-Confidence Duplikate** manuell prüfen und mergen
2. \`fix_broken_links\` laufen lassen (auto-fix für ${report.brokenLinks.autoFixable} Links)
3. \`fix_frontmatter\` laufen lassen (auto-fix für ${report.lintIssues.autoFixable} Issues)
4. \`generate_mocs\` laufen lassen um fehlende MOCs anzulegen
5. Stale Notes auf Status \`archiviert\` setzen oder aktualisieren`)

  return sections.join('\n')
}
