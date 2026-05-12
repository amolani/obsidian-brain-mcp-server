import { existsSync } from 'node:fs'
import type { SafeMaintenanceStep, Vault } from '../vault.ts'
import { findBrokenLinks } from './broken-link-analyzer.ts'
import { findDuplicates } from './duplicate-analyzer.ts'
import { lintFrontmatter } from './frontmatter-linter.ts'
import { listLowQualityNotes } from './note-quality.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export type BrainReviewSeverity = 'critical' | 'high' | 'medium' | 'low'
export type BrainReviewActionKind =
  | 'none'
  | 'safe_maintenance'
  | 'merge_duplicates'
  | 'apply_lifecycle'
  | 'apply_link_suggestions'
  | 'rebuild_semantic_index'
  | 'build_knowledge_index'
  | 'update_hot_cache'

export interface BrainReviewAction {
  kind: BrainReviewActionKind
  tool?: string
  args?: Record<string, unknown>
}

export interface BrainReviewItem {
  id: string
  severity: BrainReviewSeverity
  category: string
  title: string
  detail: string
  targets: string[]
  confidence: 'high' | 'medium' | 'low'
  action: BrainReviewAction
}

export interface BrainReviewOptions {
  limit?: number
  includeLow?: boolean
}

export interface BrainReviewResult {
  generatedAt: string
  total: number
  bySeverity: Record<BrainReviewSeverity, number>
  items: BrainReviewItem[]
  recommendedNextActions: string[]
}

export interface BrainApplyReviewItemOptions {
  itemId: string
  dryRun?: boolean
  force?: boolean
}

export interface BrainApplyReviewItemResult {
  dryRun: boolean
  item: BrainReviewItem
  summary: string
  result: unknown
}

function cleanId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, '_').replace(/^_+|_+$/g, '')
}

function itemId(type: string, ...parts: string[]): string {
  return [type, ...parts.map(cleanId)].join(':')
}

function bySeverity(items: BrainReviewItem[]): Record<BrainReviewSeverity, number> {
  return {
    critical: items.filter(item => item.severity === 'critical').length,
    high: items.filter(item => item.severity === 'high').length,
    medium: items.filter(item => item.severity === 'medium').length,
    low: items.filter(item => item.severity === 'low').length,
  }
}

function severityWeight(severity: BrainReviewSeverity): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[severity]
}

function sorted(items: BrainReviewItem[]): BrainReviewItem[] {
  return [...items].sort((a, b) =>
    severityWeight(b.severity) - severityWeight(a.severity)
    || a.category.localeCompare(b.category)
    || a.id.localeCompare(b.id)
  )
}

function recommendedNextActions(items: BrainReviewItem[]): string[] {
  const actions: string[] = []
  const critical = items.filter(item => item.severity === 'critical')
  const applyable = items.filter(item => item.action.kind !== 'none')
  const openQuestions = items.filter(item => item.category === 'open_question' || item.category === 'contradiction')

  if (critical.length > 0) actions.push(`${critical.length} kritische Review-Items zuerst manuell prüfen.`)
  if (applyable.length > 0) actions.push(`${applyable.length} sichere Aktion(en) können einzeln mit brain_apply_review_item als Dry-Run geprüft werden.`)
  if (openQuestions.length > 0) actions.push(`${openQuestions.length} offene Fragen/Widersprüche klären, bevor daraus dauerhafte Entscheidungen entstehen.`)
  if (items.length === 0) actions.push('Keine Review-Items gefunden. Knowledge Index und Hot Cache bei Bedarf manuell aktualisieren.')
  return actions
}

function addSafeMaintenanceItem(items: BrainReviewItem[], step: SafeMaintenanceStep, changed: number, skipped: number, title: string, detail: string): void {
  if (changed <= 0) return
  items.push({
    id: itemId('safe', step),
    severity: step === 'broken_links' ? 'high' : 'medium',
    category: 'safe_maintenance',
    title,
    detail: `${detail} (${changed} Änderung(en), ${skipped} übersprungen)`,
    targets: [],
    confidence: 'high',
    action: { kind: 'safe_maintenance', tool: 'run_safe_maintenance', args: { steps: [step] } },
  })
}

