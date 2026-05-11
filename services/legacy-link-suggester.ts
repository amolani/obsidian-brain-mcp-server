import { basename } from 'node:path'
import type { NoteEntry } from '../vault.ts'

export interface LegacyLinkSuggestion {
  source: string
  mention: string
  target: string
  targetTitle: string
}

const IGNORED_NOTE_NAMES = new Set(['notizen', 'zugangsdaten', 'todos', 'pw'])

export function suggestLegacyLinks(
  notes: Map<string, NoteEntry>,
  resolveLink: (link: string) => string | null
): LegacyLinkSuggestion[] {
  const suggestions: LegacyLinkSuggestion[] = []
  const titleToPath = new Map<string, string>()

  for (const [relativePath, entry] of notes) {
    const name = basename(relativePath, '.md').toLowerCase()
    if (name.length > 3 && !IGNORED_NOTE_NAMES.has(name)) {
      titleToPath.set(name, relativePath)
    }
    if (entry.title.length > 3 && entry.title.toLowerCase() !== name) {
      titleToPath.set(entry.title.toLowerCase(), relativePath)
    }
  }

  for (const [sourcePath, sourceEntry] of notes) {
    const contentLower = sourceEntry.content.toLowerCase()
    const existingTargets = new Set(sourceEntry.outgoingLinks.map(resolveLink).filter(Boolean))

    for (const [searchTerm, targetPath] of titleToPath) {
      if (targetPath === sourcePath) continue
      if (existingTargets.has(targetPath)) continue
      if (!contentLower.includes(searchTerm)) continue

      const target = notes.get(targetPath)
      if (!target) continue
      suggestions.push({
        source: sourcePath,
        mention: searchTerm,
        target: targetPath,
        targetTitle: target.title,
      })
    }
  }

  const seen = new Set<string>()
  return suggestions.filter(suggestion => {
    const key = `${suggestion.source}->${suggestion.target}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
