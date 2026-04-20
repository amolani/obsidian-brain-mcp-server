// Technik-Kategorisierung mit Haupt- und Unterkategorien
// Regeln werden aus technik-categories.json geladen (editable)
// Unbekannte Topics werden als Vorschläge geloggt

import { readFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))
const CATEGORIES_JSON = process.env.TECHNIK_CATEGORIES_PATH || join(PROJECT_ROOT, 'technik-categories.json')
const SUGGESTIONS_LOG = process.env.TECHNIK_SUGGESTIONS_LOG || '/tmp/technik-suggestions.log'

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

let CACHED_CATEGORIES: CategoryRule[] | null = null

export function loadCategories(): CategoryRule[] {
  if (CACHED_CATEGORIES) return CACHED_CATEGORIES
  try {
    const raw = readFileSync(CATEGORIES_JSON, 'utf-8')
    const data = JSON.parse(raw)
    const categories: CategoryRule[] = []
    for (const [name, rule] of Object.entries<any>(data)) {
      if (name.startsWith('_')) continue
      categories.push({
        name,
        keywords: rule.keywords || [],
        filenameHints: rule.filenameHints || [],
        priority: rule.priority || 0,
        subcategories: rule.subcategories || {},
      })
    }
    CACHED_CATEGORIES = categories
    return categories
  } catch {
    return []
  }
}

export interface Classification {
  category: string | null
  subcategory: string | null
  confidence: number
  reason: string
  topicCandidates: string[] // potentielle neue Unterkategorien aus Content
}

// Detect potential new sub-topics from content (hyphenated product/service names)
// Strict filtering: only hyphenated names that look like proper nouns/products
function extractTopicCandidates(title: string, content: string): string[] {
  const combined = `${title}\n${content.slice(0, 3000)}`
  const candidates = new Set<string>()

  // Skip patterns: technical noise, commands, paths, temp names
  const noisePatterns = [
    /^(add|del|get|set|put|post|update|create|remove|make|do|run|exec|cmd|opt|arg|env|var|val|key|str|num|int|bool|obj|arr|map|fn|func)-/,
    /-(json|yaml|yml|toml|txt|md|sh|py|ts|js|conf|cfg|ini|log|tmp|bak|old|new)$/,
    /^(disk|drive|part|fs|mnt|dir|file|path|node|host|addr|port|proto|dest|src|tgt|conn|sock|fd)-/,
    /-\d+$/, // disk-1, node-2
    /^(my|your|our|the|a|an|some|any|all|none|each)-/,
    /^([a-z]{1,2})-/, // 2-letter prefixes like "js-"
  ]

  // Hyphenated compound names (need 2+ meaningful parts)
  const hyphenated = combined.matchAll(/\b([a-zäöüß][a-z0-9äöüß]{3,}(?:-[a-zäöüß][a-z0-9äöüß]{2,}){1,2})\b/gi)
  for (const m of hyphenated) {
    const word = m[1].toLowerCase()
    if (word.length < 8 || word.length > 30) continue
    if (noisePatterns.some(p => p.test(word))) continue
    // Each part must have at least 3 chars
    if (word.split('-').some(p => p.length < 3)) continue
    candidates.add(word)
  }

  return [...candidates].slice(0, 20)
}

function logSuggestion(topic: string, candidate: string, context: string): void {
  try {
    const msg = `${new Date().toISOString()} VORSCHLAG Unterkategorie: "${candidate}" unter ${topic}\n` +
                `  Pfad: Technik/${topic}/${candidate.charAt(0).toUpperCase() + candidate.slice(1)}/\n` +
                `  Kontext: ${context.slice(0, 150)}\n` +
                `  → In technik-categories.json unter "${topic}"."subcategories" hinzufügen\n\n`
    appendFileSync(SUGGESTIONS_LOG, msg)
  } catch {}
}