export function brainReview(vault: Vault, options: BrainReviewOptions = {}): BrainReviewResult {
  const includeLow = options.includeLow === true
  const items: BrainReviewItem[] = []

  const duplicates = findDuplicates(vault, 60)
  for (const duplicate of duplicates.slice(0, 20)) {
    if (duplicate.confidence === 'low' && !includeLow) continue
    items.push({
      id: itemId('duplicate', duplicate.noteA, duplicate.noteB),
      severity: duplicate.confidence === 'high' ? 'high' : 'medium',
      category: 'duplicate',
      title: `${duplicate.titleA} ↔ ${duplicate.titleB}`,
      detail: `Score ${duplicate.score}; ${duplicate.suggestion}; Gründe: ${duplicate.reasons.join(', ')}`,
      targets: [duplicate.noteA, duplicate.noteB],
      confidence: duplicate.confidence,
      action: duplicate.confidence === 'high'
        ? { kind: 'merge_duplicates', tool: 'merge_duplicates', args: { note_a: duplicate.noteA, note_b: duplicate.noteB } }
        : { kind: 'none' },
    })
  }

  const brokenLinks = findBrokenLinks(vault)
  const fixableLinks = brokenLinks.filter(link => link.candidates.length === 1 && link.candidates[0].confidence === 'high')
  addSafeMaintenanceItem(items, 'broken_links', fixableLinks.length, brokenLinks.length - fixableLinks.length, 'Kaputte Links reparieren', 'High-confidence Link-Reparaturen gefunden')

  const lintIssues = lintFrontmatter(vault)
  const fixableFrontmatter = lintIssues.filter(issue => issue.autoFixable)
  addSafeMaintenanceItem(items, 'frontmatter', fixableFrontmatter.length, lintIssues.length - fixableFrontmatter.length, 'Frontmatter normalisieren', 'Auto-fixbare Frontmatter-Issues gefunden')

  const linkSuggestions = vault.suggestLinksV2({ minConfidence: 0.9, maxTotal: 100 })
  const sourcesWithLinks = [...new Set(linkSuggestions.map(suggestion => suggestion.source))]
  for (const source of sourcesWithLinks.slice(0, 12)) {
    const count = linkSuggestions.filter(suggestion => suggestion.source === source).length
    items.push({
      id: itemId('link_suggestions', source),
      severity: 'medium',
      category: 'link_suggestion',
      title: `Link-Vorschläge anwenden: ${source}`,
      detail: `${count} high-confidence Link-Vorschlag/Vorschläge in dieser Note`,
      targets: [source],
      confidence: 'high',
      action: { kind: 'apply_link_suggestions', tool: 'apply_link_suggestions', args: { sources: [source], min_confidence: 0.9 } },
    })
  }

  const lifecycle = vault.suggestLifecycleUpdates({ maxResults: 100 })
  for (const suggestion of lifecycle.filter(s => s.confidence === 'high' && s.blockedBy.length === 0).slice(0, 15)) {
    items.push({
      id: itemId('lifecycle', suggestion.path, suggestion.recommendedStatus),
      severity: suggestion.action === 'archive' ? 'medium' : 'low',
      category: 'lifecycle',
      title: `${suggestion.path}: ${suggestion.currentStatus ?? '(kein status)'} → ${suggestion.recommendedStatus}`,
      detail: suggestion.reasons.join('; '),
      targets: [suggestion.path],
      confidence: suggestion.confidence,
      action: {
        kind: 'apply_lifecycle',
        tool: 'apply_lifecycle_updates',
        args: { paths: [suggestion.path], min_confidence: 'high', recommended_status: suggestion.recommendedStatus },
      },
    })
  }

  const lowQuality = listLowQualityNotes(vault, 49)
  for (const score of lowQuality.slice(0, includeLow ? 20 : 8)) {
    items.push({
      id: itemId('quality', score.path),
      severity: score.score < 30 ? 'high' : 'medium',
      category: 'quality',
      title: `${score.path} hat Qualität ${score.score}/100`,
      detail: score.issues.slice(0, 3).map(issue => `${issue.dimension}: ${issue.message}`).join('; ') || 'Niedriger Qualitätswert',
      targets: [score.path],
      confidence: 'medium',
      action: { kind: 'none', tool: 'score_note_quality', args: { path: score.path } },
    })
  }

  for (const question of vault.listOpenQuestions().slice(0, 20)) {
    items.push({
      id: itemId(question.type, question.path),
      severity: question.type === 'contradiction' ? 'critical' : 'medium',
      category: question.type === 'contradiction' ? 'contradiction' : 'open_question',
      title: question.title,
      detail: question.context.replace(/\s+/g, ' ').slice(0, 220),
      targets: [question.path],
      confidence: 'high',
      action: { kind: 'none', tool: question.type === 'contradiction' ? 'flag_contradiction' : 'flag_knowledge_gap' },
    })
  }

  const semantic = vault.semanticIndexStatus()
  if (!semantic.exists || semantic.missingNotes.length > 0 || semantic.staleNotes.length > 0 || semantic.extraNotes.length > 0) {
    items.push({
      id: itemId('semantic_index', 'rebuild'),
      severity: semantic.exists ? 'low' : 'medium',
      category: 'index',
      title: 'Semantic Index aktualisieren',
      detail: `${semantic.missingNotes.length} missing, ${semantic.staleNotes.length} stale, ${semantic.extraNotes.length} extra`,
      targets: [semantic.path],
      confidence: 'high',
      action: { kind: 'rebuild_semantic_index', tool: 'rebuild_semantic_index' },
    })
  }

  if (!existsSync(vaultJoin(vault.vaultPath, 'Knowledge/index.md'))) {
    items.push({
      id: itemId('knowledge_index', 'build'),
      severity: 'low',
      category: 'index',
      title: 'Knowledge Index anlegen',
      detail: 'Knowledge/index.md existiert noch nicht.',
      targets: ['Knowledge/index.md'],
      confidence: 'high',
      action: { kind: 'build_knowledge_index', tool: 'build_knowledge_index' },
    })
  }

  if (!existsSync(vaultJoin(vault.vaultPath, 'Knowledge/hot.md'))) {
    items.push({
      id: itemId('hot_cache', 'update'),
      severity: 'low',
      category: 'working_memory',
      title: 'Hot Cache optional aktualisieren',
      detail: 'Knowledge/hot.md existiert noch nicht. Diese Aktion bleibt manuell und wird nicht automatisch injiziert.',
      targets: ['Knowledge/hot.md'],
      confidence: 'high',
      action: { kind: 'update_hot_cache', tool: 'update_hot_cache' },
    })
  }

  const allItems = sorted(items)
  const limited = allItems.slice(0, Math.max(1, Math.min(options.limit ?? 50, 200)))
  return {
    generatedAt: new Date().toISOString(),
    total: allItems.length,
    bySeverity: bySeverity(allItems),
    items: limited,
    recommendedNextActions: recommendedNextActions(limited),
  }
}

