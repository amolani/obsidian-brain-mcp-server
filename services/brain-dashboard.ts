import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { evidenceReport } from './evidence.ts'
import { assertGeneratedSurfaceOwnership } from './generated-surface-ownership.ts'
import { isActiveNote, isAutoCaptureNote } from './note-scope.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export interface BuildBrainDashboardOptions {
  dryRun?: boolean
  adoptLegacyOwnership?: boolean
}

export interface BrainDashboardResult {
  dryRun: boolean
  path: string
  reviewCount: number
  openQuestionCount: number
  evidenceIssueCount: number
  researchPlanCount: number
  content: string
}

const DASHBOARD_PATH = 'Knowledge/_brain.md'

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function noteLinks(paths: string[]): string {
  return paths.length > 0
    ? paths.map(path => `- [[${path}|${path.replace(/\.md$/, '')}]]`).join('\n')
    : '- Keine Einträge'
}

export function buildBrainDashboard(vault: Vault, options: BuildBrainDashboardOptions = {}): BrainDashboardResult {
  const dryRun = options.dryRun ?? true
  const review = vault.brainReview({ limit: 30 })
  const questions = vault.listOpenQuestions()
  const evidence = evidenceReport(vault)
  const researchPlans = [...vault.notes.keys()].filter(path => path.startsWith('Knowledge/Research/'))
  const recentCaptures = [...vault.notes.values()]
    .filter(isActiveNote)
    .filter(isAutoCaptureNote)
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 10)
    .map(note => note.relativePath)
  const reviewLines = review.items.slice(0, 20).map(item =>
    `- **${item.severity}** \`${item.id}\` - ${item.title} (${item.action.kind})`,
  ).join('\n') || '- Keine Review-Items'
  const questionLines = questions.slice(0, 15).map(item => `- [${item.type}] [[${item.path}|${item.title}]]`).join('\n') || '- Keine offenen Fragen'
  const evidenceLines = evidence.issues.slice(0, 15).map(issue => `- **${issue.severity}** [[${issue.path}|${issue.title}]] - ${issue.issue}`).join('\n') || '- Keine Evidence-Issues'

  const content = `---\nstatus: aktiv\ntags:\n  - brain-dashboard\naktualisiert: ${today()}\nquelle: brain-dashboard\n---\n\n# Brain Dashboard\n\n## Operating Review\n\n${reviewLines}\n\n## Offene Fragen und Widersprüche\n\n${questionLines}\n\n## Evidence / Confidence\n\n${evidenceLines}\n\n## Research-Pläne\n\n${noteLinks(researchPlans)}\n\n## Letzte Auto-Captures\n\n${noteLinks(recentCaptures)}\n\n## Manuelle Arbeitsflächen\n\n- [[Knowledge/hot|Hot Cache]]\n- [[Knowledge/index|Knowledge Index]]\n- [[Knowledge/evidence|Evidence Dashboard]]\n- [[Maintenance/Capture Review|Capture Review]]\n`

  if (!dryRun) {
    assertCanWriteTool('build_brain_dashboard', [DASHBOARD_PATH])
    assertGeneratedSurfaceOwnership(vault.vaultPath, DASHBOARD_PATH, 'brain-dashboard', {
      allowRecognizedLegacy: options.adoptLegacyOwnership === true,
    })
    const fullPath = vaultJoin(vault.vaultPath, DASHBOARD_PATH)
    mkdirSync(vaultJoin(vault.vaultPath, 'Knowledge'), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'build_brain_dashboard',
      mode: 'apply',
      targets: [DASHBOARD_PATH],
      summary: `Brain Dashboard aktualisiert (${review.total} Review-Items)`,
      meta: { reviewCount: review.total, evidenceIssues: evidence.issues.length },
    })
  }

  return {
    dryRun,
    path: DASHBOARD_PATH,
    reviewCount: review.total,
    openQuestionCount: questions.length,
    evidenceIssueCount: evidence.issues.length,
    researchPlanCount: researchPlans.length,
    content,
  }
}
