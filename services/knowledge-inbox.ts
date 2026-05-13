import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { classifyIntent, isMutatingCommand, performedCommands } from './intent-classifier.ts'
import { buildKnowledgeInboxItems, knowledgeInboxItemId, readKnowledgeInboxState } from './knowledge-inbox-actions.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export interface BuildKnowledgeInboxOptions {
  dryRun?: boolean
}

export interface KnowledgeInboxResult {
  dryRun: boolean
  path: string
  provisionalClaimCount: number
  uncertainClientCount: number
  runbookCandidateCount: number
  skippedAutoBuildCount: number
  impactReportCount: number
  openItemCount: number
  persistedStateCount: number
  content: string
}

const KNOWLEDGE_INBOX_PATH = 'Maintenance/Knowledge Inbox.md'

function isCapture(note: NoteEntry): boolean {
  return note.tags.includes('auto-capture') || note.frontmatter.quelle === 'knowledge-harvester'
}

function link(note: NoteEntry): string {
  return `[[${note.relativePath}|${note.title}]]`
}

function lines(values: string[]): string {
  return values.length > 0 ? values.map(value => `- ${value}`).join('\n') : '- Keine'
}

function readManifest(vault: Vault): Array<{ sourcePath: string; action: string; title: string; reason: string }> {
  try {
    const text = readFileSync(vaultJoin(vault.vaultPath, '.brain-auto-build-manifest.json'), 'utf-8')
    const parsed = JSON.parse(text) as { sources?: Record<string, { plan?: Array<{ action?: string; title?: string; quality?: string; reason?: string }> }> }
    const rows: Array<{ sourcePath: string; action: string; title: string; reason: string }> = []
    for (const [sourcePath, entry] of Object.entries(parsed.sources ?? {})) {
      for (const item of entry.plan ?? []) {
        if (item.quality !== 'skip') continue
        rows.push({
          sourcePath,
          action: String(item.action ?? 'unknown'),
          title: String(item.title ?? item.action ?? 'Auto-Build Skip'),
          reason: String(item.reason ?? 'quality gate'),
        })
      }
    }
    return rows
  } catch {
    return []
  }
}

function uncertainClientLine(note: NoteEntry): string | null {
  const method = String(note.frontmatter.client_match_method ?? '')
  if (!['fuzzy_cwd', 'exact_content'].includes(method)) return null
  const confidence = String(note.frontmatter.client_match_confidence ?? 'unknown')
  const candidate = note.frontmatter.client_match_candidate ? `; Kandidat: \`${note.frontmatter.client_match_candidate}\`` : ''
  const alias = note.frontmatter.client_match_alias ? `; Alias: \`${note.frontmatter.client_match_alias}\`` : ''
  return `${link(note)} - ${method}/${confidence}${candidate}${alias}`
}

function runbookCandidateLine(note: NoteEntry): string | null {
  if (String(note.frontmatter.source_stage ?? '') === 'checkpoint') return null
  const intent = note.frontmatter.session_intent
    ? { intent: String(note.frontmatter.session_intent), confidence: String(note.frontmatter.intent_confidence ?? 'unknown') }
    : classifyIntent(note.content, note.tags)
  if (!['implementation', 'troubleshooting'].includes(intent.intent)) return null
  const mutating = performedCommands(note.content).filter(isMutatingCommand)
  if (mutating.length === 0) return null
  return `${link(note)} - Intent ${intent.intent}/${intent.confidence}; ${mutating.length} umsetzende Befehl(e)`
}

