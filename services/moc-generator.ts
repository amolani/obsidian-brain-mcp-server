import { writeFileSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'

export interface MocResult {
  path: string
  noteCount: number
  subfolders: string[]
  action: 'created' | 'updated' | 'skipped'
  reason?: string
}

export const MOC_MARKER = 'quelle: moc-generator'

export function buildMocContent(folder: string, subfolders: string[]): string {
  const folderName = basename(folder)
  const datum = new Date().toISOString().split('T')[0]
  const tagPath = folder.toLowerCase().replace(/ /g, '-')

  const sections: string[] = []

  sections.push(`---
status: moc
tags:
  - moc
  - ${tagPath.split('/').join('/')}
aktualisiert: ${datum}
quelle: moc-generator
---

# ${folderName} — Übersicht

> [!info] Map of Content
> Automatisch generiert am ${datum}. Listet alle Notizen in \`${folder}\`.
> Manuelle Änderungen werden bei Regenerierung **überschrieben**.`)

  // Subfolders list
  if (subfolders.length > 0) {
    const subLinks = subfolders.map(sf => `- [[${sf}/_MOC|${basename(sf)}]]`).join('\n')
    sections.push(`\n## Unterkategorien\n\n${subLinks}`)
  }

  // Live Dataview: all notes in this folder (excluding the MOC itself)
  sections.push(`\n## Notizen

\`\`\`dataview
TABLE status, datum, tags
FROM "${folder}"
WHERE file.name != "_MOC"
SORT file.mtime DESC
\`\`\``)

  // Recently modified
  sections.push(`\n## Zuletzt bearbeitet

\`\`\`dataview
LIST "—"  + dateformat(file.mtime, "dd.MM.yyyy")
FROM "${folder}"
WHERE file.name != "_MOC"
SORT file.mtime DESC
LIMIT 5
\`\`\``)

  // Open TODOs in folder
  sections.push(`\n## Offene Aufgaben

\`\`\`dataview
TASK
FROM "${folder}"
WHERE !completed
LIMIT 20
\`\`\``)

  return sections.join('\n')
}

export function generateMocs(vault: Vault, dryRun: boolean = false, minNotes: number = 2): MocResult[] {
  const results: MocResult[] = []

  // Discover folders that deserve MOCs:
  // - Kunden/{client}
  // - Technik/{category}
  // - Technik/{category}/{sub}
  const foldersToProcess = new Set<string>()
  const folderNotes = new Map<string, string[]>()
  const folderSubdirs = new Map<string, Set<string>>()

  for (const [rel] of vault.notes) {
    if (basename(rel, '.md') === '_MOC') continue

    const parts = rel.split('/')
    if (parts.length < 2) continue

    for (let depth = 1; depth < parts.length; depth++) {
      const folder = parts.slice(0, depth).join('/')

      if (!folder.startsWith('Kunden/') && !folder.startsWith('Technik/')) continue
      if (folder.split('/').length > 3) continue

      foldersToProcess.add(folder)

      if (!folderNotes.has(folder)) folderNotes.set(folder, [])
      folderNotes.get(folder)!.push(rel)

      if (depth + 1 < parts.length) {
        const subFolder = parts.slice(0, depth + 1).join('/')
        if (!folderSubdirs.has(folder)) folderSubdirs.set(folder, new Set())
        folderSubdirs.get(folder)!.add(subFolder)
      }
    }
  }

  for (const folder of foldersToProcess) {
    const notes = folderNotes.get(folder) ?? []
    const subdirs = [...(folderSubdirs.get(folder) ?? [])].sort()
    const mocPath = join(folder, '_MOC.md')

    if (notes.length < minNotes) {
      results.push({ path: mocPath, noteCount: notes.length, subfolders: subdirs, action: 'skipped', reason: `nur ${notes.length} Notiz(en)` })
      continue
    }

    // Check existing MOC: only overwrite our own
    const existing = vault.notes.get(mocPath)
    const action: 'created' | 'updated' | 'skipped' = existing ? 'updated' : 'created'
    if (existing && !existing.content.includes(MOC_MARKER)) {
      results.push({ path: mocPath, noteCount: notes.length, subfolders: subdirs, action: 'skipped', reason: 'bestehende MOC nicht auto-generiert' })
      continue
    }

    const content = buildMocContent(folder, subdirs)

    if (!dryRun) {
      const fullPath = join(vault.vaultPath, mocPath)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content, 'utf-8')
      const stat = statSync(fullPath)
      vault.indexNote(fullPath, stat.mtimeMs)
    }

    results.push({ path: mocPath, noteCount: notes.length, subfolders: subdirs, action })
  }

  if (!dryRun) {
    vault.buildLinkIndex()
    const written = results.filter(r => r.action === 'created' || r.action === 'updated')
    if (written.length > 0) {
      const created = written.filter(r => r.action === 'created').length
      const updated = written.filter(r => r.action === 'updated').length
      appendActionLog(vault.vaultPath, {
        tool: 'generate_mocs',
        mode: 'apply',
        targets: written.map(r => r.path),
        summary: `${created} MOC(s) erstellt, ${updated} aktualisiert`,
        meta: { results: written },
      })
    }
  }
  return results
}
