import { dirname } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { isActivePath } from './note-scope.ts'
import { tokenize, tokenizeContent, jaccard } from './text-utils.ts'

export interface DuplicateMatch {
  noteA: string
  noteB: string
  titleA: string
  titleB: string
  score: number
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]
  suggestion: 'merge' | 'review' | 'link'
}

export interface DuplicateScanStats {
  mode: 'exact' | 'blocked'
  notes: number
  candidatePairs: number
  scoredPairs: number
  oversizedBuckets: number
  maxCandidatesPerNote: number | null
  resultLimit: number | null
}

export interface FindDuplicatesOptions {
  /** Keep only the best N results. Scoring still remains deterministic. */
  maxResults?: number
  /** Restrict comparison to pairs containing this path. */
  focusPath?: string
  /** Populated by the analyzer for benchmarks and diagnostics. */
  stats?: DuplicateScanStats
}

interface DuplicateNoteData {
  rel: string
  entry: NoteEntry
  titleTokens: Set<string>
  contentTokens: Set<string>
  tagSet: Set<string>
  normalizedTitle: string
  folder: string
}

interface ScoredPair {
  a: DuplicateNoteData
  b: DuplicateNoteData
  score: number
}

// Below this boundary, retain the original exhaustive semantics. Above it, a
// deterministic blocking index prevents common templates from producing n^2
// comparisons and millions of materialized review candidates.
export const DUPLICATE_EXACT_SCAN_MAX_NOTES = 1000
export const DUPLICATE_MAX_CANDIDATES_PER_NOTE = 256
const MAX_FULL_BUCKET_SIZE = 512
const OVERSIZED_BUCKET_NEIGHBORS = 24
const MAX_TITLE_BLOCKS = 6
const MAX_CONTENT_BLOCKS = 8
const MAX_TAG_BLOCKS = 6
const MAX_TRIGRAM_BLOCKS = 2

function isDaily(entry: NoteEntry): boolean {
  return entry.frontmatter?.tags?.includes('daily') === true
}

function noteData(rel: string, entry: NoteEntry): DuplicateNoteData {
  return {
    rel,
    entry,
    titleTokens: tokenize(entry.title),
    contentTokens: tokenizeContent(entry.content),
    tagSet: new Set(entry.tags),
    normalizedTitle: entry.title.toLowerCase().trim(),
    folder: dirname(rel),
  }
}

function duplicateClass(score: number): Pick<DuplicateMatch, 'confidence' | 'suggestion'> {
  if (score >= 80) return { confidence: 'high', suggestion: 'merge' }
  if (score >= 55) return { confidence: 'medium', suggestion: 'review' }
  return { confidence: 'low', suggestion: 'link' }
}

function scorePair(a: DuplicateNoteData, b: DuplicateNoteData, includeReasons: boolean): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0

  const titleSim = jaccard(a.titleTokens, b.titleTokens)
  if (titleSim >= 0.35) {
    score += Math.round(titleSim * 50)
    if (includeReasons) reasons.push(`Titel ${Math.round(titleSim * 100)}% ähnlich`)
  }

  if (a.normalizedTitle.length > 10 && b.normalizedTitle.length > 10) {
    if (a.normalizedTitle.includes(b.normalizedTitle) || b.normalizedTitle.includes(a.normalizedTitle)) {
      score += 25
      if (includeReasons) reasons.push('Titel enthält den anderen')
    }
  }

  const contentSim = jaccard(a.contentTokens, b.contentTokens)
  if (contentSim >= 0.3) {
    score += Math.round(contentSim * 35)
    if (includeReasons) reasons.push(`Inhalt ${Math.round(contentSim * 100)}% ähnlich`)
  }

  let sharedTagCount = 0
  for (const tag of a.tagSet) if (b.tagSet.has(tag)) sharedTagCount++
  if (sharedTagCount >= 3) {
    score += sharedTagCount * 2
    if (includeReasons) reasons.push(`${sharedTagCount} gemeinsame Tags`)
  }

  if (a.folder === b.folder && a.folder !== '.') {
    score += 5
    if (includeReasons) reasons.push('gleicher Ordner')
  }

  return { score, reasons }
}

function toMatch(pair: ScoredPair): DuplicateMatch {
  const { reasons } = scorePair(pair.a, pair.b, true)
  return {
    noteA: pair.a.rel,
    noteB: pair.b.rel,
    titleA: pair.a.entry.title,
    titleB: pair.b.entry.title,
    score: pair.score,
    ...duplicateClass(pair.score),
    reasons,
  }
}

