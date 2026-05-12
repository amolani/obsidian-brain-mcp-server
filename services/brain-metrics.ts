import { existsSync, readFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { brainAutoBuildLearning } from './brain-feedback.ts'
import { evidenceReport } from './evidence.ts'
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
}

export function brainMetrics(vault: Vault): BrainMetrics {
  const evidence = evidenceReport(vault)
  const feedback = vault.brainFeedbackSummary()
  const learning = brainAutoBuildLearning(vault)
  let processedSources = 0
  let archivedSources = 0
  try {
    const path = vaultJoin(vault.vaultPath, '.brain-auto-build-manifest.json')
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { sources?: Record<string, { archivedAt?: string }> }
      const sources = Object.values(parsed.sources ?? {})
      processedSources = sources.length
      archivedSources = sources.filter(source => !!source.archivedAt).length
    }
  } catch {}
  const questions = vault.listOpenQuestions()
  return {
    notes: vault.notes.size,
    autoCaptures: [...vault.notes.values()].filter(note => note.tags.includes('auto-capture') || note.frontmatter.quelle === 'knowledge-harvester').length,
    autoPromoted: [...vault.notes.values()].filter(note => note.tags.includes('auto-promoted')).length,
    claims: [...vault.notes.values()].filter(note => note.tags.includes('claim')).length,
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
      skippedByManifest: 0,
      usefulnessScore: learning.usefulnessScore,
      learnedCategories: Object.keys(learning.categories).length,
    },
  }
}
