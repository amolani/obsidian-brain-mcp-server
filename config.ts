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
import { sanitizePathSegment } from './services/vault-paths.ts'

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))

export interface ConfigPaths {
  clients: string
  categories: string
  tagAliases: string
  techTerms: string
}

export type ConfigDiagnosticId = keyof ConfigPaths

export interface ConfigDiagnostic {
  id: ConfigDiagnosticId
  label: string
  path: string
  valid: boolean
  entryCount: number
  errors: string[]
  warnings: string[]
}

export function configPaths(): ConfigPaths {
  return {
    clients: process.env.CLIENTS_PATH || join(PROJECT_ROOT, 'clients.json'),
    categories: process.env.TECHNIK_CATEGORIES_PATH || join(PROJECT_ROOT, 'technik-categories.json'),
    tagAliases: process.env.TAG_ALIASES_PATH || join(PROJECT_ROOT, 'tag-aliases.json'),
    techTerms: process.env.TECH_TERMS_PATH || join(PROJECT_ROOT, 'tech-terms.json'),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => isSafeConfigString(item))
}

function isSafeConfigString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function isSafeFolderSegment(value: string): boolean {
  return isSafeConfigString(value)
    && value.length <= 120
    && sanitizePathSegment(value) === value.normalize('NFC')
}

function readConfigForDiagnostic(path: string): { value?: unknown; errors: string[] } {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf-8')), errors: [] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { errors: [`nicht lesbar oder ungültiges JSON: ${message}`] }
  }
}

function diagnoseClients(path: string): ConfigDiagnostic {
  const { value, errors } = readConfigForDiagnostic(path)
  const warnings: string[] = []
  let entryCount = 0
  if (errors.length === 0) {
    if (!isRecord(value)) {
      errors.push('Top-Level muss ein JSON-Objekt sein')
    } else {
      for (const [name, aliases] of Object.entries(value)) {
        if (name.startsWith('_')) continue
        entryCount++
        if (!isSafeFolderSegment(name)) errors.push(`${name || '<leer>'}: Kundenname muss ein sicherer einzelner Ordnername sein`)
        if (!isStringArray(aliases) || aliases.length === 0) errors.push(`${name}: Aliase müssen ein nicht-leeres String-Array sein`)
      }
      if (entryCount === 0) warnings.push('keine Kunden/Aliase konfiguriert')
    }
  }
  return { id: 'clients', label: 'Client config', path, valid: errors.length === 0, entryCount, errors, warnings }
}

function diagnoseCategories(path: string): ConfigDiagnostic {
  const { value, errors } = readConfigForDiagnostic(path)
  const warnings: string[] = []
  let entryCount = 0
  if (errors.length === 0) {
    if (!isRecord(value)) {
      errors.push('Top-Level muss ein JSON-Objekt sein')
    } else {
      for (const [name, rawRule] of Object.entries(value)) {
        if (name.startsWith('_')) continue
        entryCount++
        if (!isSafeFolderSegment(name)) errors.push(`${name || '<leer>'}: Kategoriename muss ein sicherer einzelner Ordnername sein`)
        if (!isRecord(rawRule)) {
          errors.push(`${name}: Kategorie muss ein Objekt sein`)
          continue
        }
        if (rawRule.keywords !== undefined && !isStringArray(rawRule.keywords)) errors.push(`${name}.keywords muss ein String-Array sein`)
        if (rawRule.filenameHints !== undefined && !isStringArray(rawRule.filenameHints)) errors.push(`${name}.filenameHints muss ein String-Array sein`)
        if (rawRule.priority !== undefined && typeof rawRule.priority !== 'number') errors.push(`${name}.priority muss eine Zahl sein`)
        if (rawRule.subcategories !== undefined && !isRecord(rawRule.subcategories)) {
          errors.push(`${name}.subcategories muss ein Objekt sein`)
          continue
        }
        for (const [subName, rawSub] of Object.entries(isRecord(rawRule.subcategories) ? rawRule.subcategories : {})) {
          if (!isSafeFolderSegment(subName)) errors.push(`${name}.${subName || '<leer>'}: Unterkategoriename muss ein sicherer einzelner Ordnername sein`)
          if (!isRecord(rawSub)) {
            errors.push(`${name}.${subName}: Unterkategorie muss ein Objekt sein`)
            continue
          }
          if (rawSub.keywords !== undefined && !isStringArray(rawSub.keywords)) errors.push(`${name}.${subName}.keywords muss ein String-Array sein`)
          if (rawSub.filenameHints !== undefined && !isStringArray(rawSub.filenameHints)) errors.push(`${name}.${subName}.filenameHints muss ein String-Array sein`)
        }
      }
      if (entryCount === 0) warnings.push('keine Technik-Kategorien konfiguriert')
    }
  }
  return { id: 'categories', label: 'Category config', path, valid: errors.length === 0, entryCount, errors, warnings }
}

