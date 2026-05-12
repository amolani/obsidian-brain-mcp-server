import { existsSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { evidenceReport } from './evidence.ts'
import { vaultJoin } from './vault-paths.ts'

export interface BrainScheduleOptions {
  horizonDays?: number
}

export interface BrainScheduleItem {
  id: string
  priority: 'high' | 'medium' | 'low'
  due: string
  title: string
  reason: string
  suggestedTool: string
  args: Record<string, unknown>
}

export interface BrainScheduleResult {
  generatedAt: string
  horizonDays: number
  items: BrainScheduleItem[]
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function withinHorizon(date: unknown, horizonDays: number): boolean {
  if (typeof date !== 'string' || date.length < 10) return false
  const due = new Date(`${date.slice(0, 10)}T00:00:00Z`).getTime()
  const max = Date.now() + horizonDays * 24 * 60 * 60 * 1000
  return due <= max
}

export function proposeBrainSchedule(vault: Vault, options: BrainScheduleOptions = {}): BrainScheduleResult {
  const horizonDays = Math.max(1, Math.min(options.horizonDays ?? 30, 365))
  const items: BrainScheduleItem[] = []
  const evidence = evidenceReport(vault)

  for (const issue of evidence.issues.filter(issue => issue.issue === 'Recheck oder Ablaufdatum ist fällig').slice(0, 20)) {
    items.push({
      id: `evidence:${issue.path}`,
      priority: 'high',
      due: today(),
      title: `Evidence prüfen: ${issue.title}`,
      reason: issue.issue,
      suggestedTool: 'update_evidence',
      args: { path: issue.path, checked_at: today() },
    })
  }

  for (const note of vault.notes.values()) {
    if (withinHorizon(note.frontmatter.recheck_at, horizonDays) || withinHorizon(note.frontmatter.expires_at, horizonDays)) {
      items.push({
        id: `upcoming:${note.relativePath}`,
        priority: 'medium',
        due: String(note.frontmatter.recheck_at ?? note.frontmatter.expires_at).slice(0, 10),
        title: `Recheck geplant: ${note.title}`,
        reason: 'recheck_at/expires_at liegt im Planungsfenster',
        suggestedTool: 'update_evidence',
        args: { path: note.relativePath },
      })
    }
  }

  if (!existsSync(vaultJoin(vault.vaultPath, 'Knowledge/_brain.md'))) {
    items.push({
      id: 'dashboard:brain',
      priority: 'low',
      due: today(),
      title: 'Brain Dashboard anlegen',
      reason: 'Knowledge/_brain.md existiert noch nicht',
      suggestedTool: 'build_brain_dashboard',
      args: {},
    })
  }

  for (const question of vault.listOpenQuestions().slice(0, 10)) {
    items.push({
      id: `question:${question.path}`,
      priority: question.type === 'contradiction' ? 'high' : 'medium',
      due: today(),
      title: question.type === 'contradiction' ? `Widerspruch klären: ${question.title}` : `Wissenslücke klären: ${question.title}`,
      reason: 'offene Frage im Knowledge-Layer',
      suggestedTool: 'resolve_gap',
      args: { path: question.path },
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    horizonDays,
    items: items.sort((a, b) => a.due.localeCompare(b.due) || a.priority.localeCompare(b.priority)),
  }
}
