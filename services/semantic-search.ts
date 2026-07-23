import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { loadCategories, loadTagAliases } from '../config.ts'
import { appendActionLog } from './action-log.ts'
import { atomicWriteJsonSync } from './atomic-file.ts'
import { sanitizeKnowledgeSurfaceFrontmatter } from './knowledge-surface-sanitizer.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export type WeightedVector = Map<string, number>

export interface SemanticSearchOptions {
  query: string
  limit?: number
  folder?: string
  tags?: string[]
  minScore?: number
  includeArchived?: boolean
  useIndex?: boolean
}

export interface SemanticSearchResult {
  path: string
  title: string
  score: number
  confidence: 'high' | 'medium' | 'low'
  snippet: string
  matchedTerms: string[]
  tags: string[]
  status: string | null
  reasons: string[]
}

export interface VectorProvider {
  name: string
  vectorizeNote(path: string, entry: NoteEntry): WeightedVector
  vectorizeQuery(query: string): WeightedVector
}

export interface SemanticIndexStatus {
  path: string
  exists: boolean
  provider: string
  version: number
  builtAt: string | null
  totalNotes: number
  indexedNotes: number
  freshNotes: number
  missingNotes: string[]
  staleNotes: string[]
  extraNotes: string[]
}

export interface RebuildSemanticIndexOptions {
  dryRun?: boolean
}

export interface RebuildSemanticIndexResult {
  dryRun: boolean
  path: string
  provider: string
  version: number
  totalNotes: number
  indexedNotes: number
  wouldWrite: boolean
  status: SemanticIndexStatus
}

interface StoredSemanticVector {
  path: string
  hash: string
  vector: Record<string, number>
}

interface StoredSemanticIndex {
  version: number
  provider: string
  builtAt: string
  entries: StoredSemanticVector[]
}

const STOPWORDS = new Set([
  'und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'des', 'mit', 'für', 'fuer',
  'bei', 'zum', 'zur', 'auf', 'aus', 'vom', 'ins', 'als', 'von', 'ein', 'eine',
  'einer', 'einem', 'eines', 'nicht', 'auch', 'noch', 'nur', 'bis', 'so', 'im',
  'am', 'an', 'ist', 'sind', 'war', 'wurde', 'werden', 'wie', 'was', 'wenn',
  'and', 'or', 'the', 'for', 'with', 'from', 'to', 'in', 'on', 'at', 'by', 'of',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'not', 'but', 'also', 'how',
])

const BUILTIN_CONCEPTS: Record<string, string[]> = {
  container: ['docker', 'compose', 'podman', 'traefik', 'nginx'],
  containers: ['docker', 'compose', 'podman', 'traefik', 'nginx'],
  proxy: ['reverse-proxy', 'traefik', 'nginx', 'tls'],
  routing: ['proxy', 'traefik', 'nginx', 'firewall'],
  firewall: ['opnsense', 'pfsense', 'vlan', 'routing'],
  directory: ['active-directory', 'ldap', 'samba'],
  domain: ['active-directory', 'ldap', 'samba'],
  backup: ['restic', 'snapshot', 'proxmox'],
  virtualization: ['proxmox', 'vm', 'lxc', 'hypervisor'],
}

function normalizeTerm(term: string): string {
  return term
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/_/g, '-')
    .trim()
}

function tokenize(text: string): string[] {
  const normalized = normalizeTerm(text)
  const raw = normalized
    .replace(/[^\p{L}\p{N}/\s-]/gu, ' ')
    .split(/[\s/]+/)
    .flatMap(t => t.includes('-') ? [t, ...t.split('-')] : [t])
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))

  return raw.map(t => t.replace(/^-+|-+$/g, '')).filter(Boolean)
}

function addWeighted(vector: WeightedVector, text: string, weight: number): void {
  for (const token of tokenize(text)) {
    vector.set(token, (vector.get(token) ?? 0) + weight)
  }
}

