import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export interface BuildKnowledgeIndexOptions {
  dryRun?: boolean
}

export interface KnowledgeIndexResult {
  dryRun: boolean
  path: string
  noteCount: number
  sectionCount: number
  content: string
}

const INDEX_PATH = 'Knowledge/index.md'

function countByPrefix(vault: Vault, prefix: string): number {
  return [...vault.notes.keys()].filter(path => path.startsWith(prefix)).length
}

function topTags(vault: Vault): string[] {
  const counts = new Map<string, number>()
  for (const note of vault.notes.values()) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => `- #${tag} (${count})`)
}

function recentNotes(vault: Vault): string[] {
  return [...vault.notes.values()]
    .filter(note => !note.relativePath.startsWith('Archiv/'))
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, 12)
    .map(note => `- [[${note.relativePath}|${note.title}]]`)
}

function openKnowledgeQuestions(vault: Vault): string[] {
  return [...vault.notes.values()]
    .filter(note => note.relativePath.startsWith('Knowledge/Gaps/') && note.frontmatter.status !== 'resolved')
    .slice(0, 12)
    .map(note => `- [[${note.relativePath}|${note.title}]]`)
}

function linesOrEmpty(lines: string[]): string {
  return lines.length > 0 ? lines.join('\n') : '- Keine Einträge'
}

function renderKnowledgeIndex(vault: Vault): string {
  const folders = [
    ['Kunden', 'Kunden/'],
    ['Technik', 'Technik/'],
    ['Referenz', 'Referenz/'],
    ['Runbooks', 'Runbooks/'],
    ['Knowledge', 'Knowledge/'],
    ['Archiv', 'Archiv/'],
  ]
  const folderLines = folders.map(([label, prefix]) => `- ${label}: ${countByPrefix(vault, prefix)} Notizen`)

  return `---\nstatus: aktiv\ntags:\n  - knowledge-index\naktualisiert: ${new Date().toISOString()}\n---\n\n# Knowledge Index\n\n## Bereiche\n\n${folderLines.join('\n')}\n\n## Häufige Tags\n\n${linesOrEmpty(topTags(vault))}\n\n## Zuletzt aktive Notizen\n\n${linesOrEmpty(recentNotes(vault))}\n\n## Offene Wissenslücken\n\n${linesOrEmpty(openKnowledgeQuestions(vault))}\n`
}

export function buildKnowledgeIndex(vault: Vault, options: BuildKnowledgeIndexOptions = {}): KnowledgeIndexResult {
  const dryRun = options.dryRun ?? true
  const content = renderKnowledgeIndex(vault)
  const sectionCount = [...content.matchAll(/^##\s+/gm)].length

  if (!dryRun) {
    assertCanWriteTool('build_knowledge_index', [INDEX_PATH])
    const fullPath = vaultJoin(vault.vaultPath, INDEX_PATH)
    mkdirSync(vaultJoin(vault.vaultPath, 'Knowledge'), { recursive: true })
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'build_knowledge_index',
      mode: 'apply',
      targets: [INDEX_PATH],
      summary: `Knowledge Index aktualisiert (${vault.notes.size} Notizen)`,
      meta: { sectionCount },
    })
  }

  return {
    dryRun,
    path: INDEX_PATH,
    noteCount: vault.notes.size,
    sectionCount,
    content,
  }
}
