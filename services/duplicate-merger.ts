import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter, normalizeTag } from './frontmatter-linter.ts'
import { findDuplicates, type DuplicateMatch } from './duplicate-analyzer.ts'
import { assertSafeRelativePath, vaultJoin } from './vault-paths.ts'

export interface MergeDuplicatesOptions {
  noteA?: string
  noteB?: string
  dryRun?: boolean
  autoHighConfidence?: boolean
  minScore?: number
  force?: boolean
}

export interface MergePlan {
  noteA: string
  noteB: string
  target: string
  archive: string
  confidence: DuplicateMatch['confidence'] | 'explicit'
  score: number
  canApply: boolean
  conflicts: string[]
  warnings: string[]
  mergedPreview: string
}

export interface MergeDuplicatesResult {
  dryRun: boolean
  applied: Array<{ target: string; archived: string }>
  plans: MergePlan[]
  skipped: Array<{ noteA: string; noteB: string; reason: string }>
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function resolveNote(vault: Vault, pathOrTitle: string): NoteEntry | null {
  return vault.notes.get(pathOrTitle) ?? [...vault.notes.values()].find(entry =>
    entry.title.toLowerCase() === pathOrTitle.toLowerCase()
      || basename(entry.relativePath, '.md').toLowerCase() === pathOrTitle.toLowerCase()
  ) ?? null
}

function chooseTarget(a: NoteEntry, b: NoteEntry): { keep: NoteEntry; archive: NoteEntry } {
  const score = (entry: NoteEntry) => {
    let value = 0
    if (!entry.relativePath.startsWith('Archiv/')) value += 20
    if (entry.frontmatter?.status === 'aktiv') value += 10
    value += entry.tags.length
    value += entry.outgoingLinks.length
    value += Math.min(20, Math.floor(entry.content.length / 200))
    return value
  }
  return score(a) >= score(b) ? { keep: a, archive: b } : { keep: b, archive: a }
}

function mergeFrontmatter(keep: NoteEntry, other: NoteEntry): { fm: Record<string, any>; conflicts: string[] } {
  const fm: Record<string, any> = { ...keep.frontmatter }
  const conflicts: string[] = []
  const tags = new Set<string>()
  for (const tag of [...keep.tags, ...other.tags]) tags.add(normalizeTag(tag))
  if (tags.size > 0) fm.tags = [...tags].sort()

  for (const [key, value] of Object.entries(other.frontmatter)) {
    if (key === 'tags') continue
    if (!(key in fm) || fm[key] === undefined || fm[key] === null || fm[key] === '') {
      fm[key] = value
      continue
    }
    if (JSON.stringify(fm[key]) !== JSON.stringify(value)) {
      conflicts.push(key)
    }
  }

  fm.aktualisiert = today()
  fm.quellen = [...new Set([...(Array.isArray(fm.quellen) ? fm.quellen.map(String) : []), keep.relativePath, other.relativePath])]
  return { fm, conflicts }
}

function bodyWithoutH1(content: string): string {
  return content.trim().replace(/^#\s+.+\n+/, '').trim()
}

function archivePathFor(entry: NoteEntry): string {
  return assertSafeRelativePath(join('Archiv', 'Duplikate', today(), entry.relativePath))
}

function buildMergedContent(keep: NoteEntry, other: NoteEntry, fm: Record<string, any>, conflicts: string[]): string {
  const archivedPath = archivePathFor(other)
  const conflictSection = conflicts.length > 0
    ? `\n## Merge-Konflikte prüfen\n\n${conflicts.map(c => `- ${c}: Werte aus archivierter Note manuell prüfen`).join('\n')}\n`
    : ''

  return `---
${buildFrontmatter(fm)}---

# ${keep.title}

${bodyWithoutH1(keep.content)}

---

## Zusammengeführt aus Duplikat

Quelle: [[${archivedPath.replace(/\.md$/, '')}|${other.title}]]
Archiviert nach: \`${archivedPath}\`
${conflictSection}
### Inhalt aus archivierter Note

${bodyWithoutH1(other.content)}
`
}

function findMatchForPair(vault: Vault, aPath: string, bPath: string): DuplicateMatch | null {
  return findDuplicates(vault, 0).find(match =>
    (match.noteA === aPath && match.noteB === bPath) || (match.noteA === bPath && match.noteB === aPath)
  ) ?? null
}

function planPair(vault: Vault, noteA: string, noteB: string): MergePlan | null {
  const a = resolveNote(vault, noteA)
  const b = resolveNote(vault, noteB)
  if (!a || !b) return null

  const match = findMatchForPair(vault, a.relativePath, b.relativePath)
  const { keep, archive } = chooseTarget(a, b)
  const { fm, conflicts } = mergeFrontmatter(keep, archive)
  const mergedPreview = buildMergedContent(keep, archive, fm, conflicts)
  const warnings: string[] = []
  if (conflicts.length > 0) warnings.push(`Frontmatter-Konflikte: ${conflicts.join(', ')}`)
  if (match && match.confidence !== 'high') warnings.push(`Confidence ist nur ${match.confidence}`)

  return {
    noteA: a.relativePath,
    noteB: b.relativePath,
    target: keep.relativePath,
    archive: archivePathFor(archive),
    confidence: match?.confidence ?? 'explicit',
    score: match?.score ?? 0,
    canApply: !!match && match.confidence === 'high' && conflicts.length === 0,
    conflicts,
    warnings,
    mergedPreview,
  }
}

function candidatePlans(vault: Vault, minScore: number): MergePlan[] {
  return findDuplicates(vault, minScore)
    .filter(match => match.confidence === 'high')
    .map(match => planPair(vault, match.noteA, match.noteB))
    .filter((plan): plan is MergePlan => !!plan)
}

function applyPlan(vault: Vault, plan: MergePlan, force: boolean = false): { target: string; archived: string } {
  if (!plan.canApply && !force) throw new Error(`Merge nicht sicher anwendbar: ${plan.noteA} ↔ ${plan.noteB}`)
  const target = vault.notes.get(plan.target)
  const archivedOriginal = plan.target === plan.noteA ? vault.notes.get(plan.noteB) : vault.notes.get(plan.noteA)
  if (!target || !archivedOriginal) throw new Error('Merge-Plan referenziert nicht existierende Notes')

  const archiveFullPath = vaultJoin(vault.vaultPath, plan.archive)
  if (existsSync(archiveFullPath)) throw new Error(`Archivziel existiert bereits: ${plan.archive}`)
  mkdirSync(dirname(archiveFullPath), { recursive: true })

  const targetRawBefore = readFileSync(target.path, 'utf-8')
  renameSync(archivedOriginal.path, archiveFullPath)

  try {
    writeFileSync(target.path, plan.mergedPreview, 'utf-8')
  } catch (err) {
    try { renameSync(archiveFullPath, archivedOriginal.path) } catch {}
    throw err
  }

  vault.notes.delete(archivedOriginal.relativePath)
  vault.indexNote(target.path, statSync(target.path).mtimeMs)
  vault.indexNote(archiveFullPath, statSync(archiveFullPath).mtimeMs)
  vault.buildLinkIndex()
  const rewrittenLinks = rewriteLinksToMergedNote(vault, archivedOriginal.relativePath, target.relativePath)

  appendActionLog(vault.vaultPath, {
    tool: 'merge_duplicates',
    mode: 'apply',
    targets: [plan.target, plan.archive, ...rewrittenLinks],
    summary: `Duplikate zusammengeführt: ${plan.noteA} ↔ ${plan.noteB}`,
    before: targetRawBefore.slice(0, 1000),
    after: plan.mergedPreview.slice(0, 1000),
    meta: {
      noteA: plan.noteA,
      noteB: plan.noteB,
      target: plan.target,
      archive: plan.archive,
      confidence: plan.confidence,
      score: plan.score,
      conflicts: plan.conflicts,
      rewrittenLinks,
    },
  })

  return { target: relative(vault.vaultPath, target.path), archived: plan.archive }
}

function replacementLink(oldTarget: string, newTarget: string, alias: string | null): string {
  const aliasPart = alias ? `|${alias}` : ''
  return `[[${newTarget.replace(/\.md$/, '')}${aliasPart}]]`
}

function rewriteLinksToMergedNote(vault: Vault, oldPath: string, newPath: string): string[] {
  const oldNoMd = oldPath.replace(/\.md$/, '')
  const oldBase = basename(oldPath, '.md')
  const newNoMd = newPath.replace(/\.md$/, '')
  const rewritten: string[] = []

  for (const [, entry] of vault.notes) {
    if (entry.relativePath.startsWith('Archiv/')) continue
    const raw = readFileSync(entry.path, 'utf-8')
    const updated = raw.replace(/\[\[([^\]]+?)\]\]/g, (full, inner: string) => {
      const pipeIdx = inner.search(/\\?\|/)
      const target = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim()
      const alias = pipeIdx === -1 ? null : inner.slice(pipeIdx).replace(/^\\?\|/, '')
      if (target === oldPath || target === oldNoMd || target === oldBase) {
        return replacementLink(target, newNoMd, alias)
      }
      return full
    })

    if (updated !== raw) {
      writeFileSync(entry.path, updated, 'utf-8')
      vault.indexNote(entry.path, statSync(entry.path).mtimeMs)
      rewritten.push(entry.relativePath)
    }
  }
  vault.buildLinkIndex()
  return rewritten
}

export function mergeDuplicates(vault: Vault, options: MergeDuplicatesOptions = {}): MergeDuplicatesResult {
  const dryRun = options.dryRun ?? true
  const minScore = options.minScore ?? 80
  const skipped: MergeDuplicatesResult['skipped'] = []

  let plans: MergePlan[] = []
  if (options.noteA && options.noteB) {
    const plan = planPair(vault, options.noteA, options.noteB)
    if (plan) plans = [plan]
    else skipped.push({ noteA: options.noteA, noteB: options.noteB, reason: 'Eine oder beide Notes wurden nicht gefunden' })
  } else if (options.autoHighConfidence) {
    plans = candidatePlans(vault, minScore)
  } else {
    skipped.push({ noteA: options.noteA ?? '', noteB: options.noteB ?? '', reason: 'note_a/note_b oder auto_high_confidence=true erforderlich' })
  }

  const applied: Array<{ target: string; archived: string }> = []
  if (!dryRun) {
    for (const plan of plans) {
      if (!plan.canApply) {
        if (!options.force) {
          skipped.push({ noteA: plan.noteA, noteB: plan.noteB, reason: plan.warnings.join('; ') || 'Plan ist nicht sicher anwendbar' })
          continue
        }
      }
      applied.push(applyPlan(vault, plan, options.force === true))
    }
  }

  return { dryRun, applied, plans, skipped }
}
