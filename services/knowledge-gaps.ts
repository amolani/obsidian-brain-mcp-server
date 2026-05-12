import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter, normalizeTag } from './frontmatter-linter.ts'
import { parseFrontmatter, stripFrontmatter } from './note-parser.ts'
import { assertCanWriteTool } from './policy.ts'
import { sanitizePathSegment, uniqueRelativePath, vaultJoin } from './vault-paths.ts'

export interface FlagKnowledgeGapOptions {
  question: string
  context?: string
  tags?: string[]
  dryRun?: boolean
}

export interface FlagContradictionOptions {
  title: string
  claimA: string
  claimB: string
  sources?: string[]
  dryRun?: boolean
}

export interface ResolveGapOptions {
  path: string
  resolution: string
  dryRun?: boolean
}

export interface KnowledgeGapResult {
  dryRun: boolean
  path: string
  title: string
  content: string
}

export interface OpenQuestion {
  path: string
  title: string
  type: 'gap' | 'contradiction'
  tags: string[]
  context: string
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function renderFrontmatter(type: 'gap' | 'contradiction', tags: string[]): string {
  return `---\n${buildFrontmatter({
    status: 'open',
    tags,
    datum: today(),
    type,
  })}---\n\n`
}

export function flagKnowledgeGap(vault: Vault, options: FlagKnowledgeGapOptions): KnowledgeGapResult {
  const dryRun = options.dryRun ?? true
  const question = options.question.trim()
  if (!question) throw new Error('Frage darf nicht leer sein')

  const tags = [...new Set(['knowledge-gap', 'open-question', ...(options.tags ?? [])].map(normalizeTag))]
  const title = question.endsWith('?') ? question : `${question}?`
  const path = dryRun
    ? `Knowledge/Gaps/${sanitizePathSegment(title)}.md`
    : uniqueRelativePath(vault.vaultPath, 'Knowledge/Gaps', `${sanitizePathSegment(title)}.md`)
  const context = options.context?.trim() || '- Noch kein Kontext erfasst'
  const content = `${renderFrontmatter('gap', tags)}# Wissenslücke: ${title}\n\n## Frage\n\n${title}\n\n## Kontext\n\n${context}\n\n## Nächste Klärung\n\n- [ ] Recherche oder Vault-Kontext ergänzen\n`

  if (!dryRun) {
    assertCanWriteTool('flag_knowledge_gap', [path])
    const fullPath = vaultJoin(vault.vaultPath, path)
    mkdirSync(vaultJoin(vault.vaultPath, 'Knowledge/Gaps'), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'flag_knowledge_gap',
      mode: 'apply',
      targets: [path],
      summary: `Wissenslücke erfasst: ${title}`,
      meta: { tags },
    })
  }

  return { dryRun, path, title, content }
}

export function flagContradiction(vault: Vault, options: FlagContradictionOptions): KnowledgeGapResult {
  const dryRun = options.dryRun ?? true
  const title = options.title.trim()
  if (!title) throw new Error('Titel darf nicht leer sein')
  if (!options.claimA?.trim() || !options.claimB?.trim()) throw new Error('Beide Aussagen müssen gesetzt sein')

  const path = dryRun
    ? `Knowledge/Contradictions/${sanitizePathSegment(title)}.md`
    : uniqueRelativePath(vault.vaultPath, 'Knowledge/Contradictions', `${sanitizePathSegment(title)}.md`)
  const tags = ['contradiction', 'open-question'].map(normalizeTag)
  const sources = options.sources?.length
    ? options.sources.map(source => `- ${source}`).join('\n')
    : '- Keine Quellen gesetzt'
  const content = `${renderFrontmatter('contradiction', tags)}# Widerspruch: ${title}\n\n## Aussage A\n\n${options.claimA.trim()}\n\n## Aussage B\n\n${options.claimB.trim()}\n\n## Quellen\n\n${sources}\n\n## Nächste Klärung\n\n- [ ] Prüfen, welche Aussage aktuell und belastbar ist\n`

  if (!dryRun) {
    assertCanWriteTool('flag_contradiction', [path])
    const fullPath = vaultJoin(vault.vaultPath, path)
    mkdirSync(vaultJoin(vault.vaultPath, 'Knowledge/Contradictions'), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'flag_contradiction',
      mode: 'apply',
      targets: [path],
      summary: `Widerspruch erfasst: ${title}`,
      meta: { sources: options.sources?.length ?? 0 },
    })
  }

  return { dryRun, path, title, content }
}

export function listOpenQuestions(vault: Vault): OpenQuestion[] {
  return [...vault.notes.values()]
    .filter(note => (
      note.relativePath.startsWith('Knowledge/Gaps/')
      || note.relativePath.startsWith('Knowledge/Contradictions/')
      || note.tags.includes('open-question')
    ))
    .filter(note => note.frontmatter.status !== 'resolved')
    .sort((a, b) => b.lastModified - a.lastModified)
    .map(note => ({
      path: note.relativePath,
      title: note.title,
      type: note.relativePath.startsWith('Knowledge/Contradictions/') || note.tags.includes('contradiction') ? 'contradiction' : 'gap',
      tags: note.tags,
      context: note.content.split('\n').slice(0, 12).join('\n').trim(),
    }))
}

export function resolveGap(vault: Vault, options: ResolveGapOptions): KnowledgeGapResult {
  const dryRun = options.dryRun ?? true
  const path = options.path.trim()
  const resolution = options.resolution.trim()
  if (!path) throw new Error('Pfad darf nicht leer sein')
  if (!resolution) throw new Error('Resolution darf nicht leer sein')

  const fullPath = vaultJoin(vault.vaultPath, path)
  if (!existsSync(fullPath)) throw new Error(`Notiz nicht gefunden: ${path}`)

  const raw = readFileSync(fullPath, 'utf-8')
  const fm = {
    ...parseFrontmatter(raw),
    status: 'resolved',
    resolved: today(),
  }
  const body = stripFrontmatter(raw).trimEnd()
  const content = `---\n${buildFrontmatter(fm)}---\n\n${body}\n\n## Lösung\n\n${resolution}\n`
  const title = vault.notes.get(path)?.title ?? path.replace(/\.md$/, '')

  if (!dryRun) {
    assertCanWriteTool('resolve_gap', [path])
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'resolve_gap',
      mode: 'apply',
      targets: [path],
      summary: `Wissenslücke gelöst: ${path}`,
    })
  }

  return { dryRun, path, title, content }
}
