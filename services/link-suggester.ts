import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'

export interface LinkSuggestionV2 {
  source: string
  target: string
  targetTitle: string
  mention: string
  confidence: number
  reasons: string[]
  snippet: string
}

export interface LinkSuggestionOptions {
  minConfidence?: number
  maxPerNote?: number
  maxTotal?: number
}

export interface ApplyLinkSuggestionsOptions extends LinkSuggestionOptions {
  dryRun?: boolean
  sources?: string[]
}

export interface ApplyLinkSuggestionsResult {
  dryRun: boolean
  linked: Array<{
    source: string
    target: string
    mention: string
    replacement: string
    confidence: number
  }>
  skipped: Array<{ source: string; target: string; mention: string; reason: string }>
}

interface MentionCandidate {
  term: string
  target: string
  targetTitle: string
  baseScore: number
  reasons: string[]
}

const GENERIC_TITLES = new Set([
  'notizen', 'zugangsdaten', 'todos', 'todo', 'pw', 'passwort', 'dashboard',
  'index', 'readme', 'moc', '_moc', 'untitled',
])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeTerm(value: string): string {
  return value.toLowerCase().trim()
}

function isUsefulTerm(value: string): boolean {
  const term = normalizeTerm(value)
  if (term.length < 4) return false
  if (GENERIC_TITLES.has(term)) return false
  if (/^\d+$/.test(term)) return false
  return true
}

function addCandidate(
  candidates: Map<string, MentionCandidate>,
  term: string,
  target: string,
  targetTitle: string,
  baseScore: number,
  reason: string,
): void {
  if (!isUsefulTerm(term)) return
  const key = `${normalizeTerm(term)}→${target}`
  const existing = candidates.get(key)
  if (existing) {
    existing.baseScore = Math.max(existing.baseScore, baseScore)
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
    return
  }
  candidates.set(key, {
    term,
    target,
    targetTitle,
    baseScore,
    reasons: [reason],
  })
}

function aliases(entry: NoteEntry): string[] {
  const raw = entry.frontmatter?.aliases
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  return [String(raw)]
}

function folderParts(path: string): Set<string> {
  return new Set(dirname(path).split('/').filter(part => part !== '.' && part.length > 0).map(normalizeTerm))
}

function tagOverlap(a: string[], b: string[]): number {
  const left = new Set(a.map(normalizeTerm))
  let count = 0
  for (const tag of b.map(normalizeTerm)) if (left.has(tag)) count++
  return count
}

function findMention(content: string, term: string): RegExpMatchArray | null {
  const escaped = escapeRegExp(term)
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'iu')
  return content.match(re)
}

function hasExistingLiteralLink(content: string, term: string): boolean {
  const escaped = escapeRegExp(term)
  return new RegExp(`\\[\\[[^\\]]*${escaped}[^\\]]*\\]\\]`, 'iu').test(content)
}

function snippetFor(content: string, mention: string): string {
  const lower = content.toLowerCase()
  const idx = lower.indexOf(mention.toLowerCase())
  if (idx === -1) return ''
  const start = Math.max(0, idx - 80)
  const end = Math.min(content.length, idx + mention.length + 80)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < content.length ? '...' : ''
  return `${prefix}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

function splitFrontmatter(raw: string): { prefix: string; body: string } {
  const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  if (!match) return { prefix: '', body: raw }
  return { prefix: match[0], body: raw.slice(match[0].length) }
}

function linkReplacement(target: string, mention: string): string {
  return `[[${target.replace(/\.md$/, '')}|${mention}]]`
}

function replaceFirstPlainMention(content: string, mention: string, target: string): { content: string; replacement: string; replaced: boolean } {
  const replacement = linkReplacement(target, mention)
  const escaped = escapeRegExp(mention)
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=$|[^\\p{L}\\p{N}_])`, 'iu')
  const lines = content.split('\n')
  let inCodeFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence
      continue
    }
    if (inCodeFence) continue
    if (line.includes('[[') && line.includes(']]')) continue

    const next = line.replace(re, (_full, prefix: string, found: string) => `${prefix}${linkReplacement(target, found)}`)
    if (next !== line) {
      lines[i] = next
      return { content: lines.join('\n'), replacement, replaced: true }
    }
  }

  return { content, replacement, replaced: false }
}

function buildCandidates(vault: Vault): MentionCandidate[] {
  const candidates = new Map<string, MentionCandidate>()
  for (const [target, entry] of vault.notes) {
    addCandidate(candidates, basename(target, '.md'), target, entry.title, 0.72, 'filename')
    addCandidate(candidates, entry.title, target, entry.title, 0.78, 'title')
    for (const alias of aliases(entry)) {
      addCandidate(candidates, alias, target, entry.title, 0.82, 'alias')
    }
  }
  return [...candidates.values()]
}