function headings(content: string): string {
  return content
    .split('\n')
    .filter(line => /^#{1,3}\s+\S/.test(line))
    .map(line => line.replace(/^#+\s+/, ''))
    .join(' ')
}

function bodyText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/^#+\s+.+$/gm, ' ')
}

function addConceptExpansion(vector: WeightedVector, term: string, weight: number): void {
  const aliases = loadTagAliases()
  const normalized = normalizeTerm(term)
  const canonical = aliases[normalized]
  if (canonical) addWeighted(vector, canonical, weight)

  for (const [alias, target] of Object.entries(aliases)) {
    if (target === normalized) addWeighted(vector, alias, weight * 0.6)
  }

  for (const related of BUILTIN_CONCEPTS[normalized] ?? []) {
    addWeighted(vector, related, weight)
  }

  for (const category of loadCategories()) {
    const categoryTerms = [category.name, ...category.keywords, ...category.filenameHints]
    if (categoryTerms.map(normalizeTerm).includes(normalized)) addWeighted(vector, category.name, weight)
    for (const [subName, sub] of Object.entries(category.subcategories)) {
      const subTerms = [subName, ...sub.keywords, ...sub.filenameHints]
      if (subTerms.map(normalizeTerm).includes(normalized)) {
        addWeighted(vector, `${category.name} ${subName}`, weight)
      }
    }
  }
}

class LocalKeywordVectorProvider implements VectorProvider {
  name = 'local-keyword-v1'

  vectorizeNote(path: string, entry: NoteEntry): WeightedVector {
    const vector: WeightedVector = new Map()
    addWeighted(vector, entry.title, 5)
    addWeighted(vector, basename(path, '.md'), 4)
    addWeighted(vector, dirname(path), 2)
    addWeighted(vector, entry.tags.join(' '), 4)
    addWeighted(vector, headings(entry.content), 3)
    addWeighted(vector, entry.outgoingLinks.join(' '), 1.5)
    addWeighted(
      vector,
      JSON.stringify(sanitizeKnowledgeSurfaceFrontmatter(entry.frontmatter)),
      1.5,
    )
    addWeighted(vector, bodyText(entry.content), 1)
    return vector
  }

  vectorizeQuery(query: string): WeightedVector {
    const vector: WeightedVector = new Map()
    const queryTerms = tokenize(query)
    addWeighted(vector, query, 3)
    for (const term of queryTerms) addConceptExpansion(vector, term, 1.5)
    return vector
  }
}

const LOCAL_PROVIDER = new LocalKeywordVectorProvider()
const SEMANTIC_INDEX_FILE = '.semantic-index.json'
const SEMANTIC_INDEX_VERSION = 1

function cosine(a: WeightedVector, b: WeightedVector): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const value of a.values()) normA += value * value
  for (const value of b.values()) normB += value * value
  for (const [term, value] of a) dot += value * (b.get(term) ?? 0)
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

function matchedTerms(queryVector: WeightedVector, noteVector: WeightedVector): string[] {
  return [...queryVector.keys()]
    .filter(term => noteVector.has(term))
    .sort((a, b) => (queryVector.get(b) ?? 0) - (queryVector.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, 12)
}

function snippet(entry: NoteEntry, terms: string[]): string {
  const clean = bodyText(entry.content).replace(/\s+/g, ' ').trim()
  if (!clean) return entry.title
  const lower = normalizeTerm(clean)
  const idx = terms
    .map(term => lower.indexOf(normalizeTerm(term)))
    .filter(i => i >= 0)
    .sort((a, b) => a - b)[0] ?? 0
  const start = Math.max(0, idx - 90)
  const end = Math.min(clean.length, idx + 180)
  const prefix = start > 0 ? '...' : ''
  const suffix = end < clean.length ? '...' : ''
  return `${prefix}${clean.slice(start, end).trim()}${suffix}`
}

function confidence(score: number): SemanticSearchResult['confidence'] {
  if (score >= 55) return 'high'
  if (score >= 30) return 'medium'
  return 'low'
}

function reasons(entry: NoteEntry, path: string, matches: string[]): string[] {
  const result: string[] = []
  const titleTerms = new Set(tokenize(entry.title))
  const tagTerms = new Set(tokenize(entry.tags.join(' ')))
  const pathTerms = new Set(tokenize(path))
  if (matches.some(t => titleTerms.has(t))) result.push('title')
  if (matches.some(t => tagTerms.has(t))) result.push('tags')
  if (matches.some(t => pathTerms.has(t))) result.push('path')
  if (matches.length > 0) result.push(`terms: ${matches.slice(0, 5).join(', ')}`)
  return result.length > 0 ? result : ['vector similarity']
}

function indexPath(vault: Vault): string {
  return vaultJoin(vault.vaultPath, SEMANTIC_INDEX_FILE)
}

function noteHash(entry: NoteEntry): string {
  return createHash('sha256')
    .update(entry.title)
    .update('\n')
    .update(JSON.stringify(sanitizeKnowledgeSurfaceFrontmatter(entry.frontmatter)))
    .update('\n')
    .update(entry.tags.join('\n'))
    .update('\n')
    .update(entry.outgoingLinks.join('\n'))
    .update('\n')
    .update(entry.content)
    .digest('hex')
}

function vectorToObject(vector: WeightedVector): Record<string, number> {
  return Object.fromEntries([...vector.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function objectToVector(vector: Record<string, number>): WeightedVector {
  return new Map(Object.entries(vector).filter(([, value]) => typeof value === 'number'))
}

function readStoredIndex(vault: Vault, provider: VectorProvider = LOCAL_PROVIDER): StoredSemanticIndex | null {
  const path = indexPath(vault)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as StoredSemanticIndex
    if (parsed.version !== SEMANTIC_INDEX_VERSION) return null
    if (parsed.provider !== provider.name) return null
    if (!Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}

function buildStoredIndex(vault: Vault, provider: VectorProvider = LOCAL_PROVIDER): StoredSemanticIndex {
  return {
    version: SEMANTIC_INDEX_VERSION,
    provider: provider.name,
    builtAt: new Date().toISOString(),
    entries: [...vault.notes.entries()]
      .filter(([path]) => !path.startsWith('Archiv/'))
      .map(([path, entry]) => ({
        path,
        hash: noteHash(entry),
        vector: vectorToObject(provider.vectorizeNote(path, entry)),
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  }
}

function statusFromStoredIndex(vault: Vault, stored: StoredSemanticIndex | null, provider: VectorProvider = LOCAL_PROVIDER): SemanticIndexStatus {
  const indexed = new Map((stored?.entries ?? []).map(entry => [entry.path, entry]))
  const searchableNotes = [...vault.notes.entries()].filter(([path]) => !path.startsWith('Archiv/'))
  const missingNotes: string[] = []
  const staleNotes: string[] = []
  let freshNotes = 0

  for (const [path, entry] of searchableNotes) {
    const existing = indexed.get(path)
    if (!existing) {
      missingNotes.push(path)
      continue
    }
    if (existing.hash !== noteHash(entry)) staleNotes.push(path)
    else freshNotes++
  }

  const currentPaths = new Set(searchableNotes.map(([path]) => path))
  const extraNotes = [...indexed.keys()].filter(path => !currentPaths.has(path)).sort()

  return {
    path: SEMANTIC_INDEX_FILE,
    exists: !!stored,
    provider: stored?.provider ?? provider.name,
    version: stored?.version ?? SEMANTIC_INDEX_VERSION,
    builtAt: stored?.builtAt ?? null,
    totalNotes: searchableNotes.length,
    indexedNotes: indexed.size,
    freshNotes,
    missingNotes: missingNotes.sort(),
    staleNotes: staleNotes.sort(),
    extraNotes,
  }
}

function indexedVectors(vault: Vault, provider: VectorProvider = LOCAL_PROVIDER): Map<string, WeightedVector> | null {
  const stored = readStoredIndex(vault, provider)
  if (!stored) return null
  const status = statusFromStoredIndex(vault, stored, provider)
  if (status.missingNotes.length > 0 || status.staleNotes.length > 0 || status.extraNotes.length > 0) return null
  return new Map(stored.entries.map(entry => [entry.path, objectToVector(entry.vector)]))
}

export function semanticIndexStatus(vault: Vault, provider: VectorProvider = LOCAL_PROVIDER): SemanticIndexStatus {
  return statusFromStoredIndex(vault, readStoredIndex(vault, provider), provider)
}

export function rebuildSemanticIndex(
  vault: Vault,
  options: RebuildSemanticIndexOptions = {},
  provider: VectorProvider = LOCAL_PROVIDER,
): RebuildSemanticIndexResult {
  const dryRun = options.dryRun ?? true
  const stored = buildStoredIndex(vault, provider)
  const status = statusFromStoredIndex(vault, stored, provider)

  if (!dryRun) {
    assertCanWriteTool('rebuild_semantic_index', [SEMANTIC_INDEX_FILE])
    atomicWriteJsonSync(indexPath(vault), stored)
    appendActionLog(vault.vaultPath, {
      tool: 'rebuild_semantic_index',
      mode: 'apply',
      targets: [SEMANTIC_INDEX_FILE],
      summary: `Semantic-Index neu aufgebaut (${stored.entries.length} Notes)`,
      meta: {
        provider: provider.name,
        version: SEMANTIC_INDEX_VERSION,
        indexedNotes: stored.entries.length,
      },
    })
  }

  return {
    dryRun,
    path: SEMANTIC_INDEX_FILE,
    provider: provider.name,
    version: SEMANTIC_INDEX_VERSION,
    totalNotes: status.totalNotes,
    indexedNotes: stored.entries.length,
    wouldWrite: dryRun,
    status,
  }
}

export function semanticSearch(
  vault: Vault,
  options: SemanticSearchOptions,
  provider: VectorProvider = LOCAL_PROVIDER,
): SemanticSearchResult[] {
  const query = options.query?.trim()
  if (!query) return []

  const queryVector = provider.vectorizeQuery(query)
  const queryTerms = tokenize(query)
  const limit = options.limit ?? 10
  const minScore = options.minScore ?? 12
  const folder = options.folder?.toLowerCase()
  const requiredTags = options.tags?.map(t => normalizeTerm(t)) ?? []
  const results: SemanticSearchResult[] = []
  const index = options.useIndex === false ? null : indexedVectors(vault, provider)

  for (const [path, entry] of vault.notes) {
    if (!options.includeArchived && path.startsWith('Archiv/')) continue
    if (folder && !path.toLowerCase().startsWith(folder)) continue
    if (requiredTags.length > 0 && !requiredTags.every(tag => entry.tags.map(normalizeTerm).includes(tag))) continue

    const noteVector = index?.get(path) ?? provider.vectorizeNote(path, entry)
    const matches = matchedTerms(queryVector, noteVector)
    if (matches.length === 0) continue

    const coverage = queryTerms.length > 0
      ? queryTerms.filter(term => noteVector.has(term)).length / queryTerms.length
      : 0
    const rawScore = cosine(queryVector, noteVector) * 0.78 + coverage * 0.22
    const score = Math.round(rawScore * 100)
    if (score < minScore) continue

    results.push({
      path,
      title: entry.title,
      score,
      confidence: confidence(score),
      snippet: snippet(entry, matches),
      matchedTerms: matches,
      tags: entry.tags,
      status: entry.frontmatter.status ?? null,
      reasons: reasons(entry, path, matches),
    })
  }

  return results
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
}
