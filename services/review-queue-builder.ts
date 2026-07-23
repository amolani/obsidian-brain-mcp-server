import { writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Vault, VaultStats } from '../vault.ts'
import { findDuplicates, type DuplicateMatch } from './duplicate-analyzer.ts'
import { findBrokenLinks, type BrokenLink } from './broken-link-analyzer.ts'
import { lintFrontmatter, type LintIssue } from './frontmatter-linter.ts'
import { generateMocs, type MocResult } from './moc-generator.ts'
import { appendActionLog } from './action-log.ts'
import { assertGeneratedSurfaceOwnership } from './generated-surface-ownership.ts'
import { listLowQualityNotes, summarizeQuality, type NoteQualityScore, type QualitySummary } from './note-quality.ts'
import { suggestLifecycleUpdates, type LifecycleSuggestion } from './lifecycle-manager.ts'
import { assertCanWriteTool } from './policy.ts'
import { isReviewQueueItemOpen, readReviewQueueState, type ReviewQueueEntry } from './review-queue-actions.ts'

export interface MaintenanceReport {
  datum: string
  duplicates: { total: number; high: number; medium: number; low: number }
  brokenLinks: { total: number; autoFixable: number }
  lintIssues: { total: number; error: number; warning: number; info: number; autoFixable: number }
  mocs: { existing: number; missing: number }
  quality: QualitySummary
  lifecycle: { total: number; high: number; medium: number; low: number; autoApplicable: number }
  staleNotes: number
  orphanNotes: number
  reportPath: string
}

function reviewItemId(type: string, ...parts: string[]): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9._/-]+/g, '_').replace(/^_+|_+$/g, '')
  return [type, ...parts.map(clean)].join(':')
}

export function runMaintenance(vault: Vault): MaintenanceReport {
  const datum = new Date().toISOString().split('T')[0]

  // Run all analyzers (read-only)
  const duplicates = findDuplicates(vault, 40)
  const brokenLinks = findBrokenLinks(vault)
  const lintIssues = lintFrontmatter(vault)
  const mocs = generateMocs(vault, true) // dry run
  const stats = vault.getOverview()
  const quality = summarizeQuality(vault)
  const lowQuality = listLowQualityNotes(vault, 49)
  const lifecycle = suggestLifecycleUpdates(vault, { maxResults: 100 })

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
    quality,
    lifecycle: {
      total: lifecycle.length,
      high: lifecycle.filter(s => s.confidence === 'high').length,
      medium: lifecycle.filter(s => s.confidence === 'medium').length,
      low: lifecycle.filter(s => s.confidence === 'low').length,
      autoApplicable: lifecycle.filter(s => s.confidence === 'high' && s.blockedBy.length === 0 && s.currentStatus !== s.recommendedStatus).length,
    },
    staleNotes: stats.staleNotes.length,
    orphanNotes: stats.orphanNotes.length,
    reportPath: `Maintenance/${datum}-review.md`,
  }

  // Write report as Obsidian note
  const reportContent = formatReportMd(
    report,
    { duplicates, brokenLinks, lintIssues, mocs, stats, lowQuality, lifecycle },
    readReviewQueueState(vault),
  )
  const fullDir = join(vault.vaultPath, 'Maintenance')
  const fullPath = join(fullDir, `${datum}-review.md`)
  assertCanWriteTool('run_vault_maintenance', [report.reportPath])
  assertGeneratedSurfaceOwnership(vault.vaultPath, report.reportPath, 'vault-gardener')
  mkdirSync(fullDir, { recursive: true })
  writeFileSync(fullPath, reportContent, 'utf-8')

  // Index the new note
  const stat = statSync(fullPath)
  vault.indexNote(fullPath, stat.mtimeMs)
  vault.buildLinkIndex()

  appendActionLog(vault.vaultPath, {
    tool: 'run_vault_maintenance',
    mode: 'apply',
    targets: [report.reportPath],
    summary: `Maintenance-Report erstellt (${report.duplicates.total} Duplikate, ${report.brokenLinks.total} kaputte Links, ${report.lintIssues.total} Lint-Issues)`,
    meta: {
      duplicates: report.duplicates,
      brokenLinks: report.brokenLinks,
      lintIssues: report.lintIssues,
      mocs: report.mocs,
      quality: report.quality,
      lifecycle: report.lifecycle,
    },
  })

  return report
}

