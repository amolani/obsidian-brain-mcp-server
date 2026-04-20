import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { Vault } from '../vault.ts'
import { tokenize, jaccard } from './text-utils.ts'
import { appendActionLog } from './action-log.ts'

export interface BrokenLink {
  source: string       // note that has the broken link
  target: string       // the link text that doesn't resolve
  candidates: Array<{  // possible auto-fix candidates
    path: string
    confidence: 'high' | 'medium' | 'low'
    reason: string
  }>
}

export function findBrokenLinks(vault: Vault): BrokenLink[] {
  const broken: BrokenLink[] = []

  // Build search index: basename (without .md) → [relPath, ...]
  const byBasename = new Map<string, string[]>()
  for (const [rel] of vault.notes) {
    const name = basename(rel, '.md').toLowerCase()
    if (!byBasename.has(name)) byBasename.set(name, [])
    byBasename.get(name)!.push(rel)
  }

  for (const [sourcePath, entry] of vault.notes) {
    for (const rawLink of entry.outgoingLinks) {
      const resolved = vault.resolveLink(rawLink)
      if (resolved) continue // not broken

      const target = rawLink.trim()
      const targetBase = basename(target, '.md').toLowerCase()

      const candidates: BrokenLink['candidates'] = []

      // Strategy 1: exact basename match elsewhere in vault
      const exactMatches = byBasename.get(targetBase)
      if (exactMatches && exactMatches.length === 1) {
        candidates.push({
          path: exactMatches[0],
          confidence: 'high',
          reason: `Datei existiert unter neuem Pfad (exakter Dateiname)`,
        })
      } else if (exactMatches && exactMatches.length > 1) {
        for (const match of exactMatches) {
          candidates.push({
            path: match,
            confidence: 'medium',
            reason: `Mehrere Dateien mit diesem Namen — manuell prüfen`,
          })
        }
      }

      // Strategy 2: fuzzy filename match
      if (candidates.length === 0) {
        for (const [name, paths] of byBasename) {
          const sim = jaccard(tokenize(name), tokenize(targetBase))
          if (sim >= 0.5) {
            for (const p of paths) {
              candidates.push({
                path: p,
                confidence: sim >= 0.8 ? 'medium' : 'low',
                reason: `Ähnlicher Dateiname (${Math.round(sim * 100)}%)`,
              })
            }
          }
        }
      }

      broken.push({
        source: sourcePath,
        target,
        candidates: candidates.slice(0, 3),
      })
    }
  }

  return broken
}

// Replace [[old-target]] with [[new-target]] in source files.
// Only fixes links where there's exactly ONE high-confidence candidate.
export function fixBrokenLinks(vault: Vault, dryRun: boolean = true): {
  fixed: Array<{ source: string; oldLink: string; newLink: string }>
  skipped: Array<{ source: string; oldLink: string; reason: string }>
} {
  const broken = findBrokenLinks(vault)
  const fixed: Array<{ source: string; oldLink: string; newLink: string }> = []
  const skipped: Array<{ source: string; oldLink: string; reason: string }> = []

  // Group by source file for efficient editing
  const bySource = new Map<string, BrokenLink[]>()
  for (const b of broken) {
    if (!bySource.has(b.source)) bySource.set(b.source, [])
    bySource.get(b.source)!.push(b)
  }

  for (const [sourceRel, brokens] of bySource) {
    const entry = vault.notes.get(sourceRel)
    if (!entry) continue

    let content = readFileSync(entry.path, 'utf-8')
    let changed = false

    for (const b of brokens) {
      // Only auto-fix when exactly one high-confidence candidate
      const highCand = b.candidates.filter(c => c.confidence === 'high')
      if (highCand.length !== 1) {
        skipped.push({
          source: b.source,
          oldLink: b.target,
          reason: highCand.length === 0
            ? `kein High-Confidence Kandidat (${b.candidates.length} Vorschläge)`
            : 'mehrere Kandidaten',
        })
        continue
      }

      const newTarget = highCand[0].path.replace(/\.md$/, '')
      // Replace all occurrences of [[target]], [[target|alias]], [[target\|alias]]
      const escaped = b.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // Match both unescaped (|) and table-escaped (\|) pipes
      const pattern = new RegExp(`\\[\\[${escaped}(\\\\?\\|[^\\]]+)?\\]\\]`, 'g')
      const newContent = content.replace(pattern, (_m, alias) => `[[${newTarget}${alias || ''}]]`)

      if (newContent !== content) {
        content = newContent
        changed = true
        fixed.push({
          source: b.source,
          oldLink: `[[${b.target}]]`,
          newLink: `[[${newTarget}]]`,
        })
      }
    }

    if (changed && !dryRun) {
      writeFileSync(entry.path, content, 'utf-8')
    }
  }

  if (!dryRun && fixed.length > 0) {
    // Re-scan affected files
    for (const f of fixed) {
      const e = vault.notes.get(f.source)
      if (e) vault.indexNote(e.path, statSync(e.path).mtimeMs)
    }
    vault.buildLinkIndex()
    const targets = [...new Set(fixed.map(f => f.source))]
    const first = fixed[0]
    appendActionLog(vault.vaultPath, {
      tool: 'fix_broken_links',
      mode: 'apply',
      targets,
      summary: `${fixed.length} kaputte Link(s) in ${targets.length} Datei(en) ersetzt`,
      before: first.oldLink,
      after: first.newLink,
      meta: { fixed },
    })
  }

  return { fixed, skipped }
}