export function suggestLinksV2(vault: Vault, options: LinkSuggestionOptions = {}): LinkSuggestionV2[] {
  const minConfidence = options.minConfidence ?? 0.55
  const maxPerNote = options.maxPerNote ?? 5
  const maxTotal = options.maxTotal ?? 100
  const candidates = buildCandidates(vault)
  const results: LinkSuggestionV2[] = []

  for (const [source, sourceEntry] of vault.notes) {
    const existingTargets = new Set(
      sourceEntry.outgoingLinks.map(link => vault.resolveLink(link)).filter((link): link is string => !!link),
    )
    const sourceFolders = folderParts(source)
    const perSource: LinkSuggestionV2[] = []

    for (const candidate of candidates) {
      if (candidate.target === source) continue
      if (existingTargets.has(candidate.target)) continue
      if (hasExistingLiteralLink(sourceEntry.content, candidate.term)) continue

      const match = findMention(sourceEntry.content, candidate.term)
      if (!match) continue

      const targetEntry = vault.notes.get(candidate.target)
      if (!targetEntry) continue

      const reasons = [...candidate.reasons]
      let confidence = candidate.baseScore

      const overlap = tagOverlap(sourceEntry.tags, targetEntry.tags)
      if (overlap > 0) {
        confidence += Math.min(0.12, overlap * 0.04)
        reasons.push(`shared-tags:${overlap}`)
      }

      const targetFolders = folderParts(candidate.target)
      if ([...sourceFolders].some(part => targetFolders.has(part))) {
        confidence += 0.08
        reasons.push('folder-proximity')
      }

      if (candidate.term === targetEntry.title) confidence += 0.05
      confidence = Math.min(0.98, Number(confidence.toFixed(2)))
      if (confidence < minConfidence) continue

      perSource.push({
        source,
        target: candidate.target,
        targetTitle: candidate.targetTitle,
        mention: match[2],
        confidence,
        reasons,
        snippet: snippetFor(sourceEntry.content, match[2]),
      })
    }

    perSource.sort((a, b) => b.confidence - a.confidence || a.target.localeCompare(b.target))
    results.push(...perSource.slice(0, maxPerNote))
  }

  return results
    .sort((a, b) => b.confidence - a.confidence || a.source.localeCompare(b.source))
    .slice(0, maxTotal)
}

export function applyLinkSuggestions(vault: Vault, options: ApplyLinkSuggestionsOptions = {}): ApplyLinkSuggestionsResult {
  const dryRun = options.dryRun ?? true
  const minConfidence = options.minConfidence ?? 0.85
  const sourceFilter = options.sources ? new Set(options.sources) : null
  const suggestions = suggestLinksV2(vault, {
    minConfidence,
    maxPerNote: options.maxPerNote,
    maxTotal: Number.MAX_SAFE_INTEGER,
  })
    .filter(s => !sourceFilter || sourceFilter.has(s.source))
    .slice(0, options.maxTotal ?? Number.MAX_SAFE_INTEGER)

  const linked: ApplyLinkSuggestionsResult['linked'] = []
  const skipped: ApplyLinkSuggestionsResult['skipped'] = []
  const bySource = new Map<string, LinkSuggestionV2[]>()
  const mentionTargets = new Map<string, Set<string>>()

  for (const suggestion of suggestions) {
    const key = `${suggestion.source}::${normalizeTerm(suggestion.mention)}`
    if (!mentionTargets.has(key)) mentionTargets.set(key, new Set())
    mentionTargets.get(key)!.add(suggestion.target)
    if (!bySource.has(suggestion.source)) bySource.set(suggestion.source, [])
    bySource.get(suggestion.source)!.push(suggestion)
  }

  for (const [source, sourceSuggestions] of bySource) {
    const entry = vault.notes.get(source)
    if (!entry) {
      for (const suggestion of sourceSuggestions) {
        skipped.push({ source, target: suggestion.target, mention: suggestion.mention, reason: 'Quelle nicht gefunden' })
      }
      continue
    }

    const raw = readFileSync(entry.path, 'utf-8')
    const split = splitFrontmatter(raw)
    let body = split.body
    let changed = false

    for (const suggestion of sourceSuggestions.sort((a, b) => b.confidence - a.confidence || b.mention.length - a.mention.length)) {
      const ambiguityKey = `${suggestion.source}::${normalizeTerm(suggestion.mention)}`
      if ((mentionTargets.get(ambiguityKey)?.size ?? 0) > 1) {
        skipped.push({ source, target: suggestion.target, mention: suggestion.mention, reason: 'Mention ist mehrdeutig' })
        continue
      }

      const replaced = replaceFirstPlainMention(body, suggestion.mention, suggestion.target)
      if (!replaced.replaced) {
        skipped.push({ source, target: suggestion.target, mention: suggestion.mention, reason: 'Plain-Text-Mention nicht sicher ersetzbar' })
        continue
      }

      body = replaced.content
      changed = true
      linked.push({
        source,
        target: suggestion.target,
        mention: suggestion.mention,
        replacement: replaced.replacement,
        confidence: suggestion.confidence,
      })
    }

    if (changed && !dryRun) {
      writeFileSync(entry.path, `${split.prefix}${body}`, 'utf-8')
      vault.indexNote(entry.path, statSync(entry.path).mtimeMs)
    }
  }

  if (!dryRun && linked.length > 0) {
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'apply_link_suggestions',
      mode: 'apply',
      targets: [...new Set(linked.map(item => item.source))],
      summary: `${linked.length} Link-Vorschlag/Vorschläge angewendet`,
      before: linked[0].mention,
      after: linked[0].replacement,
      meta: { linked },
    })
  }

  return { dryRun, linked, skipped }
}