export function formatReportMd(report: MaintenanceReport, details: {
  duplicates: DuplicateMatch[]
  brokenLinks: BrokenLink[]
  lintIssues: LintIssue[]
  mocs: MocResult[]
  stats: VaultStats
  lowQuality: NoteQualityScore[]
  lifecycle: LifecycleSuggestion[]
}, reviewState: Record<string, ReviewQueueEntry> = {}): string {
  const datum = report.datum
  const sections: string[] = []
  const open = (id: string) => isReviewQueueItemOpen(reviewState, id)
  const hiddenByReviewState = Object.keys(reviewState).filter(id => !open(id)).length

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
| Niedrige Qualität (<50) | ${details.lowQuality.length} | — |
| Qualität Ø | ${report.quality.averageScore} | — |
| Lifecycle-Vorschläge | ${report.lifecycle.total} | ${report.lifecycle.autoApplicable} |
| Stale Notes (>180 Tage) | ${report.staleNotes} | — |
| Verwaiste Notes | ${report.orphanNotes} | — |`)

  if (hiddenByReviewState > 0) {
    sections.push(`\n> [!note] Review-Status\n> ${hiddenByReviewState} akzeptierte, abgelehnte oder aktuell gesnoozte Item(s) sind in diesem Report ausgeblendet.`)
  }

  // High-priority: High-confidence duplicates
  const highDups = details.duplicates.filter(d =>
    d.confidence === 'high' && open(reviewItemId('duplicate', d.noteA, d.noteB)),
  )
  if (highDups.length > 0) {
    sections.push(`\n## 🔴 High-Confidence Duplikate\n\n${highDups.slice(0, 10).map(d =>
      `- \`${reviewItemId('duplicate', d.noteA, d.noteB)}\` **${d.titleA}** ↔ **${d.titleB}** (Score ${d.score})\n  \`${d.noteA}\` vs \`${d.noteB}\`\n  → ${d.suggestion}`,
    ).join('\n\n')}`)
  }

  // High-priority: Broken links with auto-fix
  const fixableLinks = details.brokenLinks.filter(b =>
    b.candidates.length === 1
      && b.candidates[0].confidence === 'high'
      && open(reviewItemId('broken_link', b.source, b.target)),
  )
  if (fixableLinks.length > 0) {
    sections.push(`\n## 🟡 Auto-fixbare kaputte Links (${fixableLinks.length})\n\n${fixableLinks.slice(0, 10).map(b =>
      `- \`${reviewItemId('broken_link', b.source, b.target)}\` \`${b.source}\`: [[${b.target}]] → [[${b.candidates[0].path.replace(/\.md$/, '')}]]`,
    ).join('\n')}`)
  }

  // Stale notes
  const staleNotes = details.stats.staleNotes.filter(s => open(reviewItemId('stale_note', s.path)))
  if (staleNotes.length > 0) {
    sections.push(`\n## 🟢 Stale Notes (${staleNotes.length})\n\nNotizen mit \`status: aktiv\`, aber >180 Tage nicht bearbeitet.\n\n${staleNotes.slice(0, 10).map(s =>
      `- \`${reviewItemId('stale_note', s.path)}\` \`${s.path}\` — ${s.daysAgo} Tage`,
    ).join('\n')}`)
  }

  const lowQuality = details.lowQuality.filter(q => open(reviewItemId('quality', q.path)))
  if (lowQuality.length > 0) {
    sections.push(`\n## 🟡 Niedrige Notizqualität (${lowQuality.length})\n\n${lowQuality.slice(0, 10).map(q =>
      `- \`${reviewItemId('quality', q.path)}\` \`${q.path}\` — Score ${q.score} (${q.grade})\n  ${q.issues.slice(0, 2).map(i => `${i.dimension}: ${i.message}`).join('; ')}`,
    ).join('\n')}`)
  }

  const lifecycleHigh = details.lifecycle.filter(s =>
    s.confidence === 'high' && open(reviewItemId('lifecycle', s.path, s.recommendedStatus)),
  )
  if (lifecycleHigh.length > 0) {
    sections.push(`\n## 🟡 Lifecycle-Vorschläge (${lifecycleHigh.length} high)\n\n${lifecycleHigh.slice(0, 10).map(s =>
      `- \`${reviewItemId('lifecycle', s.path, s.recommendedStatus)}\` \`${s.path}\`: ${s.currentStatus ?? '(kein status)'} → ${s.recommendedStatus}\n  ${s.reasons.join('; ')}`,
    ).join('\n')}`)
  }

  // Missing MOCs
  const missingMocs = details.mocs.filter(m => m.action === 'created' && open(reviewItemId('moc', m.path)))
  if (missingMocs.length > 0) {
    sections.push(`\n## 🟢 Fehlende MOCs (${missingMocs.length})\n\n${missingMocs.slice(0, 15).map(m =>
      `- \`${reviewItemId('moc', m.path)}\` \`${m.path}\` (${m.noteCount} Notizen)`,
    ).join('\n')}`)
  }

  // Lint issues (info)
  if (details.lintIssues.length > 0) {
    const warningsOnly = details.lintIssues
      .filter(i => i.severity === 'warning' && open(reviewItemId('frontmatter', i.path, i.field)))
      .slice(0, 10)
    if (warningsOnly.length > 0) {
      sections.push(`\n## 🟢 Frontmatter-Warnings (${warningsOnly.length})\n\n${warningsOnly.map(i =>
        `- \`${reviewItemId('frontmatter', i.path, i.field)}\` \`${i.path}\` [${i.field}]: ${i.issue}`,
      ).join('\n')}`)
    }
  }

  sections.push(`\n---\n\n## Empfohlene Aktionen

1. **High-Confidence Duplikate** manuell prüfen und mergen
2. \`fix_broken_links\` laufen lassen (auto-fix für ${report.brokenLinks.autoFixable} Links)
3. \`fix_frontmatter\` laufen lassen (auto-fix für ${report.lintIssues.autoFixable} Issues)
4. \`generate_mocs\` laufen lassen um fehlende MOCs anzulegen
5. Niedrige Qualitäts-Scores mit \`score_note_quality\` prüfen
6. Lifecycle-Vorschläge mit \`suggest_lifecycle_updates\` prüfen und mit \`apply_lifecycle_updates\` als Dry-Run testen
7. Einzelne IDs mit \`accept_review_item\`, \`reject_review_item\` oder \`snooze_review_item\` nachverfolgen
8. Sichere Sammelfixes mit \`apply_all_safe_fixes\` zuerst als Dry-Run prüfen`)

  return sections.join('\n')
}
