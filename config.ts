// Unified config loader. Single source of truth for:
//   - clients.json        → Map<keyword, canonicalName>
//   - technik-categories.json → CategoryRule[]
//   - tag-aliases.json    → Map<alias, canonicalTag>
//   - tech-terms.json     → string[] (auto-tag terms)
//
// Paths resolve env vars on each configPaths() call; loaded data is cached.
// Call reloadConfig() to clear caches (e.g. after config files are edited).

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))

export interface ConfigPaths {
  clients: string
  categories: string
  tagAliases: string
  techTerms: string
}

export function configPaths(): ConfigPaths {
  return {
    clients: process.env.CLIENTS_PATH || join(PROJECT_ROOT, 'clients.json'),
    categories: process.env.TECHNIK_CATEGORIES_PATH || join(PROJECT_ROOT, 'technik-categories.json'),
    tagAliases: process.env.TAG_ALIASES_PATH || join(PROJECT_ROOT, 'tag-aliases.json'),
    techTerms: process.env.TECH_TERMS_PATH || join(PROJECT_ROOT, 'tech-terms.json'),
  }
}

// ── Clients ────────────────────────────────────────────────────────

let cachedClients: Record<string, string> | null = null

// Returns { keyword (lowercase) → canonicalName }
export function loadClients(): Record<string, string> {
  if (cachedClients) return cachedClients
  const map: Record<string, string> = {}
  try {
    const raw = readFileSync(configPaths().clients, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>
    for (const [canonical, keywords] of Object.entries(data)) {
      if (canonical.startsWith('_')) continue
      if (!Array.isArray(keywords)) continue
      for (const kw of keywords) {
        if (typeof kw === 'string') map[kw.toLowerCase()] = canonical
      }
    }
  } catch {}
  cachedClients = map
  return map
}

// ── Categories ─────────────────────────────────────────────────────

export interface SubCategoryRule {
  keywords: string[]
  filenameHints: string[]
}

export interface CategoryRule {
  name: string
  keywords: string[]
  filenameHints: string[]
  priority: number
  subcategories: Record<string, SubCategoryRule>
}

let cachedCategories: CategoryRule[] | null = null

export function loadCategories(): CategoryRule[] {
  if (cachedCategories) return cachedCategories
  try {
    const raw = readFileSync(configPaths().categories, 'utf-8')
    const data = JSON.parse(raw) as Record<string, any>
    const categories: CategoryRule[] = []
    for (const [name, rule] of Object.entries(data)) {
      if (name.startsWith('_')) continue
      categories.push({
        name,
        keywords: rule.keywords || [],
        filenameHints: rule.filenameHints || [],
        priority: rule.priority || 0,
        subcategories: rule.subcategories || {},
      })
    }
    cachedCategories = categories
  } catch {
    cachedCategories = []
  }
  return cachedCategories
}

// ── Tag aliases ────────────────────────────────────────────────────

let cachedTagAliases: Record<string, string> | null = null

export function loadTagAliases(): Record<string, string> {
  if (cachedTagAliases) return cachedTagAliases
  const map: Record<string, string> = {}
  try {
    const raw = readFileSync(configPaths().tagAliases, 'utf-8')
    const data = JSON.parse(raw) as Record<string, unknown>
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('_') || typeof v !== 'string') continue
      map[k.toLowerCase()] = v.toLowerCase()
    }
  } catch {}
  cachedTagAliases = map
  return map
}

// ── Tech terms (auto-tag vocabulary) ───────────────────────────────

let cachedTechTerms: string[] | null = null

export function loadTechTerms(): string[] {
  if (cachedTechTerms) return cachedTechTerms
  try {
    const raw = readFileSync(configPaths().techTerms, 'utf-8')
    const data = JSON.parse(raw)
    let terms: string[] = []
    if (Array.isArray(data)) {
      terms = data
    } else if (data && Array.isArray(data.terms)) {
      terms = data.terms
    }
    cachedTechTerms = terms.filter((t: unknown): t is string => typeof t === 'string').map(t => t.toLowerCase())
  } catch {
    cachedTechTerms = []
  }
  return cachedTechTerms
}

// ── Cache control ──────────────────────────────────────────────────

export function reloadConfig(): void {
  cachedClients = null
  cachedCategories = null
  cachedTagAliases = null
  cachedTechTerms = null
}
