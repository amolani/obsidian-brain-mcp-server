import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter, normalizeTag } from './frontmatter-linter.ts'
import { assertCanWriteTool } from './policy.ts'
import { assertSingleLineText, sanitizePathSegment, uniqueRelativePath, vaultJoin } from './vault-paths.ts'

export interface CreateResearchPlanOptions {
  topic: string
  question?: string
  scope?: string
  sources?: string[]
  dryRun?: boolean
}

export interface ResearchPlanResult {
  dryRun: boolean
  path: string
  topic: string
  content: string
  contextCount: number
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function renderSourceLines(sources: string[] = []): string {
  return sources.length > 0
    ? sources.map(source => `- ${source}`).join('\n')
    : '- Noch keine externen Quellen festgelegt'
}

export function createResearchPlan(vault: Vault, options: CreateResearchPlanOptions): ResearchPlanResult {
  const dryRun = options.dryRun ?? true
  const topic = assertSingleLineText(options.topic, 'Topic')

  const question = options.question?.trim() || topic
  const pack = vault.buildContextPack({ query: topic, maxNotes: 6, includeLinked: true })
  const contextNotes = [...pack.primary, ...pack.linked]
  const contextLines = contextNotes.length > 0
    ? contextNotes.map(note => `- [[${note.path}|${note.title}]] (Score ${note.score})`).join('\n')
    : '- Keine belastbaren Vault-Treffer gefunden'
  const todoLines = pack.openTodos.length > 0
    ? pack.openTodos.slice(0, 10).map(todo => `- [ ] [[${todo.path}]]: ${todo.text}`).join('\n')
    : '- Keine offenen TODOs im Kontext'
  const scope = options.scope?.trim() || 'Lokale Vault-Recherche zuerst; externe Quellen nur manuell und quellenkritisch ergänzen.'
  const fileStem = sanitizePathSegment(topic)
  if (!fileStem) throw new Error('Topic ergibt keinen gültigen Dateinamen')
  const path = dryRun
    ? `Knowledge/Research/${fileStem}.md`
    : uniqueRelativePath(vault.vaultPath, 'Knowledge/Research', `${fileStem}.md`)
  const tags = ['research-plan', 'open-question'].map(normalizeTag)
  const content = `---\n${buildFrontmatter({
    status: 'open',
    tags,
    datum: today(),
    topic,
  })}---\n\n# Research Plan: ${topic}\n\n## Leitfrage\n\n${question}\n\n## Scope\n\n${scope}\n\n## Bekannter Vault-Kontext\n\n${contextLines}\n\n## Offene TODOs im Kontext\n\n${todoLines}\n\n## Quellenkandidaten\n\n${renderSourceLines(options.sources)}\n\n## Recherche-Schritte\n\n- [ ] Vault-Kontext pruefen und Duplikate ausschliessen\n- [ ] Primaerquellen sammeln und unter \`.raw/\` ablegen, falls sie dauerhaft relevant sind\n- [ ] Relevante Quellen mit \`ingest_source\` als Dry-Run pruefen\n- [ ] Ergebnis als \`save_answer\`, \`save_decision\` oder Runbook speichern\n- [ ] Widersprueche mit \`flag_contradiction\` sichtbar machen\n`

  if (!dryRun) {
    assertCanWriteTool('create_research_plan', [path])
    const fullPath = vaultJoin(vault.vaultPath, path)
    mkdirSync(vaultJoin(vault.vaultPath, 'Knowledge/Research'), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'create_research_plan',
      mode: 'apply',
      targets: [path],
      summary: `Research Plan erstellt: ${topic}`,
      meta: { contextCount: contextNotes.length },
    })
  }

  return {
    dryRun,
    path,
    topic,
    content,
    contextCount: contextNotes.length,
  }
}
