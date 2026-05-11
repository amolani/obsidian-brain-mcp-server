import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter } from './frontmatter-linter.ts'
import { scoreNoteQuality } from './note-quality.ts'

export type LifecycleAction = 'activate' | 'archive' | 'review'
export type LifecycleConfidence = 'high' | 'medium' | 'low'

export interface LifecycleSuggestion {
  path: string
  title: string
  action: LifecycleAction
  currentStatus: string | null
  recommendedStatus: string
  confidence: LifecycleConfidence
  reasons: string[]
  blockedBy: string[]
  daysSinceModified: number
  qualityScore: number | null
  inboundLinks: number
  outboundLinks: number
  openTodos: number
}

export interface LifecycleAnalyzeOptions {
  folder?: string
  includeGenerated?: boolean
  maxResults?: number
}

export interface LifecycleApplyOptions extends LifecycleAnalyzeOptions {
  dryRun?: boolean
  paths?: string[]
  minConfidence?: LifecycleConfidence
  recommendedStatus?: string
}

export interface LifecycleApplyResult {
  dryRun: boolean
  updated: Array<{
    path: string
    title: string
    beforeStatus: string | null
    afterStatus: string
    confidence: LifecycleConfidence
    reasons: string[]
  }>
  skipped: Array<{ path: string; reason: string }>
}

const DAY_MS = 24 * 60 * 60 * 1000
const CONFIDENCE_RANK: Record<LifecycleConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function normalizedStatus(entry: NoteEntry): string | null {
  const status = entry.frontmatter?.status
  return typeof status === 'string' && status.trim() ? status.trim().toLowerCase() : null
}

function isGenerated(entry: NoteEntry): boolean {
  const source = String(entry.frontmatter?.quelle ?? '')
  return ['moc-generator', 'vault-gardener', 'customer-dashboard'].includes(source)
}

function isSkippable(path: string, entry: NoteEntry, includeGenerated: boolean): boolean {
  if (path.startsWith('Daily/')) return true
  if (path.startsWith('Maintenance/')) return true
  if (basename(path, '.md') === '_MOC') return true
  if (!includeGenerated && isGenerated(entry)) return true
  return false
}

function daysSinceModified(entry: NoteEntry): number {
  return Math.floor((Date.now() - entry.lastModified) / DAY_MS)
}

function suggestionFor(vault: Vault, path: string, entry: NoteEntry): LifecycleSuggestion | null {
  const status = normalizedStatus(entry)
  const ageDays = daysSinceModified(entry)
  const inboundLinks = vault.linkIndex.get(path)?.size ?? 0
  const outboundLinks = entry.outgoingLinks.length
  const openTodos = entry.todos.filter(t => !t.done).length
  const quality = scoreNoteQuality(vault, path)
  const qualityScore = quality?.score ?? null

  const base = {
    path,
    title: entry.title,
    currentStatus: status,
    daysSinceModified: ageDays,
    qualityScore,
    inboundLinks,
    outboundLinks,
    openTodos,
  }

  if (path.startsWith('Archiv/') && status !== 'archiviert') {
    return {
      ...base,
      action: 'archive',
      recommendedStatus: 'archiviert',
      confidence: 'high',
      reasons: ['Note liegt bereits unter Archiv/', 'Frontmatter-Status ist nicht archiviert'],
      blockedBy: [],
    }
  }

  if (!status) {
    const usable = (qualityScore ?? 0) >= 50 || entry.tags.length > 0 || inboundLinks + outboundLinks > 0
    return {
      ...base,
      action: usable ? 'activate' : 'review',
      recommendedStatus: usable ? 'aktiv' : 'entwurf',
      confidence: usable ? 'high' : 'medium',
      reasons: usable
        ? ['status fehlt', 'Note hat genug Struktur/Kontext für aktiv']
        : ['status fehlt', 'Note wirkt noch unfertig'],
      blockedBy: [],
    }
  }

  if (status === 'aktiv' && ageDays >= 365 && openTodos === 0) {
    return {
      ...base,
      action: 'archive',
      recommendedStatus: 'archiviert',
      confidence: inboundLinks === 0 ? 'high' : 'medium',
      reasons: [
        `seit ${ageDays} Tagen nicht geändert`,
        'keine offenen TODOs',
        inboundLinks === 0 ? 'keine Backlinks' : `${inboundLinks} Backlink(s) vorhanden`,
      ],
      blockedBy: [],
    }
  }

  if (status === 'aktiv' && ageDays >= 180) {
    return {
      ...base,
      action: 'review',
      recommendedStatus: 'aktiv',
      confidence: 'low',
      reasons: [`aktive Note seit ${ageDays} Tagen nicht geändert`],
      blockedBy: openTodos > 0 ? ['open_todos'] : [],
    }
  }

  if ((status === 'planung' || status === 'entwurf') && ageDays >= 120 && openTodos === 0) {
    return {
      ...base,
      action: 'archive',
      recommendedStatus: 'archiviert',
      confidence: 'medium',
      reasons: [`${status} seit ${ageDays} Tagen nicht geändert`, 'keine offenen TODOs'],
      blockedBy: [],
    }
  }

  if (status === 'aktiv' && (qualityScore ?? 100) < 40 && inboundLinks === 0 && outboundLinks === 0) {
    return {
      ...base,
      action: 'review',
      recommendedStatus: 'entwurf',
      confidence: 'low',
      reasons: [`niedrige Qualität (${qualityScore})`, 'keine Links'],
      blockedBy: openTodos > 0 ? ['open_todos'] : [],
    }
  }

  return null
}