function compareRank(a: ScoredPair, b: ScoredPair): number {
  return b.score - a.score || a.a.rel.localeCompare(b.a.rel) || a.b.rel.localeCompare(b.b.rel)
}

function rememberPair(top: ScoredPair[], pair: ScoredPair, limit: number): void {
  if (limit <= 0) return
  if (top.length < limit) {
    top.push(pair)
    return
  }

  let worst = 0
  for (let i = 1; i < top.length; i++) {
    if (compareRank(top[worst], top[i]) < 0) worst = i
  }
  if (compareRank(pair, top[worst]) < 0) top[worst] = pair
}

function titleTrigrams(value: string): string[] {
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim()
  const grams = new Set<string>()
  for (let i = 0; i <= normalized.length - 3; i++) grams.add(normalized.slice(i, i + 3))
  return [...grams]
}

function rawBlockKeys(note: DuplicateNoteData): string[] {
  return [
    `exact:${note.normalizedTitle}`,
    ...[...note.titleTokens].map(token => `title:${token}`),
    ...[...note.contentTokens].map(token => `content:${token}`),
    ...[...note.tagSet].map(tag => `tag:${tag.toLowerCase()}`),
    ...titleTrigrams(note.normalizedTitle).map(gram => `trigram:${gram}`),
    ...(note.folder === '.' ? [] : [`folder:${note.folder.toLowerCase()}`]),
  ]
}

function rarest(keys: string[], frequencies: Map<string, number>, limit: number): string[] {
  return keys
    .sort((a, b) => (frequencies.get(a) ?? 0) - (frequencies.get(b) ?? 0) || a.localeCompare(b))
    .slice(0, limit)
}

function selectedBlockKeys(note: DuplicateNoteData, frequencies: Map<string, number>): string[] {
  const keys = rawBlockKeys(note)
  const exact = keys.filter(key => key.startsWith('exact:'))
  const title = rarest(keys.filter(key => key.startsWith('title:')), frequencies, MAX_TITLE_BLOCKS)
  const content = rarest(keys.filter(key => key.startsWith('content:')), frequencies, MAX_CONTENT_BLOCKS)
  const tags = rarest(keys.filter(key => key.startsWith('tag:')), frequencies, MAX_TAG_BLOCKS)
  const trigrams = rarest(keys.filter(key => key.startsWith('trigram:')), frequencies, MAX_TRIGRAM_BLOCKS)
  const folder = keys.filter(key => key.startsWith('folder:'))
  return [...exact, ...title, ...content, ...tags, ...trigrams, ...folder]
}

function lowerBound(values: number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle] < target) low = middle + 1
    else high = middle
  }
  return low
}

function addBucketCandidates(target: Set<number>, bucket: number[], current: number): void {
  if (bucket.length <= MAX_FULL_BUCKET_SIZE) {
    for (const candidate of bucket) {
      if (candidate > current) target.add(candidate)
      if (target.size >= DUPLICATE_MAX_CANDIDATES_PER_NOTE) return
    }
    return
  }

  const position = lowerBound(bucket, current)
  const end = Math.min(bucket.length, position + OVERSIZED_BUCKET_NEIGHBORS + 1)
  for (let i = position; i < end; i++) {
    const candidate = bucket[i]
    if (candidate > current) target.add(candidate)
    if (target.size >= DUPLICATE_MAX_CANDIDATES_PER_NOTE) return
  }
}

function assignStats(target: DuplicateScanStats | undefined, source: DuplicateScanStats): void {
  if (!target) return
  Object.assign(target, source)
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor(value))
}

export function analyzeDuplicatePair(vault: Vault, noteA: string, noteB: string): DuplicateMatch | null {
  const entryA = vault.notes.get(noteA)
  const entryB = vault.notes.get(noteB)
  if (!entryA || !entryB || noteA === noteB) return null
  if (!isActivePath(noteA) || !isActivePath(noteB) || isDaily(entryA) || isDaily(entryB)) return null
  const a = noteData(noteA, entryA)
  const b = noteData(noteB, entryB)
  const ordered = a.rel.localeCompare(b.rel) <= 0 ? { a, b } : { a: b, b: a }
  const { score } = scorePair(ordered.a, ordered.b, false)
  return toMatch({ ...ordered, score })
}

