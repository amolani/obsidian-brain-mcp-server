import { existsSync, readFileSync, statSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { brainAutoBuildLearning } from './brain-feedback.ts'
import { evidenceReport } from './evidence.ts'
import { buildKnowledgeInboxItems } from './knowledge-inbox-actions.ts'
import { isActiveNote, isAutoCaptureNote } from './note-scope.ts'
import { vaultJoin } from './vault-paths.ts'

export interface BrainMetrics {
  notes: number
  autoCaptures: number
  autoPromoted: number
  claims: number
  evidenceCandidates: number
  evidenceIssues: number
  openQuestions: number
  contradictions: number
  feedback: { accepted: number; rejected: number; snoozed: number }
  autoBuild: { processedSources: number; archivedSources: number; skippedByManifest: number; usefulnessScore: number; learnedCategories: number }
  operations: {
    lastBackgroundRunAt: string | null
    newCapturesSinceLastRun: number
    provisionalClaims: number
    staleEvidence: number
    uncertainClientMatches: number
    runbookCandidates: number
    noisyAutoBuildRuns: number
    reviewBacklogOpen: number
    reviewBacklogOldestDays: number
    generatedSurfacesMissing: string[]
    generatedSurfacesStale: string[]
    actionLogWrites: number
    previousFailedJobs: number
  }
}

const GENERATED_SURFACES = [
  'Knowledge/_brain.md',
  'Knowledge/index.md',
  'Knowledge/hot.md',
  'Knowledge/evidence.md',
  'Maintenance/Capture Review.md',
  'Maintenance/Knowledge Inbox.md',
  'Maintenance/Change Ledger.md',
  'Maintenance/Background Run Report.md',
]

function readJson(vault: Vault, path: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(vaultJoin(vault.vaultPath, path), 'utf-8')) as Record<string, any>
  } catch {
    return {}
  }
}

function actionLogWrites(vault: Vault): number {
  try {
    const text = readFileSync(vaultJoin(vault.vaultPath, '.action-log.jsonl'), 'utf-8').trim()
    return text ? text.split('\n').length : 0
  } catch {
    return 0
  }
}

export function brainMetrics(vault: Vault): BrainMetrics {
  const evidence = evidenceReport(vault)
  const feedback = vault.brainFeedbackSummary()
  const learning = brainAutoBuildLearning(vault)
  let processedSources = 0
  let archivedSources = 0
  let skippedByManifest = 0
  let noisyAutoBuildRuns = 0
  try {
    const path = vaultJoin(vault.vaultPath, '.brain-auto-build-manifest.json')
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as {
        sources?: Record<string, { archivedAt?: string; steps?: Array<{ skipped?: boolean }> }>
      }
      const sources = Object.values(parsed.sources ?? {})
      processedSources = sources.length
      archivedSources = sources.filter(source => !!source.archivedAt).length
      skippedByManifest = sources.reduce((sum, source) => sum + (source.steps?.filter(step => step.skipped).length ?? 0), 0)
      noisyAutoBuildRuns = sources.filter(source => (source.steps?.filter(step => step.skipped).length ?? 0) >= 3).length
    }
  } catch {}
  const questions = vault.listOpenQuestions()
  const activeNotes = [...vault.notes.values()].filter(isActiveNote)
  const captures = activeNotes.filter(isAutoCaptureNote)
  const inboxItems = buildKnowledgeInboxItems(vault)
  const lastRun = readJson(vault, '.brain-background-last-run.json')
  const lastBackgroundRunAt = typeof lastRun.generatedAt === 'string' ? lastRun.generatedAt : null
  const lastRunMs = lastBackgroundRunAt ? Date.parse(lastBackgroundRunAt) : Number.NaN
  const backlogDates = inboxItems
    .map(item => vault.notes.get(item.target)?.lastModified)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const generatedSurfacesMissing: string[] = []
  const generatedSurfacesStale: string[] = []
  for (const path of GENERATED_SURFACES) {
    const fullPath = vaultJoin(vault.vaultPath, path)
    if (!existsSync(fullPath)) {
      generatedSurfacesMissing.push(path)
    } else if (Date.now() - statSync(fullPath).mtimeMs > 7 * 86_400_000) {
      generatedSurfacesStale.push(path)
    }
  }
  return {
    notes: vault.notes.size,
    autoCaptures: captures.length,
    autoPromoted: activeNotes.filter(note => note.tags.includes('auto-promoted')).length,
    claims: activeNotes.filter(note => note.tags.includes('claim')).length,
    evidenceCandidates: evidence.totalCandidates,
    evidenceIssues: evidence.issues.length,
    openQuestions: questions.filter(q => q.type === 'gap').length,
    contradictions: questions.filter(q => q.type === 'contradiction').length,
    feedback: {
      accepted: feedback.accepted,
      rejected: feedback.rejected,
      snoozed: feedback.snoozed,
    },
    autoBuild: {
      processedSources,
      archivedSources,
      skippedByManifest,
      usefulnessScore: learning.usefulnessScore,
      learnedCategories: Object.keys(learning.categories).length,
    },
    operations: {
      lastBackgroundRunAt,
      newCapturesSinceLastRun: Number.isFinite(lastRunMs) ? captures.filter(note => note.lastModified > lastRunMs).length : captures.length,
      provisionalClaims: activeNotes.filter(note => note.tags.includes('claim') && note.frontmatter.claim_status === 'provisional').length,
      staleEvidence: evidence.issues.filter(issue => issue.issue === 'Recheck oder Ablaufdatum ist fällig').length,
      uncertainClientMatches: inboxItems.filter(item => item.kind === 'review_client_alias').length,
      runbookCandidates: inboxItems.filter(item => item.kind === 'runbook_preview').length,
      noisyAutoBuildRuns,
      reviewBacklogOpen: inboxItems.length,
      reviewBacklogOldestDays: backlogDates.length > 0 ? Math.max(0, Math.floor((Date.now() - Math.min(...backlogDates)) / 86_400_000)) : 0,
      generatedSurfacesMissing,
      generatedSurfacesStale,
      actionLogWrites: actionLogWrites(vault),
      previousFailedJobs: Array.isArray(lastRun.jobs) ? lastRun.jobs.filter((job: any) => job?.status === 'fail').length : 0,
    },
  }
}
