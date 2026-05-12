import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter, normalizeTag } from './frontmatter-linter.ts'
import { assertCanWriteTool } from './policy.ts'
import { sanitizePathSegment, uniqueRelativePath, vaultJoin } from './vault-paths.ts'

export type SavedKnowledgeType = 'insight' | 'decision' | 'answer'

export interface SaveKnowledgeOptions {
  type: SavedKnowledgeType
  title: string
  content: string
  context?: string
  source?: string
  tags?: string[]
  folder?: string
  confidence?: 'low' | 'medium' | 'high'
  checkedAt?: string
  recheckAt?: string
  expiresAt?: string
  confirmedBy?: string[]
  contradictedBy?: string[]
  dryRun?: boolean
}

export interface SaveKnowledgeResult {
  dryRun: boolean
  type: SavedKnowledgeType
  title: string
  path: string
  tags: string[]
  content: string
}

const TYPE_DEFAULTS: Record<SavedKnowledgeType, { folder: string; tag: string; heading: string }> = {
  insight: { folder: 'Knowledge/Insights', tag: 'insight', heading: 'Insight' },
  decision: { folder: 'Knowledge/Decisions', tag: 'decision', heading: 'Entscheidung' },
  answer: { folder: 'Knowledge/Answers', tag: 'answer', heading: 'Antwort' },
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function uniqueTags(type: SavedKnowledgeType, tags: string[] = []): string[] {
  return [...new Set([TYPE_DEFAULTS[type].tag, 'manual-save', ...tags].map(normalizeTag).filter(Boolean))]
}

function renderKnowledgeNote(options: SaveKnowledgeOptions, tags: string[]): string {
  const meta: Record<string, unknown> = {
    status: 'aktiv',
    tags,
    datum: today(),
  }
  if (options.source?.trim()) meta.quelle = options.source.trim()
  if (options.confidence) meta.confidence = options.confidence
  if (options.checkedAt) meta.checked_at = options.checkedAt
  if (options.recheckAt) meta.recheck_at = options.recheckAt
  if (options.expiresAt) meta.expires_at = options.expiresAt
  if (options.confirmedBy?.length) meta.confirmed_by = options.confirmedBy
  if (options.contradictedBy?.length) meta.contradicted_by = options.contradictedBy

  const contextBlock = options.context?.trim()
    ? `\n## Kontext\n\n${options.context.trim()}\n`
    : ''

  return `---\n${buildFrontmatter(meta)}---\n\n# ${TYPE_DEFAULTS[options.type].heading}: ${options.title.trim()}\n\n${options.content.trim()}\n${contextBlock}`
}

export function saveKnowledge(vault: Vault, options: SaveKnowledgeOptions): SaveKnowledgeResult {
  const dryRun = options.dryRun ?? true
  const title = options.title.trim()
  if (!title) throw new Error('Titel darf nicht leer sein')
  if (!options.content?.trim()) throw new Error('Content darf nicht leer sein')

  const defaults = TYPE_DEFAULTS[options.type]
  if (!defaults) throw new Error(`Unbekannter Knowledge-Typ: ${options.type}`)

  const folder = options.folder?.trim() || defaults.folder
  const path = dryRun
    ? `${folder}/${sanitizePathSegment(title)}.md`
    : uniqueRelativePath(vault.vaultPath, folder, `${sanitizePathSegment(title)}.md`)
  const tags = uniqueTags(options.type, options.tags)
  const content = renderKnowledgeNote({ ...options, title }, tags)

  if (!dryRun) {
    const tool = `save_${options.type}`
    assertCanWriteTool(tool, [path])
    const fullPath = vaultJoin(vault.vaultPath, path)
    mkdirSync(vaultJoin(vault.vaultPath, folder), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool,
      mode: 'apply',
      targets: [path],
      summary: `${defaults.heading} gespeichert: ${path}`,
      meta: { type: options.type, tags },
    })
  }

  return {
    dryRun,
    type: options.type,
    title,
    path,
    tags,
    content,
  }
}
