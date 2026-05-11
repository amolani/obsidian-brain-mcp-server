import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { NoteEntry } from '../vault.ts'
import { loadClients } from '../config.ts'
import { appendActionLog } from './action-log.ts'

export interface GenerateRunbookResult {
  path: string
  sourceCount: number
  stepCount: number
  fixCount: number
}

export interface RunbookGeneratorContext {
  vaultPath: string
  notes: Map<string, NoteEntry>
  indexNote(fullPath: string, mtimeMs: number): void
  buildLinkIndex(): void
}

interface RunbookSource {
  path: string
  title: string
  content: string
  datum: string
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function sourceMatchesTopic(relativePath: string, entry: NoteEntry, topicLower: string, includeTags: boolean): boolean {
  return relativePath.toLowerCase().includes(topicLower)
    || entry.title.toLowerCase().includes(topicLower)
    || (includeTags && entry.tags.some(tag => tag.includes(topicLower)))
}

function collectSources(notes: Map<string, NoteEntry>, topicLower: string): RunbookSource[] {
  const sourceNotes: RunbookSource[] = []

  for (const [relativePath, entry] of notes) {
    const isAutoCapture = entry.tags.includes('auto-capture') || entry.tags.includes('prozedur')
    if (!isAutoCapture || !sourceMatchesTopic(relativePath, entry, topicLower, true)) continue
    sourceNotes.push({
      path: relativePath,
      title: entry.title,
      content: entry.content,
      datum: entry.frontmatter.datum || '',
    })
  }

  for (const [relativePath, entry] of notes) {
    if (sourceNotes.some(source => source.path === relativePath)) continue
    const hasProcedural = entry.content.includes('## Durchgeführte')
      || entry.content.includes('## Fehler')
      || entry.content.includes('## Installationsreihenfolge')
      || entry.todos.length > 3
    if (!hasProcedural || !sourceMatchesTopic(relativePath, entry, topicLower, false)) continue
    sourceNotes.push({
      path: relativePath,
      title: entry.title,
      content: entry.content,
      datum: entry.frontmatter.datum || '',
    })
  }

  return sourceNotes.sort((a, b) => a.datum.localeCompare(b.datum))
}

function extractRunbookParts(sourceNotes: RunbookSource[]): {
  steps: string[]
  fixes: string[]
  summaries: string[]
} {
  const steps: string[] = []
  const fixes: string[] = []
  const summaries: string[] = []
  const seenSteps = new Set<string>()

  for (const note of sourceNotes) {
    const stepSection = note.content.match(/## Durchgeführte (?:Befehle|Schritte)\n\n([\s\S]*?)(?=\n## |$)/i)
    if (stepSection) {
      for (const step of stepSection[1].split('\n').filter(line => /^\d+\.\s/.test(line))) {
        const command = step.replace(/^\d+\.\s*/, '').trim()
        const key = command.slice(0, 60).toLowerCase()
        if (seenSteps.has(key)) continue
        seenSteps.add(key)
        steps.push(command)
      }
    }

    const fixSection = note.content.match(/## Fehler und Workarounds\n\n([\s\S]*?)(?=\n## |$)/i)
    if (fixSection) {
      fixes.push(...fixSection[1].split(/### \d+\./).filter(fix => fix.trim()).map(fix => fix.trim()))
    }

    const summarySection = note.content.match(/## Zusammenfassung\n\n([\s\S]*?)(?=\n## |$)/i)
    if (summarySection) summaries.push(summarySection[1].trim())
  }

  for (const note of sourceNotes) {
    if (!note.content.includes('- [ ]') && !note.content.includes('- [x]')) continue
    const checklistItems = note.content.split('\n')
      .filter(line => /^\s*\d+\.\s*\[[ x]\]/.test(line))
      .map(line => line.replace(/^\s*\d+\.\s*\[[ x]\]\s*/, '').trim())
    for (const item of checklistItems) {
      const key = item.slice(0, 60).toLowerCase()
      if (item.length <= 10 || seenSteps.has(key)) continue
      seenSteps.add(key)
      steps.push(item)
    }
  }

  return { steps, fixes, summaries }
}

function renderRunbook(topic: string, sourceNotes: RunbookSource[], steps: string[], fixes: string[], summaries: string[]): string {
  const datum = today()
  const topicLower = topic.toLowerCase()
  const tagBlock = ['runbook', topicLower.replace(/\s+/g, '-')].map(tag => `  - ${tag}`).join('\n')
  const sourceLinks = sourceNotes.map(source => `- [[${source.path}|${source.title}]]`).join('\n')

  let content = `---
status: aktiv
tags:
${tagBlock}
datum: ${datum}
quellen: ${sourceNotes.length}
---

# Runbook: ${topic}

> [!tip] Automatisch generiert
> Erstellt am ${datum} aus ${sourceNotes.length} Quell-Notizen.
> Bei Änderungen: Quell-Notizen updaten und Runbook neu generieren.

## Quellen

${sourceLinks}
`

  if (summaries.length > 0) {
    content += `\n## Übersicht\n\n${summaries.slice(-2).join('\n\n')}\n`
  }

  if (steps.length > 0) {
    content += `\n## Schritte\n\n${steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n`
  }

  if (fixes.length > 0) {
    content += '\n## Bekannte Probleme und Workarounds\n\n'
    for (let i = 0; i < fixes.length; i++) {
      content += `### ${i + 1}.\n${fixes[i]}\n\n`
    }
  }

  return content
}

function outputFolderForTopic(topicLower: string, outputFolder?: string): string {
  let folder = outputFolder || 'Referenz'
  for (const [key, name] of Object.entries(loadClients())) {
    if (topicLower.includes(key)) {
      folder = `Kunden/${name}`
      break
    }
  }
  return folder
}

export function generateRunbook(ctx: RunbookGeneratorContext, topic: string, outputFolder?: string): GenerateRunbookResult {
  const topicLower = topic.toLowerCase()
  const sourceNotes = collectSources(ctx.notes, topicLower)
  if (sourceNotes.length === 0) {
    throw new Error(`Keine Quell-Notizen für "${topic}" gefunden. Arbeite zuerst am Projekt — der Knowledge Harvester erstellt automatisch Captures.`)
  }

  const { steps, fixes, summaries } = extractRunbookParts(sourceNotes)
  const content = renderRunbook(topic, sourceNotes, steps, fixes, summaries)
  const folder = outputFolderForTopic(topicLower, outputFolder)
  const safeTitle = `Runbook ${topic}`.replace(/[/\\:*?"<>|]/g, '-').slice(0, 100)
  const fullDir = join(ctx.vaultPath, folder)
  const fullPath = join(fullDir, `${safeTitle}.md`)

  mkdirSync(fullDir, { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')

  const stat = statSync(fullPath)
  ctx.indexNote(fullPath, stat.mtimeMs)
  ctx.buildLinkIndex()

  const relativePath = relative(ctx.vaultPath, fullPath)
  appendActionLog(ctx.vaultPath, {
    tool: 'generate_runbook',
    mode: 'apply',
    targets: [relativePath],
    summary: `Runbook aus ${sourceNotes.length} Quelle(n) erzeugt (${steps.length} Schritte, ${fixes.length} Workarounds)`,
    meta: { topic, sources: sourceNotes.map(source => source.path) },
  })

  return {
    path: relativePath,
    sourceCount: sourceNotes.length,
    stepCount: steps.length,
    fixCount: fixes.length,
  }
}