export function classifyNote(
  title: string,
  content: string,
  tags: string[]
): Classification {
  const categories = loadCategories()
  const titleLower = title.toLowerCase()
  const contentLower = content.toLowerCase()
  const tagsLower = tags.map(t => t.toLowerCase())

  let bestMain: { rule: CategoryRule; score: number; reasons: string[] } | null = null

  // 1. Find best MAIN category
  for (const cat of categories) {
    let score = 0
    const reasons: string[] = []

    // Tag matches - check both direct tags and tag/subtag hierarchy
    const tagHits = cat.keywords.filter(k => tagsLower.includes(k))
    for (const t of tagsLower) {
      if (t.includes('/')) {
        const parent = t.split('/')[0]
        if (cat.keywords.includes(parent) && !tagHits.includes(parent)) tagHits.push(parent)
      }
    }
    if (tagHits.length > 0) {
      score += tagHits.length * 10
      reasons.push(`tags: ${tagHits.join(',')}`)
    }

    // Filename matches (dominant)
    const fnHits = cat.filenameHints.filter(h => titleLower.includes(h))
    if (fnHits.length > 0) {
      score += fnHits.length * 25
      reasons.push(`filename: ${fnHits.join(',')}`)
    }

    // Content keyword matches (need >= 3)
    let contentHitCount = 0
    for (const kw of cat.keywords) {
      if (contentLower.includes(kw)) contentHitCount++
    }
    if (contentHitCount >= 3) {
      score += contentHitCount * 2
      reasons.push(`content: ${contentHitCount} hits`)
    }

    const finalScore = score + cat.priority * 0.1

    if (finalScore > (bestMain?.score ?? 0) && score >= 5) {
      bestMain = { rule: cat, score: finalScore, reasons }
    }
  }

  if (!bestMain) {
    return { category: null, subcategory: null, confidence: 0, reason: '', topicCandidates: [] }
  }

  // 2. Within main category, find best SUBCATEGORY
  const cat = bestMain.rule
  let bestSub: { name: string; score: number } | null = null

  for (const [subName, subRule] of Object.entries(cat.subcategories)) {
    let score = 0

    // Hierarchical tag: linuxmuster/linbo
    const hierTag = `${cat.name.toLowerCase()}/${subName.toLowerCase()}`
    if (tagsLower.includes(hierTag)) score += 30

    // Direct tag matches
    const tagHits = subRule.keywords.filter(k => tagsLower.includes(k))
    score += tagHits.length * 10

    // Filename
    const fnHits = subRule.filenameHints.filter(h => titleLower.includes(h))
    score += fnHits.length * 20

    // Content keywords (2+ needed for sub)
    let contentHits = 0
    for (const kw of subRule.keywords) {
      if (contentLower.includes(kw)) contentHits++
    }
    if (contentHits >= 2) score += contentHits * 3

    if (score >= 10 && score > (bestSub?.score ?? 0)) {
      bestSub = { name: subName, score }
    }
  }

  // 3. Extract topic candidates for suggestion
  const candidates = extractTopicCandidates(title, content)
  const knownSubKeywords = new Set<string>()
  for (const [subName, subRule] of Object.entries(cat.subcategories)) {
    knownSubKeywords.add(subName.toLowerCase())
    for (const k of subRule.keywords) knownSubKeywords.add(k.toLowerCase())
    for (const h of subRule.filenameHints) knownSubKeywords.add(h.toLowerCase())
  }

  const newCandidates: string[] = []
  for (const cand of candidates) {
    // Skip if already a known keyword (or contains one)
    if (knownSubKeywords.has(cand)) continue
    if ([...knownSubKeywords].some(k => k.length > 4 && (cand.includes(k) || k.includes(cand)))) continue
    // Only suggest if mentioned frequently (>= 3 times in content)
    const count = (contentLower.match(new RegExp(cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
    if (count >= 3) newCandidates.push(cand)
  }

  // Log top 3 suggestions if no subcategory matched
  if (!bestSub && newCandidates.length > 0) {
    for (const cand of newCandidates.slice(0, 3)) {
      logSuggestion(cat.name, cand, title)
    }
  }

  return {
    category: cat.name,
    subcategory: bestSub?.name ?? null,
    confidence: bestMain.score,
    reason: [...bestMain.reasons, bestSub ? `sub: ${bestSub.name}` : ''].filter(Boolean).join(' | '),
    topicCandidates: newCandidates.slice(0, 5),
  }
}