function diagnoseTagAliases(path: string): ConfigDiagnostic {
  const { value, errors } = readConfigForDiagnostic(path)
  const warnings: string[] = []
  let entryCount = 0
  if (errors.length === 0) {
    if (!isRecord(value)) {
      errors.push('Top-Level muss ein JSON-Objekt sein')
    } else {
      for (const [alias, canonical] of Object.entries(value)) {
        if (alias.startsWith('_')) continue
        entryCount++
        if (!isSafeConfigString(alias)) errors.push(`${alias || '<leer>'}: Tag-Alias muss ein nicht-leerer einzeiliger String sein`)
        if (!isSafeConfigString(canonical)) errors.push(`${alias}: Ziel-Tag muss ein nicht-leerer einzeiliger String sein`)
      }
      if (entryCount === 0) warnings.push('keine Tag-Aliase konfiguriert')
    }
  }
  return { id: 'tagAliases', label: 'Tag alias config', path, valid: errors.length === 0, entryCount, errors, warnings }
}

function diagnoseTechTerms(path: string): ConfigDiagnostic {
  const { value, errors } = readConfigForDiagnostic(path)
  const warnings: string[] = []
  const terms = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.terms)
      ? value.terms
      : null
  if (errors.length === 0 && !terms) errors.push('Top-Level muss ein Array oder ein Objekt mit terms-Array sein')
  if (terms && !isStringArray(terms)) errors.push('Technikbegriffe müssen nicht-leere Strings sein')
  const entryCount = terms?.length ?? 0
  if (errors.length === 0 && entryCount === 0) warnings.push('keine Technikbegriffe konfiguriert')
  return { id: 'techTerms', label: 'Tech terms config', path, valid: errors.length === 0, entryCount, errors, warnings }
}

export function diagnoseConfigFiles(): ConfigDiagnostic[] {
  const paths = configPaths()
  return [
    diagnoseClients(paths.clients),
    diagnoseCategories(paths.categories),
    diagnoseTagAliases(paths.tagAliases),
    diagnoseTechTerms(paths.techTerms),
  ]
}

// ── Clients ────────────────────────────────────────────────────────

let cachedClients: Record<string, string> | null = null

// Returns { keyword (lowercase) → canonicalName }
export function loadClients(): Record<string, string> {
  if (cachedClients) return cachedClients
  const map: Record<string, string> = {}
  try {
    const path = configPaths().clients
    if (!diagnoseClients(path).valid) throw new Error('Ungültige Client-Konfiguration')
    const raw = readFileSync(path, 'utf-8')
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
    const path = configPaths().categories
    if (!diagnoseCategories(path).valid) throw new Error('Ungültige Kategorie-Konfiguration')
    const raw = readFileSync(path, 'utf-8')
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
    const path = configPaths().tagAliases
    if (!diagnoseTagAliases(path).valid) throw new Error('Ungültige Tag-Alias-Konfiguration')
    const raw = readFileSync(path, 'utf-8')
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
    const path = configPaths().techTerms
    if (!diagnoseTechTerms(path).valid) throw new Error('Ungültige Technikbegriff-Konfiguration')
    const raw = readFileSync(path, 'utf-8')
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
