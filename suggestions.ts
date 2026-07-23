// Aggregates suggestions from harvester logs and promotes them to config files.
// Suggestion sources:
//   - /tmp/technik-suggestions.log        (Technik-Unterkategorien)
//   - /tmp/knowledge-harvester-suggestions.log  (Kunden)

import { existsSync, readFileSync } from 'node:fs'
import { configPaths, diagnoseConfigFiles, reloadConfig } from './config.ts'
import { atomicWriteFileSync, atomicWriteJsonSync } from './services/atomic-file.ts'
import { assertCanWriteTool } from './services/policy.ts'
import { sanitizePathSegment } from './services/vault-paths.ts'

// Resolved on each call so tests (and runtime env changes) work correctly
function paths() {
  const cfg = configPaths()
  return {
    technikLog: process.env.TECHNIK_SUGGESTIONS_LOG || '/tmp/technik-suggestions.log',
    clientLog: process.env.HARVESTER_SUGGESTIONS_LOG || '/tmp/knowledge-harvester-suggestions.log',
    categoriesJson: cfg.categories,
    clientsJson: cfg.clients,
  }
}

export interface TechnikSuggestion {
  parent: string           // main category (e.g. "Linuxmuster")
  candidate: string        // proposed subname (e.g. "obsidian-brain-mcp")
  count: number            // how often it was suggested
  contexts: string[]       // last few contexts (note titles)
  lastSeen: string         // ISO timestamp
}

export interface ClientSuggestion {
  candidate: string        // proposed client keyword
  count: number
  contexts: string[]       // CWD paths where encountered
  lastSeen: string
}

export interface AllSuggestions {
  technik: TechnikSuggestion[]
  clients: ClientSuggestion[]
}

export interface PromoteSuggestionOptions {
  dryRun?: boolean
}

export interface PromoteTechnikSuggestionResult {
  path: string
  category: string
  subcategory: string
  existed: boolean
  dryRun: boolean
}

export interface PromoteClientSuggestionResult {
  path: string
  name: string
  existed: boolean
  dryRun: boolean
}

// ── Parse Logs ─────────────────────────────────────────────────────

function parseTechnikLog(): TechnikSuggestion[] {
  const { technikLog } = paths()
  if (!existsSync(technikLog)) return []
  let raw: string
  try { raw = readFileSync(technikLog, 'utf-8') } catch { return [] }

  // Each suggestion block looks like:
  // 2026-04-20T08:37:33.008Z VORSCHLAG Unterkategorie: "candidate" unter Parent
  //   Pfad: Technik/Parent/...
  //   Kontext: some context
  //   → ...
  //
  const pattern = /^(\d{4}-\d{2}-\d{2}T[\d:.Z]+) VORSCHLAG Unterkategorie: "([^"]+)" unter (\S+)\s+Pfad:[^\n]+\n\s+Kontext: ([^\n]+)/gm

  const buckets = new Map<string, TechnikSuggestion>()
  for (const m of raw.matchAll(pattern)) {
    const [, ts, candidate, parent, context] = m
    const key = `${parent}::${candidate.toLowerCase()}`
    if (!buckets.has(key)) {
      buckets.set(key, { parent, candidate, count: 0, contexts: [], lastSeen: ts })
    }
    const b = buckets.get(key)!
    b.count++
    if (!b.contexts.includes(context)) b.contexts.push(context)
    if (ts > b.lastSeen) b.lastSeen = ts
  }

  return [...buckets.values()].sort((a, b) => b.count - a.count)
}

function parseClientLog(): ClientSuggestion[] {
  const { clientLog } = paths()
  if (!existsSync(clientLog)) return []
  let raw: string
  try { raw = readFileSync(clientLog, 'utf-8') } catch { return [] }

  // Each suggestion:
  // 2026-04-18T17:41:57.677Z VORSCHLAG: "candidate" als Kunde registrieren? (Pfad: /some/path)
  //   → ...
  //
  const pattern = /^(\d{4}-\d{2}-\d{2}T[\d:.Z]+) VORSCHLAG: "([^"]+)" als Kunde registrieren\? \(Pfad: ([^)]+)\)/gm

  const buckets = new Map<string, ClientSuggestion>()
  for (const m of raw.matchAll(pattern)) {
    const [, ts, candidate, path] = m
    const key = candidate.toLowerCase()
    if (!buckets.has(key)) {
      buckets.set(key, { candidate, count: 0, contexts: [], lastSeen: ts })
    }
    const b = buckets.get(key)!
    b.count++
    if (!b.contexts.includes(path)) b.contexts.push(path)
    if (ts > b.lastSeen) b.lastSeen = ts
  }

  return [...buckets.values()].sort((a, b) => b.count - a.count)
}

export function listSuggestions(): AllSuggestions {
  return {
    technik: parseTechnikLog(),
    clients: parseClientLog(),
  }
}

// ── Promote Suggestions (write to JSON) ─────────────────────────────

function safeLabel(value: string, label: string): string {
  const cleaned = value.trim().normalize('NFC')
  if (!cleaned) throw new Error(`${label} darf nicht leer sein`)
  if (cleaned.length > 120) throw new Error(`${label} ist zu lang`)
  if (sanitizePathSegment(cleaned) !== cleaned || ['.', '..', '__proto__', 'prototype', 'constructor'].includes(cleaned.toLowerCase())) {
    throw new Error(`${label} enthält einen ungültigen Namen`)
  }
  return cleaned
}

