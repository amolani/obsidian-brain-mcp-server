import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { loadClients, loadTechTerms } from '../config.ts'
import { classifyNote, type Classification } from '../technik-categories.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter, normalizeTag } from './frontmatter-linter.ts'
import { parseFrontmatter, stripFrontmatter } from './note-parser.ts'
import { assertCanWriteTool } from './policy.ts'
import { assertSafeRelativePath } from './vault-paths.ts'

export interface TriageNoteOptions {
  path: string
  dryRun?: boolean
  targetFolder?: string
  minConfidence?: number
  applyLowConfidence?: boolean
}

export interface TriageDuplicateCandidate {
  path: string
  title: string
  score: number
  confidence: 'high' | 'medium' | 'low'
  suggestion: 'merge' | 'review' | 'link'
  reasons: string[]
}

export interface TriageNoteResult {
  dryRun: boolean
  applied: boolean
  path: string
  targetPath: string
  title: string
  currentFolder: string
  targetFolder: string
  tags: string[]
  classification: Classification
  detectedClient: string | null
  decision: 'move' | 'normalize' | 'review_duplicate' | 'review_low_confidence'
  reasons: string[]
  duplicates: TriageDuplicateCandidate[]
  linkSuggestions: Array<{
    target: string
    targetTitle: string
    mention: string
    confidence: number
    snippet: string
  }>
  changes: string[]
}

export interface TriageInboxOptions {
  folder?: string
  dryRun?: boolean
  maxNotes?: number
  minConfidence?: number
  applyLowConfidence?: boolean
}

export interface TriageInboxResult {
  dryRun: boolean
  folder: string
  total: number
  applied: number
  reviewed: number
  results: TriageNoteResult[]
}

const SECURITY_KEYWORDS = [
  'vulnerability', 'schwachstelle', 'sicherheit', 'cve', 'befund',
  'exploit', 'angriff', 'attack', 'risk', 'risiko', 'breach',
]

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function folderOf(relativePath: string): string {
  const dir = dirname(relativePath).replace(/\\/g, '/')
  return dir === '.' ? '' : dir
}

function resolveNote(vault: Vault, pathOrTitle: string): NoteEntry | null {
  const withMd = pathOrTitle.endsWith('.md') ? pathOrTitle : `${pathOrTitle}.md`
  return vault.notes.get(pathOrTitle)
    ?? vault.notes.get(withMd)
    ?? [...vault.notes.values()].find(entry =>
      entry.title.toLowerCase() === pathOrTitle.toLowerCase()
        || basename(entry.relativePath, '.md').toLowerCase() === pathOrTitle.toLowerCase(),
    )
    ?? null
}

function addTag(tags: Set<string>, tag: string): void {
  const normalized = normalizeTag(tag)
  if (normalized.length > 0) tags.add(normalized)
}

function detectClient(textLower: string, tags: Set<string>): string | null {
  for (const [keyword, name] of Object.entries(loadClients())) {
    if (!textLower.includes(keyword)) continue
    addTag(tags, `kunde/${keyword}`)
    return name
  }
  return null
}

function routeNote(
  note: NoteEntry,
  classification: Classification,
  detectedClient: string | null,
  isSecurity: boolean,
  minConfidence: number,
): { folder: string; reason: string } {
  if (detectedClient) return { folder: `Kunden/${detectedClient}`, reason: `client=${detectedClient}` }
  if (isSecurity) return { folder: 'Sicherheit', reason: 'security keyword' }
  if (classification.category && classification.confidence >= minConfidence) {
    const folder = classification.subcategory
      ? `Technik/${classification.category}/${classification.subcategory}`
      : `Technik/${classification.category}`
    return { folder, reason: classification.reason }
  }
  return { folder: folderOf(note.relativePath) || 'Inbox', reason: 'classification below threshold' }
}

function normalizeTags(note: NoteEntry, classification: Classification, detectedClient: string | null, isSecurity: boolean): string[] {
  const tags = new Set<string>()
  for (const tag of note.tags) addTag(tags, tag)
  for (const term of loadTechTerms()) {
    if (`${note.title}\n${note.content}`.toLowerCase().includes(term)) addTag(tags, term)
  }
  if (detectedClient) {
    const clientKey = Object.entries(loadClients()).find(([, value]) => value === detectedClient)?.[0]
    if (clientKey) addTag(tags, `kunde/${clientKey}`)
  }
  if (isSecurity) addTag(tags, 'sicherheit')
  if (classification.category) addTag(tags, classification.category)
  if (classification.category && classification.subcategory) {
    addTag(tags, `${classification.category}/${classification.subcategory}`)
  }
  if (tags.size === 0) addTag(tags, 'inbox')
  return [...tags].sort()
}

function duplicateCandidates(vault: Vault, path: string): TriageDuplicateCandidate[] {
  return vault.findDuplicates(40, { focusPath: path, maxResults: 5 })
    .map(match => {
      const otherPath = match.noteA === path ? match.noteB : match.noteA
      const otherTitle = match.noteA === path ? match.titleB : match.titleA
      return {
        path: otherPath,
        title: otherTitle,
        score: match.score,
        confidence: match.confidence,
        suggestion: match.suggestion,
        reasons: match.reasons,
      }
    })
}

function linkSuggestions(vault: Vault, path: string): TriageNoteResult['linkSuggestions'] {
  return vault.suggestLinksV2({ minConfidence: 0.7, maxPerNote: 5, maxTotal: 200 })
    .filter(suggestion => suggestion.source === path)
    .slice(0, 5)
    .map(suggestion => ({
      target: suggestion.target,
      targetTitle: suggestion.targetTitle,
      mention: suggestion.mention,
      confidence: suggestion.confidence,
      snippet: suggestion.snippet,
    }))
}

