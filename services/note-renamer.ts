import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter } from './frontmatter-linter.ts'
import { parseFrontmatter, stripFrontmatter } from './note-parser.ts'
import { assertCanWriteTool } from './policy.ts'
import { assertSafeRelativePath, sanitizePathSegment, vaultJoin } from './vault-paths.ts'

export interface RenameNoteOptions {
  path: string
  newTitle?: string
  targetFolder?: string
  dryRun?: boolean
  updateTitle?: boolean
}

export interface RenameNotePlan {
  source: string
  target: string
  oldTitle: string
  newTitle: string
  changedLinks: Array<{ source: string; replacements: number }>
  changedFrontmatterRefs: Array<{ source: string; replacements: number }>
  aliasesAdded: string[]
  warnings: string[]
}

export interface RenameNoteResult {
  dryRun: boolean
  applied: boolean
  plan: RenameNotePlan
}

function resolveNote(vault: Vault, pathOrTitle: string): NoteEntry | null {
  const normalized = pathOrTitle.endsWith('.md') ? pathOrTitle : `${pathOrTitle}.md`
  return vault.notes.get(pathOrTitle)
    ?? vault.notes.get(normalized)
    ?? [...vault.notes.values()].find(entry =>
      entry.title.toLowerCase() === pathOrTitle.toLowerCase()
        || basename(entry.relativePath, '.md').toLowerCase() === pathOrTitle.toLowerCase(),
    )
    ?? null
}

function folderOf(relativePath: string): string {
  const dir = dirname(relativePath).replace(/\\/g, '/')
  return dir === '.' ? '' : dir
}

function targetPathFor(entry: NoteEntry, options: RenameNoteOptions): { target: string; newTitle: string } {
  const newTitle = (options.newTitle?.trim() || entry.title).trim()
  const folder = options.targetFolder !== undefined
    ? assertSafeRelativePath(options.targetFolder.trim() || '')
    : folderOf(entry.relativePath)
  const fileName = options.newTitle
    ? `${sanitizePathSegment(newTitle)}.md`
    : basename(entry.relativePath)
  return {
    target: assertSafeRelativePath(folder ? `${folder}/${fileName}` : fileName),
    newTitle,
  }
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, any>; body: string; hadFrontmatter: boolean } {
  const hadFrontmatter = /^---\r?\n[\s\S]*?\r?\n---/.test(raw)
  return {
    frontmatter: parseFrontmatter(raw),
    body: stripFrontmatter(raw),
    hadFrontmatter,
  }
}

function addAliases(fm: Record<string, any>, aliases: string[]): string[] {
  const existing = Array.isArray(fm.aliases) ? fm.aliases.map(String) : []
  const normalized = new Set(existing.map(alias => alias.toLowerCase()))
  const added: string[] = []
  for (const alias of aliases) {
    const clean = alias.trim()
    if (!clean || normalized.has(clean.toLowerCase())) continue
    existing.push(clean)
    normalized.add(clean.toLowerCase())
    added.push(clean)
  }
  if (existing.length > 0) fm.aliases = existing
  return added
}

function plannedAliases(entry: NoteEntry, newTitle: string): string[] {
  const existing = Array.isArray(entry.frontmatter.aliases) ? entry.frontmatter.aliases.map(String) : []
  const normalized = new Set(existing.map(alias => alias.toLowerCase()))
  const result: string[] = []
  for (const alias of [entry.title, basename(entry.relativePath, '.md')]) {
    const clean = alias.trim()
    if (!clean || clean === newTitle || normalized.has(clean.toLowerCase())) continue
    result.push(clean)
    normalized.add(clean.toLowerCase())
  }
  return result
}

function updateTargetContent(raw: string, entry: NoteEntry, newTitle: string, updateTitle: boolean): {
  content: string
  aliasesAdded: string[]
} {
  const { frontmatter, body, hadFrontmatter } = splitFrontmatter(raw)
  const oldBase = basename(entry.relativePath, '.md')
  const aliasesAdded = addAliases(frontmatter, [entry.title, oldBase].filter(alias => alias !== newTitle))
  if ('title' in frontmatter) frontmatter.title = newTitle
  frontmatter.aktualisiert = new Date().toISOString().split('T')[0]

  let nextBody = body
  if (updateTitle) {
    if (/^#\s+.+$/m.test(nextBody)) {
      nextBody = nextBody.replace(/^#\s+.+$/m, `# ${newTitle}`)
    } else {
      nextBody = `# ${newTitle}\n\n${nextBody.trimStart()}`
    }
  }

  const fmBlock = Object.keys(frontmatter).length > 0 || hadFrontmatter
    ? `---\n${buildFrontmatter(frontmatter)}---\n\n`
    : ''
  return { content: `${fmBlock}${nextBody.replace(/^\s+/, '')}`, aliasesAdded }
}

function updateWikiLinks(raw: string, oldPath: string, newPath: string, resolveLink: (link: string) => string | null): {
  content: string
  replacements: number
} {
  const newTarget = newPath.replace(/\.md$/, '')
  let replacements = 0
  const content = raw.replace(/\[\[([^\]]+?)\]\]/g, (full, inner: string) => {
    const pipeIdx = inner.search(/\\?\|/)
    const target = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim()
    const aliasPart = pipeIdx === -1 ? '' : inner.slice(pipeIdx)
    if (resolveLink(target) !== oldPath) return full
    replacements++
    return `[[${newTarget}${aliasPart}]]`
  })
  return { content, replacements }
}