export function suggestLifecycleUpdates(
  vault: Vault,
  options: LifecycleAnalyzeOptions = {},
): LifecycleSuggestion[] {
  const suggestions: LifecycleSuggestion[] = []
  const folder = options.folder?.toLowerCase()

  for (const [path, entry] of vault.notes) {
    if (folder && !path.toLowerCase().startsWith(folder)) continue
    if (isSkippable(path, entry, options.includeGenerated === true)) continue
    const suggestion = suggestionFor(vault, path, entry)
    if (suggestion) suggestions.push(suggestion)
  }

  suggestions.sort((a, b) =>
    CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
    || b.daysSinceModified - a.daysSinceModified
    || a.path.localeCompare(b.path)
  )
  return suggestions.slice(0, options.maxResults ?? 100)
}

function replaceFrontmatter(raw: string, fm: Record<string, any>): string {
  const fmBlock = `---\n${buildFrontmatter(fm)}---`
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---/)
  if (match) return raw.replace(match[0], fmBlock)
  return `${fmBlock}\n\n${raw.trimStart()}`
}

export function applyLifecycleUpdates(
  vault: Vault,
  options: LifecycleApplyOptions = {},
): LifecycleApplyResult {
  const dryRun = options.dryRun ?? true
  const minConfidence = options.minConfidence ?? 'high'
  const allowedPaths = options.paths ? new Set(options.paths) : null
  const suggestions = suggestLifecycleUpdates(vault, options)
  const updated: LifecycleApplyResult['updated'] = []
  const skipped: LifecycleApplyResult['skipped'] = []

  for (const suggestion of suggestions) {
    if (allowedPaths && !allowedPaths.has(suggestion.path)) continue
    if (options.recommendedStatus && suggestion.recommendedStatus !== options.recommendedStatus) continue
    if (suggestion.currentStatus === suggestion.recommendedStatus) {
      skipped.push({ path: suggestion.path, reason: 'kein Statuswechsel erforderlich' })
      continue
    }
    if (suggestion.blockedBy.length > 0) {
      skipped.push({ path: suggestion.path, reason: `blockiert durch: ${suggestion.blockedBy.join(', ')}` })
      continue
    }
    if (CONFIDENCE_RANK[suggestion.confidence] < CONFIDENCE_RANK[minConfidence]) {
      skipped.push({ path: suggestion.path, reason: `Confidence ${suggestion.confidence} < ${minConfidence}` })
      continue
    }

    const update = {
      path: suggestion.path,
      title: suggestion.title,
      beforeStatus: suggestion.currentStatus,
      afterStatus: suggestion.recommendedStatus,
      confidence: suggestion.confidence,
      reasons: suggestion.reasons,
    }

    if (dryRun) {
      updated.push(update)
      continue
    }

    try {
      const entry = vault.notes.get(suggestion.path)
      if (!entry) {
        skipped.push({ path: suggestion.path, reason: 'Note nicht mehr im Index' })
        continue
      }
      const fm = {
        ...entry.frontmatter,
        status: suggestion.recommendedStatus,
        aktualisiert: today(),
        lifecycle_reviewed: today(),
      }
      const raw = readFileSync(entry.path, 'utf-8')
      writeFileSync(entry.path, replaceFrontmatter(raw, fm), 'utf-8')
      vault.indexNote(entry.path, statSync(entry.path).mtimeMs)
      updated.push(update)
    } catch (err) {
      skipped.push({ path: suggestion.path, reason: `Fehler: ${err}` })
    }
  }

  if (!dryRun && updated.length > 0) {
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'apply_lifecycle_updates',
      mode: 'apply',
      targets: updated.map(u => u.path),
      summary: `${updated.length} Lifecycle-Status-Update(s) angewendet`,
      meta: { updated },
    })
  }

  return { dryRun, updated, skipped }
}
