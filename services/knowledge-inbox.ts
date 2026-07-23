import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { assertGeneratedSurfaceOwnership } from './generated-surface-ownership.ts'
import { classifyIntent, isMutatingCommand, performedCommands } from './intent-classifier.ts'
import {
  buildAllKnowledgeInboxItems,
  effectiveKnowledgeInboxItemStatus,
  knowledgeInboxItemId,
  readKnowledgeInboxState,
} from './knowledge-inbox-actions.ts'
import { isActiveNote, isAutoCaptureNote } from './note-scope.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export interface BuildKnowledgeInboxOptions {
  dryRun?: boolean
  adoptLegacyOwnership?: boolean
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
  return isActiveNote(note) && isAutoCaptureNote(note)
}

function link(note: NoteEntry): string {
  return `[[${note.relativePath}|${note.title}]]`
}

function lines(values: string[]): string {
  return values.length > 0 ? values.map(value => `- ${value}`).join('\n') : '- Keine'
}

function uncertainClientLine(note: NoteEntry): string | null {
  const method = String(note.frontmatter.client_match_method ?? '')
  if (!['fuzzy_cwd', 'exact_content', 'unknown_cwd'].includes(method)) return null
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
    .filter(isActiveNote)
    .filter(note => note.tags.includes('claim') && note.frontmatter.claim_status === 'provisional')
    .sort((a, b) => b.lastModified - a.lastModified)
  const uncertainClients = captures.map(uncertainClientLine).filter((value): value is string => !!value)
  const runbookCandidates = captures.map(runbookCandidateLine).filter((value): value is string => !!value)
  const allInboxItems = buildAllKnowledgeInboxItems(vault)
  const state = readKnowledgeInboxState(vault)
  const inboxItems = allInboxItems.filter(item => effectiveKnowledgeInboxItemStatus(state, item) === 'open')
  const active = new Set(inboxItems.map(item => `${item.kind}:${item.target}`))
  const activeProvisionalClaims = provisionalClaims.map(note => ({
    note,
    actionIds: [
      knowledgeInboxItemId('confirm_claim', note.relativePath),
      knowledgeInboxItemId('reject_claim', note.relativePath),
    ].filter(itemId => inboxItems.some(item => item.id === itemId)),
  })).filter(entry => entry.actionIds.length > 0)
  const activeUncertainClients = uncertainClients.filter(line => {
    const match = line.match(/\[\[([^|\]]+)/)
    return match ? active.has(`review_client_alias:${match[1]}`) : true
  })
  const activeRunbookCandidates = runbookCandidates.filter(line => {
    const match = line.match(/\[\[([^|\]]+)/)
    return match ? active.has(`runbook_preview:${match[1]}`) : true
  })
  const activeSkipped = inboxItems.filter(item => item.kind === 'review_auto_build_skip').slice(0, 30)
  const activeImpacts = inboxItems
    .filter(item => item.kind === 'review_impact_report')
    .map(item => ({ item, note: vault.notes.get(item.target) }))
    .filter((entry): entry is { item: typeof entry.item; note: NoteEntry } => !!entry.note)
    .slice(0, 20)
  const persistedStateCount = Object.keys(state.items).length
  const statusCounts = allInboxItems.reduce<Record<string, number>>((counts, item) => {
    const status = effectiveKnowledgeInboxItemStatus(state, item)
    counts[status] = (counts[status] ?? 0) + 1
    return counts
  }, {})
  const content = `---\nstatus: aktiv\ntags:\n  - knowledge-inbox\n  - maintenance\naktualisiert: ${new Date().toISOString()}\nquelle: knowledge-inbox\n---\n\n# Knowledge Inbox\n\n## Queue State\n\n- Offene Actions: ${inboxItems.length}\n- Akzeptiert: ${statusCounts.accepted ?? 0}\n- Abgelehnt: ${statusCounts.rejected ?? 0}\n- Snoozed: ${statusCounts.snoozed ?? 0}\n- Superseded: ${statusCounts.superseded ?? 0}\n- Persistierte Item-States: ${persistedStateCount}\n- Bereits bearbeitete Items bleiben ausgeblendet, solange sich die Quelle nicht ändert. Abgelaufene Snoozes werden automatisch wieder geöffnet.\n\n## Provisional Claims\n\n${lines(activeProvisionalClaims.slice(0, 30).map(({ note, actionIds }) => `${link(note)} - Quelle: \`${note.frontmatter.quelle ?? 'unbekannt'}\`; Actions: ${actionIds.map(itemId => `\`${itemId}\``).join(', ')}`))}\n\n## Kundenzuordnung prüfen\n\n${lines(activeUncertainClients.slice(0, 30))}\n\n## Runbook-Kandidaten\n\n${lines(activeRunbookCandidates.slice(0, 30))}\n\n## Auto-Build Skips\n\n${lines(activeSkipped.map(item => `[[${item.sourcePath}|${basename(item.sourcePath!, '.md')}]] - \`${item.action}\`: ${item.detail}; Action: \`${item.id}\``))}\n\n## Inbox Actions\n\n${lines(inboxItems.slice(0, 40).map(item => `\`${item.id}\` - **${item.risk} risk** - ${item.title}: ${item.detail}`))}\n\n## Letzte Impact Reports\n\n${lines(activeImpacts.map(({ item, note }) => `${link(note)} - Action: \`${item.id}\``))}\n\n## Nächste Aktionen\n\n- Provisional Claims nur mit brain_apply_inbox_item bestätigen oder ablehnen, damit die fachliche Claim-Änderung ausgeführt wird.\n- Unsichere Kundenzuordnungen prüfen und stabile Aliase in clients.json ergänzen.\n- Runbook-Kandidaten zuerst mit generate_runbook dry-run ansehen.\n- brain_review_inbox_items verwaltet open/accepted/rejected/snoozed/superseded; Batches sind nur für low-risk Items erlaubt.\n- Auto-Build Skips als Qualitätsfeedback behandeln, nicht blind umgehen.\n`

  const result = {
    dryRun,
    path: KNOWLEDGE_INBOX_PATH,
    provisionalClaimCount: activeProvisionalClaims.length,
    uncertainClientCount: activeUncertainClients.length,
    runbookCandidateCount: activeRunbookCandidates.length,
    skippedAutoBuildCount: activeSkipped.length,
    impactReportCount: activeImpacts.length,
    openItemCount: inboxItems.length,
    persistedStateCount,
    content,
  }

  if (!dryRun) {
    assertCanWriteTool('build_knowledge_inbox', [KNOWLEDGE_INBOX_PATH])
    assertGeneratedSurfaceOwnership(vault.vaultPath, KNOWLEDGE_INBOX_PATH, 'knowledge-inbox', {
      allowRecognizedLegacy: options.adoptLegacyOwnership === true,
    })
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