function updateFrontmatterPathRefs(raw: string, oldPath: string, newPath: string): {
  content: string
  replacements: number
} {
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/)
  if (!match) return { content: raw, replacements: 0 }
  const oldNoMd = oldPath.replace(/\.md$/, '')
  const newNoMd = newPath.replace(/\.md$/, '')
  const escaped = [oldPath, oldNoMd].map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  let replacements = 0
  const updatedYaml = match[2].replace(new RegExp(escaped, 'g'), value => {
    replacements++
    return extname(value) === '.md' ? newPath : newNoMd
  })
  return {
    content: `${match[1]}${updatedYaml}${match[3]}${raw.slice(match[0].length)}`,
    replacements,
  }
}

function buildPlan(vault: Vault, entry: NoteEntry, target: string, newTitle: string): RenameNotePlan {
  const warnings: string[] = []
  const changedLinks: RenameNotePlan['changedLinks'] = []
  const changedFrontmatterRefs: RenameNotePlan['changedFrontmatterRefs'] = []

  for (const [, note] of vault.notes) {
    const raw = readFileSync(note.path, 'utf-8')
    const linkUpdate = updateWikiLinks(raw, entry.relativePath, target, link => vault.resolveLink(link))
    if (linkUpdate.replacements > 0) {
      changedLinks.push({ source: note.relativePath, replacements: linkUpdate.replacements })
    }
    const fmUpdate = updateFrontmatterPathRefs(linkUpdate.content, entry.relativePath, target)
    if (fmUpdate.replacements > 0) {
      changedFrontmatterRefs.push({ source: note.relativePath, replacements: fmUpdate.replacements })
    }
  }

  if (target === entry.relativePath && newTitle === entry.title) {
    warnings.push('Quelle und Ziel sind identisch; nur aktualisiert-Feld/Aliases würden geprüft.')
  }

  return {
    source: entry.relativePath,
    target,
    oldTitle: entry.title,
    newTitle,
    changedLinks,
    changedFrontmatterRefs,
    aliasesAdded: plannedAliases(entry, newTitle),
    warnings,
  }
}

export function renameNote(vault: Vault, options: RenameNoteOptions): RenameNoteResult {
  const dryRun = options.dryRun ?? true
  if (!options.path || typeof options.path !== 'string') throw new Error('rename_note benötigt path')

  const entry = resolveNote(vault, options.path)
  if (!entry) throw new Error(`Note nicht gefunden: ${options.path}`)

  const { target, newTitle } = targetPathFor(entry, options)
  const targetFullPath = vaultJoin(vault.vaultPath, target)
  const samePath = target === entry.relativePath
  if (!samePath && existsSync(targetFullPath)) throw new Error(`Ziel existiert bereits: ${target}`)

  const plan = buildPlan(vault, entry, target, newTitle)
  if (dryRun) return { dryRun, applied: false, plan }

  const oldFullPath = entry.path
  const oldRaw = readFileSync(oldFullPath, 'utf-8')
  const targetUpdate = updateTargetContent(oldRaw, entry, newTitle, options.updateTitle !== false)
  plan.aliasesAdded = targetUpdate.aliasesAdded
  assertCanWriteTool('rename_note', [
    entry.relativePath,
    target,
    ...plan.changedLinks.map(change => change.source),
    ...plan.changedFrontmatterRefs.map(change => change.source),
  ])

  if (!samePath) mkdirSync(dirname(targetFullPath), { recursive: true })

  if (!samePath) {
    renameSync(oldFullPath, targetFullPath)
  }
  writeFileSync(targetFullPath, targetUpdate.content, 'utf-8')

  for (const [, note] of [...vault.notes]) {
    if (note.relativePath === entry.relativePath) continue
    const raw = readFileSync(note.path, 'utf-8')
    const linkUpdate = updateWikiLinks(raw, entry.relativePath, target, link => vault.resolveLink(link))
    const fmUpdate = updateFrontmatterPathRefs(linkUpdate.content, entry.relativePath, target)
    if (fmUpdate.content !== raw) {
      writeFileSync(note.path, fmUpdate.content, 'utf-8')
    }
  }

  vault.removeNoteFromIndex(entry.relativePath)
  vault.indexNote(targetFullPath, statSync(targetFullPath).mtimeMs)
  for (const [, note] of [...vault.notes]) {
    if (note.relativePath === target) continue
    vault.removeNoteFromIndex(note.relativePath)
    vault.indexNote(note.path, statSync(note.path).mtimeMs)
  }
  vault.buildLinkIndex()

  appendActionLog(vault.vaultPath, {
    tool: 'rename_note',
    mode: 'apply',
    targets: [entry.relativePath, target, ...plan.changedLinks.map(change => change.source)],
    summary: `Note umbenannt/verschoben: ${entry.relativePath} → ${target}`,
    before: entry.relativePath,
    after: target,
    meta: { ...plan },
  })

  return { dryRun, applied: true, plan }
}