export function buildKnowledgeInbox(vault: Vault, options: BuildKnowledgeInboxOptions = {}): KnowledgeInboxResult {
  const dryRun = options.dryRun ?? true
  const captures = [...vault.notes.values()].filter(isCapture).sort((a, b) => b.lastModified - a.lastModified)
  const provisionalClaims = [...vault.notes.values()]
    .filter(note => note.tags.includes('claim') && note.frontmatter.claim_status === 'provisional')
    .sort((a, b) => b.lastModified - a.lastModified)
  const uncertainClients = captures.map(uncertainClientLine).filter((value): value is string => !!value)
  const runbookCandidates = captures.map(runbookCandidateLine).filter((value): value is string => !!value)
  const skipped = readManifest(vault).slice(0, 30)
  const impacts = [...vault.notes.values()]
    .filter(note => note.relativePath.startsWith('Maintenance/Session Impact/') || note.tags.includes('session-impact'))
    .sort((a, b) => b.lastModified - a.lastModified)

  const inboxItems = buildKnowledgeInboxItems(vault)
  const active = new Set(inboxItems.map(item => `${item.kind}:${item.target}`))
  const activeUncertainClients = uncertainClients.filter(line => {
    const match = line.match(/\[\[([^|\]]+)/)
    return match ? active.has(`review_client_alias:${match[1]}`) : true
  })
  const activeRunbookCandidates = runbookCandidates.filter(line => {
    const match = line.match(/\[\[([^|\]]+)/)
    return match ? active.has(`runbook_preview:${match[1]}`) : true
  })
  const state = readKnowledgeInboxState(vault)
  const persistedStateCount = Object.keys(state.items).length
  const content = `---\nstatus: aktiv\ntags:\n  - knowledge-inbox\n  - maintenance\naktualisiert: ${new Date().toISOString()}\nquelle: knowledge-inbox\n---\n\n# Knowledge Inbox\n\n## Queue State\n\n- Offene Actions: ${inboxItems.length}\n- Persistierte Item-States: ${persistedStateCount}\n- Bereits bearbeitete Items bleiben ausgeblendet, solange sich die Quelle nicht ändert.\n\n## Provisional Claims\n\n${lines(provisionalClaims.slice(0, 30).map(note => `${link(note)} - Quelle: \`${note.frontmatter.quelle ?? 'unbekannt'}\`; Actions: \`${knowledgeInboxItemId('confirm_claim', note.relativePath)}\`, \`${knowledgeInboxItemId('reject_claim', note.relativePath)}\``))}\n\n## Kundenzuordnung prüfen\n\n${lines(activeUncertainClients.slice(0, 30))}\n\n## Runbook-Kandidaten\n\n${lines(activeRunbookCandidates.slice(0, 30))}\n\n## Auto-Build Skips\n\n${lines(skipped.map(item => `[[${item.sourcePath}|${basename(item.sourcePath, '.md')}]] - \`${item.action}\`: ${item.reason}`))}\n\n## Inbox Actions\n\n${lines(inboxItems.slice(0, 40).map(item => `\`${item.id}\` - ${item.title}: ${item.detail}`))}\n\n## Letzte Impact Reports\n\n${lines(impacts.slice(0, 20).map(link))}\n\n## Nächste Aktionen\n\n- Provisional Claims nur bestätigen, wenn Quelle und Gültigkeit belastbar sind.\n- Unsichere Kundenzuordnungen prüfen und stabile Aliase in clients.json ergänzen.\n- Runbook-Kandidaten zuerst mit generate_runbook dry-run ansehen.\n- Auto-Build Skips als Qualitätsfeedback behandeln, nicht blind umgehen.\n`

  const result = {
    dryRun,
    path: KNOWLEDGE_INBOX_PATH,
    provisionalClaimCount: provisionalClaims.length,
    uncertainClientCount: activeUncertainClients.length,
    runbookCandidateCount: activeRunbookCandidates.length,
    skippedAutoBuildCount: skipped.length,
    impactReportCount: impacts.length,
    openItemCount: inboxItems.length,
    persistedStateCount,
    content,
  }

  if (!dryRun) {
    assertCanWriteTool('build_knowledge_inbox', [KNOWLEDGE_INBOX_PATH])
    mkdirSync(join(vault.vaultPath, 'Maintenance'), { recursive: true })
    const fullPath = vaultJoin(vault.vaultPath, KNOWLEDGE_INBOX_PATH)
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'build_knowledge_inbox',
      mode: 'apply',
      targets: [KNOWLEDGE_INBOX_PATH],
      summary: `Knowledge Inbox aktualisiert (${result.provisionalClaimCount} provisional Claims, ${result.runbookCandidateCount} Runbook-Kandidaten)`,
      meta: {
        provisionalClaims: result.provisionalClaimCount,
        uncertainClients: result.uncertainClientCount,
        runbookCandidates: result.runbookCandidateCount,
        skippedAutoBuild: result.skippedAutoBuildCount,
      },
    })
  }

  return result
}