export function findDuplicates(vault: Vault, minScore: number = 40, options: FindDuplicatesOptions = {}): DuplicateMatch[] {
  const limit = normalizedLimit(options.maxResults)
  if (limit === 0) {
    assignStats(options.stats, {
      mode: 'exact', notes: 0, candidatePairs: 0, scoredPairs: 0,
      oversizedBuckets: 0, maxCandidatesPerNote: null, resultLimit: 0,
    })
    return []
  }

  const notes = [...vault.notes.entries()]
    .filter(([rel, entry]) => isActivePath(rel) && !isDaily(entry))
    .map(([rel, entry]) => noteData(rel, entry))
  const focusPath = options.focusPath
  const exact = notes.length <= DUPLICATE_EXACT_SCAN_MAX_NOTES || minScore <= 0 || !!focusPath
  const top: ScoredPair[] = []
  let candidatePairs = 0
  let scoredPairs = 0

  if (exact) {
    const evaluate = (a: DuplicateNoteData, b: DuplicateNoteData): void => {
      candidatePairs++
      const { score } = scorePair(a, b, false)
      scoredPairs++
      if (score < minScore) return
      if (Number.isFinite(limit)) rememberPair(top, { a, b, score }, limit)
      else top.push({ a, b, score })
    }

    if (focusPath) {
      const focusIndex = notes.findIndex(note => note.rel === focusPath)
      if (focusIndex >= 0) {
        for (let i = 0; i < notes.length; i++) {
          if (i === focusIndex) continue
          if (i < focusIndex) evaluate(notes[i], notes[focusIndex])
          else evaluate(notes[focusIndex], notes[i])
        }
      }
    } else {
      for (let i = 0; i < notes.length; i++) {
        for (let j = i + 1; j < notes.length; j++) evaluate(notes[i], notes[j])
      }
    }

    // Score-only sorting preserves the original stable pair order for the exact path.
    if (Number.isFinite(limit)) top.sort(compareRank)
    else top.sort((a, b) => b.score - a.score)
    assignStats(options.stats, {
      mode: 'exact', notes: notes.length, candidatePairs, scoredPairs,
      oversizedBuckets: 0, maxCandidatesPerNote: null,
      resultLimit: Number.isFinite(limit) ? limit : null,
    })
    return top.map(toMatch)
  }

  // Large vaults use stable path order so candidate windows and tied results are
  // reproducible across filesystems and Node versions.
  notes.sort((a, b) => a.rel.localeCompare(b.rel))
  const frequencies = new Map<string, number>()
  const rawKeys = notes.map(note => rawBlockKeys(note))
  for (const keys of rawKeys) {
    for (const key of new Set(keys)) frequencies.set(key, (frequencies.get(key) ?? 0) + 1)
  }
  const keysByNote = notes.map(note => selectedBlockKeys(note, frequencies))
  const buckets = new Map<string, number[]>()
  for (let i = 0; i < keysByNote.length; i++) {
    for (const key of keysByNote[i]) {
      const bucket = buckets.get(key) ?? []
      bucket.push(i)
      buckets.set(key, bucket)
    }
  }
  const oversizedBuckets = new Set([...buckets.entries()].filter(([, bucket]) => bucket.length > MAX_FULL_BUCKET_SIZE).map(([key]) => key))

  for (let i = 0; i < notes.length; i++) {
    const candidates = new Set<number>()
    for (const key of keysByNote[i]) {
      addBucketCandidates(candidates, buckets.get(key) ?? [], i)
      if (candidates.size >= DUPLICATE_MAX_CANDIDATES_PER_NOTE) break
    }

    const orderedCandidates = [...candidates].sort((a, b) => a - b)
    candidatePairs += orderedCandidates.length
    for (const j of orderedCandidates) {
      const a = notes[i]
      const b = notes[j]
      const { score } = scorePair(a, b, false)
      scoredPairs++
      if (score < minScore) continue
      if (Number.isFinite(limit)) rememberPair(top, { a, b, score }, limit)
      else top.push({ a, b, score })
    }
  }

  top.sort(compareRank)
  assignStats(options.stats, {
    mode: 'blocked', notes: notes.length, candidatePairs, scoredPairs,
    oversizedBuckets: oversizedBuckets.size,
    maxCandidatesPerNote: DUPLICATE_MAX_CANDIDATES_PER_NOTE,
    resultLimit: Number.isFinite(limit) ? limit : null,
  })
  return top.map(toMatch)
}
