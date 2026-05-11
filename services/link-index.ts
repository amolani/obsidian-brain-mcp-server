import { basename } from 'node:path'
import type { NoteEntry } from '../vault.ts'

export type LinkIndex = Map<string, Set<string>>

export function resolveLinkInNotes(notes: Map<string, NoteEntry>, link: string): string | null {
  const withMd = link.endsWith('.md') ? link : `${link}.md`
  if (notes.has(withMd)) return withMd

  if (notes.has(link)) return link

  if (!link.includes('/')) {
    const target = `${link}.md`
    for (const [relPath] of notes) {
      if (basename(relPath) === target || basename(relPath, '.md') === link) {
        return relPath
      }
    }

    const lower = link.toLowerCase()
    for (const [relPath] of notes) {
      if (basename(relPath, '.md').toLowerCase() === lower) {
        return relPath
      }
    }
  }

  return null
}

export function buildLinkIndexForNotes(notes: Map<string, NoteEntry>): LinkIndex {
  const index: LinkIndex = new Map()

  for (const [relativePath, entry] of notes) {
    for (const link of entry.outgoingLinks) {
      const resolved = resolveLinkInNotes(notes, link)
      if (!resolved) continue
      if (!index.has(resolved)) index.set(resolved, new Set())
      index.get(resolved)!.add(relativePath)
    }
  }

  return index
}

export function removeNoteFromLinkIndex(index: LinkIndex, notes: Map<string, NoteEntry>, relativePath: string): void {
  const entry = notes.get(relativePath)
  if (!entry) return

  for (const link of entry.outgoingLinks) {
    const resolved = resolveLinkInNotes(notes, link)
    if (!resolved) continue
    index.get(resolved)?.delete(relativePath)
    if (index.get(resolved)?.size === 0) index.delete(resolved)
  }
}
