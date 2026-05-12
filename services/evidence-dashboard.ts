import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { evidenceReport, type EvidenceIssue } from './evidence.ts'
import { parseFrontmatter } from './note-parser.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export interface BuildEvidenceDashboardOptions {
  dryRun?: boolean
}

export interface EvidenceDashboardResult {
  dryRun: boolean
  path: string
  totalCandidates: number
  issueCount: number
  highRiskCount: number
  content: string
}

const EVIDENCE_DASHBOARD_PATH = 'Knowledge/evidence.md'

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function issueLines(issues: EvidenceIssue[]): string {
  return issues.length > 0
    ? issues.map(issue => `- **${issue.severity}** [[${issue.path}|${issue.title}]] - ${issue.issue}; ${issue.suggestion}`).join('\n')
    : '- Keine Einträge'
}

function group(issues: EvidenceIssue[], issue: string): EvidenceIssue[] {
  return issues.filter(item => item.issue === issue)
}

export function buildEvidenceDashboard(vault: Vault, options: BuildEvidenceDashboardOptions = {}): EvidenceDashboardResult {
  const dryRun = options.dryRun ?? true
  const report = evidenceReport(vault)
  const highRisk = report.issues.filter(issue => issue.severity === 'high')
  const content = `---
status: aktiv
tags:
  - evidence-dashboard
datum: ${today()}
quelle: evidence-dashboard
---

# Evidence Dashboard

## Summary

| Metric | Count |
|---|---:|
| Evidence candidates | ${report.totalCandidates} |
| Missing confidence | ${report.missingConfidence} |
| Missing source | ${report.missingSource} |
| Due rechecks | ${report.dueRechecks} |
| Contradicted | ${report.contradicted} |

## High Risk

${issueLines(highRisk.slice(0, 25))}

## Missing Confidence

${issueLines(group(report.issues, 'confidence fehlt').slice(0, 25))}

## Missing Source

${issueLines(group(report.issues, 'Quelle fehlt').slice(0, 25))}

## Due Rechecks

${issueLines(group(report.issues, 'Recheck oder Ablaufdatum ist fällig').slice(0, 25))}

## Contradictions

${issueLines(group(report.issues, 'Widerspruch referenziert').slice(0, 25))}
`

  const result: EvidenceDashboardResult = {
    dryRun,
    path: EVIDENCE_DASHBOARD_PATH,
    totalCandidates: report.totalCandidates,
    issueCount: report.issues.length,
    highRiskCount: highRisk.length,
    content,
  }

  if (!dryRun) {
    assertCanWriteTool('build_evidence_dashboard', [EVIDENCE_DASHBOARD_PATH])
    const fullPath = vaultJoin(vault.vaultPath, EVIDENCE_DASHBOARD_PATH)
    if (existsSync(fullPath)) {
      const fm = parseFrontmatter(readFileSync(fullPath, 'utf-8'))
      if (fm.quelle !== 'evidence-dashboard') throw new Error(`${EVIDENCE_DASHBOARD_PATH} existiert und ist nicht auto-generiert`)
    }
    mkdirSync(vaultJoin(vault.vaultPath, 'Knowledge'), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'build_evidence_dashboard',
      mode: 'apply',
      targets: [EVIDENCE_DASHBOARD_PATH],
      summary: `Evidence Dashboard aktualisiert (${report.issues.length} Issues)`,
      meta: { totalCandidates: report.totalCandidates, highRisk: highRisk.length },
    })
  }

  return result
}
