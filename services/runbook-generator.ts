import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { NoteEntry } from '../vault.ts'
import { loadClients } from '../config.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter, normalizeTag } from './frontmatter-linter.ts'
import { assertGeneratedSurfaceOwnership } from './generated-surface-ownership.ts'
import { isActiveNote, isAutoCaptureNote } from './note-scope.ts'
import { assertCanWriteTool } from './policy.ts'
import { redactSecrets } from './secret-redaction.ts'
import {
  hasCompleteDigestProvenance,
  parseSessionDigestFacts,
  type ParsedDigestFact,
} from './session-digest-facts.ts'
import { assertSafeRelativePath, assertSingleLineText, sanitizePathSegment, vaultJoin } from './vault-paths.ts'

export interface GenerateRunbookResult {
  dryRun: boolean
  path: string
  sourceCount: number
  stepCount: number
  fixCount: number
  content: string
}

export interface GenerateRunbookOptions {
  outputFolder?: string
  dryRun?: boolean
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

interface StructuredRunbookEvidence {
  sourcePath: string
  sourceTitle: string
  fact: ParsedDigestFact
}

interface RunbookParts {
  steps: string[]
  fixes: string[]
  summaries: string[]
  validations: string[]
  structuredEvidence: StructuredRunbookEvidence[]
}

const MIN_STRUCTURED_SALIENCE = 60
const MIN_STRUCTURED_EVIDENCE = 75
const MAX_STRUCTURED_FACTS = 20
const MAX_PROVENANCE_PER_FACT = 4

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
    if (!isActiveNote(entry)) continue
    const frontmatterTags = Array.isArray(entry.frontmatter.tags)
      ? entry.frontmatter.tags.map(tag => String(tag).toLowerCase())
      : []
    const isAutoCapture = isAutoCaptureNote(entry) || frontmatterTags.includes('prozedur')
    if (!isAutoCapture || !sourceMatchesTopic(relativePath, entry, topicLower, true)) continue
    sourceNotes.push({
      path: relativePath,
      title: entry.title,
      content: entry.content,
      datum: entry.frontmatter.datum || '',
    })
  }

  for (const [relativePath, entry] of notes) {
    if (!isActiveNote(entry)) continue
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

function safeFactStatement(value: string): string {
  return redactSecrets(value).content.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function isStrongStructuredRunbookFact(fact: ParsedDigestFact): boolean {
  return ['change', 'verification'].includes(fact.kind)
    && fact.salienceScore >= MIN_STRUCTURED_SALIENCE
    && fact.evidenceScore >= MIN_STRUCTURED_EVIDENCE
    && hasCompleteDigestProvenance(fact)
}

function extractRunbookParts(sourceNotes: RunbookSource[]): RunbookParts {
  const steps: string[] = []
  const fixes: string[] = []
  const summaries: string[] = []
  const validations: string[] = []
  const structuredEvidence: StructuredRunbookEvidence[] = []
  const structuredSources = new Set<string>()
  const seenSteps = new Set<string>()
  const seenValidations = new Set<string>()

  for (const note of sourceNotes) {
    const digest = parseSessionDigestFacts(note.content)
    if (digest.hasDigest) {
      // A structured capture is a hard format boundary: never fall back to
      // legacy prose sections from the same note. Only evidence-complete,
      // strongly scored change and verification facts may enter the runbook.
      structuredSources.add(note.path)
      const facts = digest.facts.filter(isStrongStructuredRunbookFact).slice(0, MAX_STRUCTURED_FACTS)
      for (const fact of facts) {
        const statement = safeFactStatement(fact.statement)
        if (!statement) continue
        const key = statement.toLowerCase()
        if (fact.kind === 'change' && !seenSteps.has(key)) {
          seenSteps.add(key)
          steps.push(statement)
        } else if (fact.kind === 'verification' && !seenValidations.has(key)) {
          seenValidations.add(key)
          validations.push(`- ${statement}`)
        }
        structuredEvidence.push({ sourcePath: note.path, sourceTitle: note.title, fact })
      }
      continue
    }

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

    const validationSection = note.content.match(/## Validierung\n\n([\s\S]*?)(?=\n## |$)/i)
    if (validationSection) validations.push(validationSection[1].trim())
  }

  for (const note of sourceNotes) {
    if (structuredSources.has(note.path)) continue
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

  return { steps, fixes, summaries, validations, structuredEvidence }
}

function renderStructuredEvidence(items: StructuredRunbookEvidence[]): string {
  return items.map(({ sourcePath, sourceTitle, fact }) => {
    const kind = fact.kind === 'change' ? 'Änderung' : 'Verifikation'
    const references = fact.provenance
      .slice(0, MAX_PROVENANCE_PER_FACT)
      .map(item => `\`${redactSecrets(item.ref).content}\` (Hash \`${item.hash}\`)`)
      .join(', ')
    return `- [${fact.id}] [[${sourcePath}|${sourceTitle}]] · ${kind} · Salienz ${fact.salienceScore}/100 · Evidenz ${fact.evidenceScore}/100 · ${references}`
  }).join('\n')
}

function renderRunbook(topic: string, sourceNotes: RunbookSource[], parts: RunbookParts): string {
  const { steps, fixes, summaries, validations, structuredEvidence } = parts
  const datum = today()
  const topicLower = topic.toLowerCase()
  const tags = ['runbook', normalizeTag(topicLower)]
  const sourceLinks = sourceNotes.map(source => `- [[${source.path}|${source.title}]]`).join('\n')
  const validationText = validations.length > 0
    ? validations.join('\n\n')
    : '- Ergebnis gegen betroffene Systeme pruefen.\n- Logs nach Fehlern durchsuchen.\n- Relevante Kunden-/Projekt-Notiz aktualisieren.'

  let content = `---
${buildFrontmatter({ status: 'aktiv', tags, datum, quellen: sourceNotes.length, quelle: 'runbook-generator' })}---

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

  content += `\n## Voraussetzungen\n\n- Zugriff auf die betroffenen Systeme ist vorhanden.\n- Relevante Quell-Notizen wurden geprueft.\n- Aenderungen werden erst nach Review angewendet.\n`

  if (steps.length > 0) {
    content += `\n## Schritte\n\n${steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n`
  }

  content += `\n## Validierung\n\n${validationText}\n`

  if (structuredEvidence.length > 0) {
    content += `\n## Evidenz\n\n${renderStructuredEvidence(structuredEvidence)}\n`
  }

  content += `\n## Rollback\n\n- Letzte funktionierende Konfiguration wiederherstellen.\n- Geaenderte Dienste kontrolliert neu starten.\n- Abweichungen als Knowledge Gap oder Incident erfassen.\n`

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

export function generateRunbook(ctx: RunbookGeneratorContext, topic: string, options: GenerateRunbookOptions | string = {}): GenerateRunbookResult {
  const outputFolder = typeof options === 'string' ? options : options.outputFolder
  // The legacy string overload selects only the folder; it must not silently
  // turn an otherwise dry-run-first operation into an apply.
  const dryRun = typeof options === 'string' ? true : options.dryRun ?? true
  const safeTopic = assertSingleLineText(topic, 'topic')
  const topicLower = safeTopic.toLowerCase()
  const sourceNotes = collectSources(ctx.notes, topicLower)
  if (sourceNotes.length === 0) {
    throw new Error(`Keine Quell-Notizen für "${safeTopic}" gefunden. Arbeite zuerst am Projekt — der Knowledge Harvester erstellt automatisch Captures.`)
  }

  const parts = extractRunbookParts(sourceNotes)
  const { steps, fixes } = parts
  const content = renderRunbook(safeTopic, sourceNotes, parts)
  const folder = assertSafeRelativePath(outputFolderForTopic(topicLower, outputFolder))
  const safeTitle = sanitizePathSegment(`Runbook ${safeTopic}`).slice(0, 100)
  if (!safeTitle) throw new Error('topic ergibt keinen gültigen Dateinamen')
  const relativePath = `${folder}/${safeTitle}.md`
  const fullDir = vaultJoin(ctx.vaultPath, folder)
  const fullPath = vaultJoin(ctx.vaultPath, relativePath)

  if (dryRun) {
    return {
      dryRun,
      path: relativePath,
      sourceCount: sourceNotes.length,
      stepCount: steps.length,
      fixCount: fixes.length,
      content,
    }
  }

  assertCanWriteTool('generate_runbook', [relativePath])
  assertGeneratedSurfaceOwnership(ctx.vaultPath, relativePath, 'runbook-generator')
  mkdirSync(fullDir, { recursive: true })
  writeFileSync(fullPath, content, 'utf-8')

  const stat = statSync(fullPath)
  ctx.indexNote(fullPath, stat.mtimeMs)
  ctx.buildLinkIndex()

  appendActionLog(ctx.vaultPath, {
    tool: 'generate_runbook',
    mode: 'apply',
    targets: [relativePath],
    summary: `Runbook aus ${sourceNotes.length} Quelle(n) erzeugt (${steps.length} Schritte, ${fixes.length} Workarounds)`,
    meta: { topic: safeTopic, sources: sourceNotes.map(source => source.path) },
  })

  return {
    dryRun,
    path: relativePath,
    sourceCount: sourceNotes.length,
    stepCount: steps.length,
    fixCount: fixes.length,
    content,
  }
}