export function brainApplyReviewItem(vault: Vault, options: BrainApplyReviewItemOptions): BrainApplyReviewItemResult {
  const dryRun = options.dryRun ?? true
  const review = brainReview(vault, { limit: 200, includeLow: true })
  const item = review.items.find(candidate => candidate.id === options.itemId)
  if (!item) throw new Error(`Review-Item nicht gefunden oder nicht mehr aktuell: ${options.itemId}`)
  if (item.action.kind === 'none') throw new Error(`Review-Item hat keine automatische Aktion: ${options.itemId}`)

  let result: unknown
  switch (item.action.kind) {
    case 'safe_maintenance':
      assertCanWriteTool('brain_apply_review_item', item.targets)
      result = vault.runSafeMaintenance({
        dryRun,
        steps: item.action.args?.steps as SafeMaintenanceStep[] | undefined,
      })
      break
    case 'merge_duplicates':
      result = vault.mergeDuplicates({
        noteA: item.action.args?.note_a as string,
        noteB: item.action.args?.note_b as string,
        dryRun,
        force: options.force === true,
      })
      break
    case 'apply_lifecycle':
      result = vault.applyLifecycleUpdates({
        dryRun,
        paths: item.action.args?.paths as string[] | undefined,
        minConfidence: 'high',
        recommendedStatus: item.action.args?.recommended_status as string | undefined,
      })
      break
    case 'apply_link_suggestions':
      result = vault.applyLinkSuggestions({
        dryRun,
        sources: item.action.args?.sources as string[] | undefined,
        minConfidence: 0.9,
      })
      break
    case 'rebuild_semantic_index':
      result = vault.rebuildSemanticIndex({ dryRun })
      break
    case 'build_knowledge_index':
      result = vault.buildKnowledgeIndex({ dryRun })
      break
    case 'update_hot_cache':
      result = vault.updateHotCache({ dryRun })
      break
    default:
      throw new Error(`Nicht unterstützte Review-Aktion: ${item.action.kind}`)
  }

  return {
    dryRun,
    item,
    summary: dryRun ? `Dry-Run für ${item.id} ausgeführt` : `Review-Item angewendet: ${item.id}`,
    result,
  }
}
