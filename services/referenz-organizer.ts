import { mkdirSync, renameSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { NoteEntry } from '../vault.ts'
import { classifyNote } from '../technik-categories.ts'
import { appendActionLog } from './action-log.ts'

export interface OrganizeReferenzMove {
  from: string
  to: string
  category: string
  reason: string
}

export interface OrganizeReferenzSkip {
  path: string
  reason: string
}

export interface OrganizeReferenzResult {
  moved: OrganizeReferenzMove[]
  skipped: OrganizeReferenzSkip[]
  dryRun: boolean
}

export interface ReferenzOrganizerContext {
  vaultPath: string
  notes: Map<string, NoteEntry>
  indexNote(fullPath: string, mtimeMs: number): void
  buildLinkIndex(): void
}

function isProcessable(relativePath: string): boolean {
  if (relativePath.startsWith('Referenz/')) {
    return !relativePath.substring('Referenz/'.length).includes('/')
  }

  if (relativePath.startsWith('Technik/')) {
    return relativePath.substring('Technik/'.length).split('/').length === 2
  }

  return false
}

export function organizeReferenz(ctx: ReferenzOrganizerContext, dryRun: boolean = false): OrganizeReferenzResult {
  const moved: OrganizeReferenzMove[] = []
  const skipped: OrganizeReferenzSkip[] = []

  for (const [relativePath, entry] of ctx.notes) {
    if (!isProcessable(relativePath)) continue

    const classification = classifyNote(entry.title, entry.content, entry.tags)
    if (!classification.category) {
      skipped.push({ path: relativePath, reason: 'keine Kategorie zuordenbar' })
      continue
    }

    const categoryPath = classification.subcategory
      ? join('Technik', classification.category, classification.subcategory)
      : join('Technik', classification.category)
    const targetDir = join(ctx.vaultPath, categoryPath)
    const targetPath = join(targetDir, basename(relativePath))
    const targetRelativePath = relative(ctx.vaultPath, targetPath)

    if (targetRelativePath === relativePath) continue

    if (!dryRun) {
      mkdirSync(targetDir, { recursive: true })

      try {
        statSync(targetPath)
        skipped.push({ path: relativePath, reason: `Zieldatei existiert bereits: ${targetRelativePath}` })
        continue
      } catch {
        // Target does not exist, safe to move.
      }

      try {
        renameSync(entry.path, targetPath)
        ctx.notes.delete(relativePath)
        const stat = statSync(targetPath)
        ctx.indexNote(targetPath, stat.mtimeMs)
      } catch (err) {
        skipped.push({ path: relativePath, reason: `Move failed: ${err}` })
        continue
      }
    }

    moved.push({
      from: relativePath,
      to: targetRelativePath,
      category: classification.subcategory
        ? `${classification.category}/${classification.subcategory}`
        : classification.category as string,
      reason: classification.reason,
    })
  }

  if (!dryRun && moved.length > 0) {
    ctx.buildLinkIndex()
    appendActionLog(ctx.vaultPath, {
      tool: 'organize_referenz',
      mode: 'apply',
      targets: moved.map(move => move.to),
      summary: `${moved.length} Notiz(en) in Technik/ einsortiert`,
      meta: { moves: moved.map(move => ({ from: move.from, to: move.to, category: move.category })) },
    })
  }

  return { moved, skipped, dryRun }
}
