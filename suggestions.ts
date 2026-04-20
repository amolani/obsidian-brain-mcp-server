// Aggregates suggestions from harvester logs and promotes them to config files.
// Suggestion sources:
//   - /tmp/technik-suggestions.log        (Technik-Unterkategorien)
//   - /tmp/knowledge-harvester-suggestions.log  (Kunden)

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))

// Resolved on each call so tests (and runtime env changes) work correctly
function paths() {
  return {
    technikLog: process.env.TECHNIK_SUGGESTIONS_LOG || '/tmp/technik-suggestions.log',
    clientLog: process.env.HARVESTER_SUGGESTIONS_LOG || '/tmp/knowledge-harvester-suggestions.log',
    categoriesJson: process.env.TECHNIK_CATEGORIES_PATH || join(PROJECT_ROOT, 'technik-categories.json'),
    clientsJson: process.env.CLIENTS_PATH || join(PROJECT_ROOT, 'clients.json'),
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

export function promoteTechnikSuggestion(
  parent: string,
  candidate: string,
  canonical?: string,
  extraKeywords: string[] = [],
  extraFilenameHints: string[] = [],
): { path: string; category: string; subcategory: string; existed: boolean } {
  const { categoriesJson } = paths()
  const raw = readFileSync(categoriesJson, 'utf-8')
  const data = JSON.parse(raw) as Record<string, any>

  if (!data[parent]) {
    throw new Error(`Hauptkategorie "${parent}" existiert nicht. Gültige: ${Object.keys(data).filter(k => !k.startsWith('_')).join(', ')}`)
  }

  const subName = canonical ?? titleCase(candidate)

  if (!data[parent].subcategories) data[parent].subcategories = {}
  const existed = !!data[parent].subcategories[subName]

  // Merge: preserve existing keywords if sub already exists
  const existing = data[parent].subcategories[subName] || {}
  const keywords = [...new Set([...(existing.keywords ?? []), candidate.toLowerCase(), ...extraKeywords])]
  const filenameHints = [...new Set([...(existing.filenameHints ?? []), candidate.toLowerCase(), ...extraFilenameHints])]

  data[parent].subcategories[subName] = { keywords, filenameHints }

  writeFileSync(categoriesJson, JSON.stringify(data, null, 2) + '\n', 'utf-8')

  // Clear matching entries from suggestions log so they don't resurface
  clearTechnikSuggestion(parent, candidate)

  return { path: categoriesJson, category: parent, subcategory: subName, existed }
}

export function promoteClientSuggestion(
  candidate: string,
  canonical?: string,
  extraKeywords: string[] = [],
): { path: string; name: string; existed: boolean } {
  const { clientsJson } = paths()
  const raw = readFileSync(clientsJson, 'utf-8')
  const data = JSON.parse(raw) as Record<string, any>

  const name = canonical ?? titleCase(candidate)

  const existed = !!data[name]
  const existing = Array.isArray(data[name]) ? data[name] as string[] : []
  const keywords = [...new Set([...existing, candidate.toLowerCase(), ...extraKeywords])]

  data[name] = keywords

  writeFileSync(clientsJson, JSON.stringify(data, null, 2) + '\n', 'utf-8')

  clearClientSuggestion(candidate)

  return { path: clientsJson, name, existed }
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
    writeFileSync(technikLog, kept.join('\n\n'), 'utf-8')
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
    writeFileSync(clientLog, kept.join('\n\n'), 'utf-8')
  } catch { /* ignore */ }
}

function titleCase(s: string): string {
  return s.split(/[-_\s]+/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-')
}
