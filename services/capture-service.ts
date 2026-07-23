import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { loadClients, loadTechTerms } from '../config.ts'
import { classifyNote, type Classification } from '../technik-categories.ts'
import { appendActionLog } from './action-log.ts'
import { normalizeTag } from './frontmatter-linter.ts'
import { assertCanWriteTool } from './policy.ts'
import { uniqueRelativePath, vaultJoin, sanitizePathSegment } from './vault-paths.ts'

export type CaptureMode = 'fast' | 'strict' | 'review'

export interface CaptureV2Options {
  category?: string
  mode?: CaptureMode
  dryRun?: boolean
  logTool?: string
}

export interface CaptureV2Result {
  path: string
  title: string
  tags: string[]
  folder: string
  mode: CaptureMode
  dryRun: boolean
  wouldWrite: boolean
  detectedClient: string | null
  classification: Classification
  reason: string
  reviewRequired: boolean
}

const SECURITY_KEYWORDS = [
  'vulnerability', 'schwachstelle', 'sicherheit', 'cve', 'befund',
  'exploit', 'angriff', 'attack', 'risk', 'risiko', 'breach',
]

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function sanitizeFileName(title: string): string {
  const cleaned = sanitizePathSegment(title)
  return cleaned.length > 0 ? cleaned : `Capture ${today()}`
}

function extractTitleAndBody(content: string): { title: string; body: string } {
  const lines = content.split('\n')
  const firstLine = (lines[0] ?? '').replace(/^#+\s*/, '').trim()
  const fallback = content.trim().split(/[.!?]\s+/)[0]?.trim() ?? ''
  const rawTitle = firstLine || fallback || `Capture ${today()}`
  const title = rawTitle.length > 60 ? `${rawTitle.substring(0, 57)}...` : rawTitle

  const bodyLines = firstLine ? lines.slice(1) : lines
  while (bodyLines.length > 0 && bodyLines[0].trim() === '') bodyLines.shift()
  return { title, body: bodyLines.join('\n') }
}

function addTag(tags: Set<string>, tag: string): void {
  const normalized = normalizeTag(tag)
  if (normalized.length > 0) tags.add(normalized)
}

function detectClient(contentLower: string, tags: Set<string>): string | null {
  for (const [key, name] of Object.entries(loadClients())) {
    if (!contentLower.includes(key)) continue
    addTag(tags, `kunde/${key}`)
    return name
  }
  return null
}

function routeFromCategory(
  category: string,
  detectedClient: string | null,
  classification: Classification,
  techRouteAllowed: boolean,
): { folder: string; reason: string } {
  switch (category.toLowerCase()) {
    case 'kunde':
      return {
        folder: detectedClient ? `Kunden/${detectedClient}` : 'Kunden',
        reason: detectedClient ? `category=kunde, client=${detectedClient}` : 'category=kunde',
      }
    case 'sicherheit':
      return { folder: 'Sicherheit', reason: 'category=sicherheit' }
    case 'persönlich':
    case 'persoenlich':
      return { folder: 'Persönlich', reason: 'category=persönlich' }
    case 'referenz':
    case 'technik':
      if (techRouteAllowed && classification.category) {
        const folder = classification.subcategory
          ? `Technik/${classification.category}/${classification.subcategory}`
          : `Technik/${classification.category}`
        return { folder, reason: `category=${category}, ${classification.reason}` }
      }
      return { folder: 'Referenz', reason: `category=${category}` }
    default:
      return { folder: 'Inbox', reason: `unknown category=${category}` }
  }
}

export function captureV2(
  vault: Vault,
  content: string,
  options: CaptureV2Options = {},
): CaptureV2Result {
  const mode = options.mode ?? 'fast'
  const dryRun = options.dryRun ?? true
  const contentLower = content.toLowerCase()
  const { title, body } = extractTitleAndBody(content)
  const tags = new Set<string>()

  for (const term of loadTechTerms()) {
    if (contentLower.includes(term)) addTag(tags, term)
  }

  const detectedClient = detectClient(contentLower, tags)
  const isSecurity = SECURITY_KEYWORDS.some(kw => contentLower.includes(kw))
  if (isSecurity) addTag(tags, 'sicherheit')

  const preliminaryTags = [...tags]
  const classification = classifyNote(title, content, preliminaryTags)
  const minTechConfidence = mode === 'fast' ? 5 : 10
  const techRouteAllowed = !!classification.category && classification.confidence >= minTechConfidence

  if (classification.category) addTag(tags, classification.category)
  if (classification.category && classification.subcategory) {
    addTag(tags, `${classification.category}/${classification.subcategory}`)
  }

  let folder: string
  let reason: string

  if (options.category) {
    const routed = routeFromCategory(options.category, detectedClient, classification, techRouteAllowed)
    folder = routed.folder
    reason = routed.reason
    if (options.category.toLowerCase() === 'sicherheit') addTag(tags, 'sicherheit')
  } else if (detectedClient) {
    folder = `Kunden/${detectedClient}`
    reason = `client=${detectedClient}`
  } else if (isSecurity) {
    folder = 'Sicherheit'
    reason = 'security keyword'
  } else if (techRouteAllowed && classification.category) {
    folder = classification.subcategory
      ? `Technik/${classification.category}/${classification.subcategory}`
      : `Technik/${classification.category}`
    reason = classification.reason
  } else {
    folder = 'Inbox'
    reason = mode === 'strict' && classification.category
      ? `classification below strict threshold (${classification.confidence} < ${minTechConfidence})`
      : 'fallback inbox'
  }

  if (tags.size === 0) addTag(tags, folder === 'Inbox' ? 'inbox' : folder.split('/')[0])
  if (folder === 'Inbox') addTag(tags, 'inbox')

  const finalTags = [...tags]
  const datum = today()
  const tagBlock = finalTags.map(t => `  - ${t}`).join('\n')
  const noteContent = `---
status: aktiv
tags:
${tagBlock}
datum: ${datum}
quelle: capture-v2
---

# ${title}

${body}
`

  const fileName = `${sanitizeFileName(title)}.md`
  const relativePath = dryRun
    ? `${folder}/${fileName}`
    : uniqueRelativePath(vault.vaultPath, folder, fileName)
  const fullDir = vaultJoin(vault.vaultPath, folder)
  const fullPath = vaultJoin(vault.vaultPath, relativePath)
  const reviewRequired = mode === 'review' || folder === 'Inbox' || classification.topicCandidates.length > 0

  if (!dryRun) {
    assertCanWriteTool(options.logTool ?? 'capture_v2', [relativePath])
    mkdirSync(fullDir, { recursive: true })
    writeFileSync(fullPath, noteContent, 'utf-8')

    const stat = statSync(fullPath)
    vault.indexNote(fullPath, stat.mtimeMs)

    appendActionLog(vault.vaultPath, {
      tool: options.logTool ?? 'capture_v2',
      mode: 'apply',
      targets: [relativePath],
      summary: `Capture v2 nach ${folder}`,
      meta: {
        title,
        folder,
        detectedClient,
        tags: finalTags,
        captureMode: mode,
        category: options.category ?? null,
        classification,
        reviewRequired,
      },
    })
  }

  return {
    path: relativePath,
    title,
    tags: finalTags,
    folder,
    mode,
    dryRun,
    wouldWrite: !dryRun,
    detectedClient,
    classification,
    reason,
    reviewRequired,
  }
}