function cleanKeywords(values: string[]): string[] {
  return values.map(value => {
    const cleaned = value.trim().normalize('NFC')
    if (!cleaned || cleaned.length > 200 || /[\u0000-\u001f\u007f]/.test(cleaned)) {
      throw new Error('Keywords müssen nicht-leere einzeilige Strings mit höchstens 200 Zeichen sein')
    }
    return cleaned
  })
}

function assertConfigValid(id: 'clients' | 'categories'): void {
  const diagnostic = diagnoseConfigFiles().find(item => item.id === id)
  if (!diagnostic?.valid) {
    throw new Error(`${diagnostic?.label ?? id} ist ungültig: ${diagnostic?.errors.join('; ') ?? 'Diagnose fehlt'}`)
  }
}

export function promoteTechnikSuggestion(
  parent: string,
  candidate: string,
  canonical?: string,
  extraKeywords: string[] = [],
  extraFilenameHints: string[] = [],
  options: PromoteSuggestionOptions = {},
): PromoteTechnikSuggestionResult {
  const parentName = safeLabel(parent, 'parent')
  const candidateName = safeLabel(candidate, 'candidate')
  const dryRun = options.dryRun ?? true
  const { categoriesJson } = paths()
  assertConfigValid('categories')
  const raw = readFileSync(categoriesJson, 'utf-8')
  const data = JSON.parse(raw) as Record<string, any>

  if (!Object.hasOwn(data, parentName) || !data[parentName] || typeof data[parentName] !== 'object') {
    throw new Error(`Hauptkategorie "${parentName}" existiert nicht. Gültige: ${Object.keys(data).filter(k => !k.startsWith('_')).join(', ')}`)
  }

  const subName = safeLabel(canonical ?? titleCase(candidateName), 'canonical')

  if (!data[parentName].subcategories) data[parentName].subcategories = {}
  if (!data[parentName].subcategories || typeof data[parentName].subcategories !== 'object' || Array.isArray(data[parentName].subcategories)) {
    throw new Error(`Hauptkategorie "${parentName}" hat ungültige subcategories`)
  }
  const existed = Object.hasOwn(data[parentName].subcategories, subName)

  // Merge: preserve existing keywords if sub already exists
  const existing = data[parentName].subcategories[subName] || {}
  const keywords = [...new Set([...(Array.isArray(existing.keywords) ? existing.keywords : []), candidateName.toLowerCase(), ...cleanKeywords(extraKeywords)])]
  const filenameHints = [...new Set([...(Array.isArray(existing.filenameHints) ? existing.filenameHints : []), candidateName.toLowerCase(), ...cleanKeywords(extraFilenameHints)])]

  data[parentName].subcategories[subName] = { keywords, filenameHints }

  if (!dryRun) {
    assertCanWriteTool('promote_suggestion')
    atomicWriteJsonSync(categoriesJson, data)
    reloadConfig()

    // Clear matching entries from suggestions log so they don't resurface
    clearTechnikSuggestion(parentName, candidateName)
  }

  return { path: categoriesJson, category: parentName, subcategory: subName, existed, dryRun }
}

export function promoteClientSuggestion(
  candidate: string,
  canonical?: string,
  extraKeywords: string[] = [],
  options: PromoteSuggestionOptions = {},
): PromoteClientSuggestionResult {
  const candidateName = safeLabel(candidate, 'candidate')
  const dryRun = options.dryRun ?? true
  const { clientsJson } = paths()
  assertConfigValid('clients')
  const raw = readFileSync(clientsJson, 'utf-8')
  const data = JSON.parse(raw) as Record<string, any>

  const name = safeLabel(canonical ?? titleCase(candidateName), 'canonical')

  const existed = Object.hasOwn(data, name)
  const existing = Array.isArray(data[name]) ? data[name] as string[] : []
  const keywords = [...new Set([...existing, candidateName.toLowerCase(), ...cleanKeywords(extraKeywords)])]

  data[name] = keywords

  if (!dryRun) {
    assertCanWriteTool('promote_suggestion')
    atomicWriteJsonSync(clientsJson, data)
    reloadConfig()

    clearClientSuggestion(candidateName)
  }

  return { path: clientsJson, name, existed, dryRun }
}

// ── Clear specific entries from suggestion logs ────────────────────

function clearTechnikSuggestion(parent: string, candidate: string): void {
  const { technikLog } = paths()
  if (!existsSync(technikLog)) return
  try {
    const content = readFileSync(technikLog, 'utf-8')
    const candLower = candidate.toLowerCase()
    const blocks = content.split(/\n\n+/)
    const kept = blocks.filter(block => {
      if (!block.includes('VORSCHLAG Unterkategorie')) return true
      const match = block.match(/"([^"]+)"\s+unter\s+(\S+)/)
      if (!match) return true
      const [, cand, par] = match
      return !(cand.toLowerCase() === candLower && par === parent)
    })
    atomicWriteFileSync(technikLog, kept.join('\n\n'))
  } catch { /* ignore */ }
}

function clearClientSuggestion(candidate: string): void {
  const { clientLog } = paths()
  if (!existsSync(clientLog)) return
  try {
    const content = readFileSync(clientLog, 'utf-8')
    const candLower = candidate.toLowerCase()
    const blocks = content.split(/\n\n+/)
    const kept = blocks.filter(block => {
      if (!block.includes('als Kunde registrieren')) return true
      const match = block.match(/"([^"]+)"\s+als Kunde/)
      if (!match) return true
      return match[1].toLowerCase() !== candLower
    })
    atomicWriteFileSync(clientLog, kept.join('\n\n'))
  } catch { /* ignore */ }
}

function titleCase(s: string): string {
  return s.split(/[-_\s]+/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-')
}
