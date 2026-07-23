import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter } from './frontmatter-linter.ts'
import { isActiveNote } from './note-scope.ts'
import { parseFrontmatter, stripFrontmatter } from './note-parser.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export type EvidenceConfidence = 'low' | 'medium' | 'high'

export interface UpdateEvidenceOptions {
  path: string
  confidence?: EvidenceConfidence
  source?: string
  confirmedBy?: string[]
  contradictedBy?: string[]
  /** `null` preserves the current value; useful for automated extraction that is not a factual review. */
  checkedAt?: string | null
  recheckAt?: string
  expiresAt?: string
  dryRun?: boolean
}

export interface EvidenceUpdateResult {
  dryRun: boolean
  path: string
  changedFields: string[]
  content: string
}

export interface EvidenceIssue {
  path: string
  title: string
  severity: 'high' | 'medium' | 'low'
  issue: string
  suggestion: string
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function asArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  return [String(value)].filter(Boolean)
}

function resolveNote(vault: Vault, pathOrTitle: string): NoteEntry | null {
  return vault.notes.get(pathOrTitle) ?? [...vault.notes.values()].find(entry =>
    entry.title.toLowerCase() === pathOrTitle.toLowerCase()
      || entry.relativePath.toLowerCase() === pathOrTitle.toLowerCase()
  ) ?? null
}

function isEvidenceCandidate(note: NoteEntry): boolean {
  if (!isActiveNote(note)) return false
  const tags = new Set(note.tags)
  return note.relativePath.startsWith('Knowledge/')
    || ['insight', 'decision', 'answer', 'claim', 'source'].some(tag => tags.has(tag))
}

function isPast(date: unknown): boolean {
  return typeof date === 'string' && date.length > 0 && date < today()
}

export function updateEvidence(vault: Vault, options: UpdateEvidenceOptions): EvidenceUpdateResult {
  const dryRun = options.dryRun ?? true
  const note = resolveNote(vault, options.path)
  if (!note) throw new Error(`Notiz nicht gefunden: ${options.path}`)

  const raw = readFileSync(note.path, 'utf-8')
  const fm = parseFrontmatter(raw)
  const before = JSON.stringify(fm)
  if (options.confidence) fm.confidence = options.confidence
  if (options.source?.trim()) fm.quelle = options.source.trim()
  if (options.checkedAt === null) {
    // Automated processing is provenance, not a factual review.
  } else if (options.checkedAt !== undefined) fm.checked_at = options.checkedAt || today()
  else fm.checked_at = fm.checked_at ?? today()
  if (options.recheckAt !== undefined) fm.recheck_at = options.recheckAt
  if (options.expiresAt !== undefined) fm.expires_at = options.expiresAt
  if (options.confirmedBy) fm.confirmed_by = [...new Set([...asArray(fm.confirmed_by), ...options.confirmedBy])]
  if (options.contradictedBy) fm.contradicted_by = [...new Set([...asArray(fm.contradicted_by), ...options.contradictedBy])]
  const changedFields = Object.keys(fm).filter(key => JSON.stringify(parseFrontmatter(raw)[key]) !== JSON.stringify(fm[key]))
  const content = `---\n${buildFrontmatter(fm)}---\n\n${stripFrontmatter(raw).trimStart()}`

  if (!dryRun && before !== JSON.stringify(fm)) {
    assertCanWriteTool('update_evidence', [note.relativePath])
    writeFileSync(note.path, content, 'utf-8')
    vault.indexNote(note.path, statSync(note.path).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'update_evidence',
      mode: 'apply',
      targets: [note.relativePath],
      summary: `Evidence-Metadaten aktualisiert: ${note.relativePath}`,
      meta: { changedFields },
    })
  }

  return { dryRun, path: note.relativePath, changedFields, content }
}

export function listEvidenceIssues(vault: Vault): EvidenceIssue[] {
  const issues: EvidenceIssue[] = []
  for (const note of vault.notes.values()) {
    if (!isEvidenceCandidate(note)) continue
    const fm = note.frontmatter
    if (!fm.confidence) {
      issues.push({
        path: note.relativePath,
        title: note.title,
        severity: note.tags.includes('decision') || note.tags.includes('claim') ? 'high' : 'medium',
        issue: 'confidence fehlt',
        suggestion: 'Mit update_evidence confidence low/medium/high setzen.',
      })
    }
    if (!fm.quelle && !fm.source && !note.tags.includes('source')) {
      issues.push({
        path: note.relativePath,
        title: note.title,
        severity: 'medium',
        issue: 'Quelle fehlt',
        suggestion: 'Quelle oder Herkunft mit update_evidence ergänzen.',
      })
    }
    if (isPast(fm.recheck_at) || isPast(fm.expires_at)) {
      issues.push({
        path: note.relativePath,
        title: note.title,
        severity: 'high',
        issue: 'Recheck oder Ablaufdatum ist fällig',
        suggestion: 'Wissen prüfen und checked_at/recheck_at aktualisieren.',
      })
    }
    if (asArray(fm.contradicted_by).length > 0) {
      issues.push({
        path: note.relativePath,
        title: note.title,
        severity: 'high',
        issue: 'Widerspruch referenziert',
        suggestion: 'Contradiction klären oder Evidenz neu bewerten.',
      })
    }
  }
  return issues.sort((a, b) => a.path.localeCompare(b.path))
}

export function evidenceReport(vault: Vault): {
  totalCandidates: number
  missingConfidence: number
  missingSource: number
  dueRechecks: number
  contradicted: number
  issues: EvidenceIssue[]
} {
  const candidates = [...vault.notes.values()].filter(isEvidenceCandidate)
  const issues = listEvidenceIssues(vault)
  return {
    totalCandidates: candidates.length,
    missingConfidence: issues.filter(issue => issue.issue === 'confidence fehlt').length,
    missingSource: issues.filter(issue => issue.issue === 'Quelle fehlt').length,
    dueRechecks: issues.filter(issue => issue.issue === 'Recheck oder Ablaufdatum ist fällig').length,
    contradicted: issues.filter(issue => issue.issue === 'Widerspruch referenziert').length,
    issues,
  }
}

export function evidenceFileExists(vault: Vault, path: string): boolean {
  return existsSync(vaultJoin(vault.vaultPath, path))
}
