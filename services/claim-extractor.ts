import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter, normalizeTag } from './frontmatter-linter.ts'
import { assertCanWriteTool } from './policy.ts'
import { sanitizePathSegment, uniqueRelativePath, vaultJoin } from './vault-paths.ts'

export interface ExtractClaimsOptions {
  path: string
  maxClaims?: number
  dryRun?: boolean
}

export interface ExtractedClaim {
  claim: string
  source: string
  confidence: 'low' | 'medium' | 'high'
  contradictionCandidates: string[]
}

export interface ExtractClaimsResult {
  dryRun: boolean
  source: string
  claims: ExtractedClaim[]
  written: string[]
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function readSource(vault: Vault, path: string): { source: string; content: string } {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '')
  const note = vault.notes.get(clean)
  if (note) return { source: note.relativePath, content: note.content }
  const rawPath = vaultJoin(vault.vaultPath, clean)
  if (!existsSync(rawPath)) throw new Error(`Quelle nicht gefunden: ${path}`)
  return { source: clean, content: readFileSync(rawPath, 'utf-8') }
}

function claimSentences(content: string, maxClaims: number): string[] {
  const candidates = content
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n|(?<=[.!?])\s+/)
    .map(line => line.replace(/^[-*#\s>\d.]+/, '').trim())
    .filter(line => line.length >= 25 && line.length <= 260)
    .filter(line => /\b(muss|soll|sollte|ist|sind|wird|werden|braucht|benötigt|benoetigt|should|must|needs|required|requires)\b/i.test(line))
  return [...new Set(candidates)].slice(0, maxClaims)
}

function hasNegation(value: string): boolean {
  return /\b(nicht|kein|keine|never|not|no)\b/i.test(value)
}

function importantTerms(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(term => term.length >= 5)
    .filter(term => !['sollte', 'werden', 'braucht', 'required', 'requires'].includes(term))
    .slice(0, 10)
}

function contradictionCandidates(vault: Vault, claim: string): string[] {
  const terms = new Set(importantTerms(claim))
  const negated = hasNegation(claim)
  const candidates: string[] = []
  for (const note of vault.notes.values()) {
    if (!note.relativePath.startsWith('Knowledge/Claims/') && !note.tags.includes('claim')) continue
    const overlap = importantTerms(note.content).filter(term => terms.has(term)).length
    if (overlap >= 2 && hasNegation(note.content) !== negated) candidates.push(note.relativePath)
  }
  return candidates.slice(0, 5)
}

function renderClaimNote(claim: ExtractedClaim): string {
  const contradictions = claim.contradictionCandidates.length > 0
    ? claim.contradictionCandidates.map(path => `- [[${path}|${basename(path, '.md')}]]`).join('\n')
    : '- Keine erkannt'
  return `---\n${buildFrontmatter({
    status: 'aktiv',
    tags: ['claim', 'evidence'].map(normalizeTag),
    datum: today(),
    quelle: claim.source,
    confidence: claim.confidence,
    checked_at: today(),
    contradicted_by: claim.contradictionCandidates,
  })}---\n\n# Claim: ${claim.claim.slice(0, 80)}\n\n${claim.claim}\n\n## Quelle\n\n[[${claim.source}|${basename(claim.source)}]]\n\n## Potenzielle Widersprüche\n\n${contradictions}\n`
}

export function extractClaims(vault: Vault, options: ExtractClaimsOptions): ExtractClaimsResult {
  const dryRun = options.dryRun ?? true
  const { source, content } = readSource(vault, options.path)
  const claims = claimSentences(content, Math.max(1, Math.min(options.maxClaims ?? 8, 20))).map(claim => ({
    claim,
    source,
    confidence: 'medium' as const,
    contradictionCandidates: contradictionCandidates(vault, claim),
  }))
  const written: string[] = []

  if (!dryRun && claims.length > 0) {
    const paths = claims.map(claim => `Knowledge/Claims/${sanitizePathSegment(claim.claim.slice(0, 80))}.md`)
    assertCanWriteTool('extract_claims', paths)
    mkdirSync(vaultJoin(vault.vaultPath, 'Knowledge/Claims'), { recursive: true })
    for (const claim of claims) {
      const path = uniqueRelativePath(vault.vaultPath, 'Knowledge/Claims', `${sanitizePathSegment(claim.claim.slice(0, 80))}.md`)
      const fullPath = vaultJoin(vault.vaultPath, path)
      writeFileSync(fullPath, renderClaimNote(claim), 'utf-8')
      vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
      written.push(path)
    }
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'extract_claims',
      mode: 'apply',
      targets: [source, ...written],
      summary: `${written.length} Claim(s) aus ${source} extrahiert`,
      meta: { claimCount: written.length },
    })
  }

  return { dryRun, source, claims, written }
}