function targetPathFor(note: NoteEntry, targetFolder: string): string {
  return targetFolder === folderOf(note.relativePath)
    ? note.relativePath
    : `${targetFolder}/${basename(note.relativePath)}`
}

function updateFrontmatter(vault: Vault, entry: NoteEntry, tags: string[]): string[] {
  assertCanWriteTool('triage_note', [entry.relativePath])
  const raw = readFileSync(entry.path, 'utf-8')
  const fm = parseFrontmatter(raw)
  const changes: string[] = []

  const oldTags = JSON.stringify(Array.isArray(fm.tags) ? fm.tags : [])
  fm.tags = tags
  if (JSON.stringify(tags) !== oldTags) changes.push('tags normalisiert')
  if (!fm.status) {
    fm.status = 'aktiv'
    changes.push('status gesetzt')
  }
  fm.aktualisiert = today()

  const next = `---\n${buildFrontmatter(fm)}---\n\n${stripFrontmatter(raw).trimStart()}`
  if (next !== raw) {
    writeFileSync(entry.path, next, 'utf-8')
    vault.removeNoteFromIndex(entry.relativePath)
    vault.indexNote(entry.path, statSync(entry.path).mtimeMs)
    vault.buildLinkIndex()
  }

  return changes
}

export function triageNote(vault: Vault, options: TriageNoteOptions): TriageNoteResult {
  const dryRun = options.dryRun ?? true
  const minConfidence = options.minConfidence ?? 5
  const note = resolveNote(vault, options.path)
  if (!note) throw new Error(`Note nicht gefunden: ${options.path}`)

  const textLower = `${note.title}\n${note.content}`.toLowerCase()
  const baseTags = new Set(note.tags.map(normalizeTag))
  const detectedClient = detectClient(textLower, baseTags)
  const isSecurity = SECURITY_KEYWORDS.some(keyword => textLower.includes(keyword))
  const classification = classifyNote(note.title, note.content, [...baseTags])
  const route = options.targetFolder
    ? { folder: assertSafeRelativePath(options.targetFolder), reason: 'target_folder override' }
    : routeNote(note, classification, detectedClient, isSecurity, minConfidence)
  const tags = normalizeTags(note, classification, detectedClient, isSecurity)
  const duplicates = duplicateCandidates(vault, note.relativePath)
  const suggestions = linkSuggestions(vault, note.relativePath)
  const currentFolder = folderOf(note.relativePath)
  const targetFolder = route.folder
  const targetPath = targetPathFor(note, targetFolder)
  const reasons = [route.reason]
  const changes: string[] = []

  const hasHighDuplicate = duplicates.some(candidate => candidate.confidence === 'high')
  let decision: TriageNoteResult['decision']
  if (hasHighDuplicate) {
    decision = 'review_duplicate'
    reasons.push('high-confidence duplicate candidate')
  } else if (!options.applyLowConfidence && !options.targetFolder && !detectedClient && !isSecurity && classification.confidence < minConfidence) {
    decision = 'review_low_confidence'
    reasons.push(`classification confidence ${classification.confidence} < ${minConfidence}`)
  } else if (targetPath !== note.relativePath) {
    decision = 'move'
  } else {
    decision = 'normalize'
  }

  const result: TriageNoteResult = {
    dryRun,
    applied: false,
    path: note.relativePath,
    targetPath,
    title: note.title,
    currentFolder,
    targetFolder,
    tags,
    classification,
    detectedClient,
    decision,
    reasons,
    duplicates,
    linkSuggestions: suggestions,
    changes,
  }

  if (dryRun || decision === 'review_duplicate' || decision === 'review_low_confidence') return result

  changes.push(...updateFrontmatter(vault, note, tags))
  if (decision === 'move') {
    const move = vault.renameNote({
      path: note.relativePath,
      targetFolder,
      dryRun: false,
      updateTitle: false,
    })
    result.targetPath = move.plan.target
    changes.push(`verschoben nach ${move.plan.target}`)
  }

  appendActionLog(vault.vaultPath, {
    tool: 'triage_note',
    mode: 'apply',
    targets: [note.relativePath, result.targetPath],
    summary: `Note triagiert: ${note.relativePath} → ${result.targetPath}`,
    before: note.relativePath,
    after: result.targetPath,
    meta: {
      decision,
      targetFolder,
      tags,
      detectedClient,
      classification,
      duplicateCount: duplicates.length,
      linkSuggestionCount: suggestions.length,
      changes,
    },
  })

  result.applied = true
  return result
}

export function triageInbox(vault: Vault, options: TriageInboxOptions = {}): TriageInboxResult {
  const folder = options.folder === undefined ? 'Inbox' : assertSafeRelativePath(options.folder)
  const dryRun = options.dryRun ?? true
  const maxNotes = options.maxNotes ?? 25
  if (!dryRun) assertCanWriteTool('triage_inbox')
  const candidates = [...vault.notes.values()]
    .filter(note => note.relativePath.startsWith(`${folder.replace(/\/$/, '')}/`))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .slice(0, maxNotes)

  const results = candidates.map(note => triageNote(vault, {
    path: note.relativePath,
    dryRun,
    minConfidence: options.minConfidence,
    applyLowConfidence: options.applyLowConfidence,
  }))

  return {
    dryRun,
    folder,
    total: results.length,
    applied: results.filter(result => result.applied).length,
    reviewed: results.filter(result => result.decision.startsWith('review_')).length,
    results,
  }
}
