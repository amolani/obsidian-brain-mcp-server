import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter } from './frontmatter-linter.ts'
import { isActiveNote } from './note-scope.ts'
import { stripFrontmatter } from './note-parser.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export type KnowledgeInboxActionKind = 'confirm_claim' | 'reject_claim' | 'runbook_preview' | 'review_client_alias'

export interface KnowledgeInboxItem {
  id: string
  kind: KnowledgeInboxActionKind
  title: string
  target: string
  detail: string
  fingerprint: string
}

export interface BrainApplyInboxItemOptions {
  itemId: string
  dryRun?: boolean
}

export interface BrainApplyInboxItemResult {
  dryRun: boolean
  item: KnowledgeInboxItem
  summary: string
  result: unknown
  state?: KnowledgeInboxItemState
}

export type KnowledgeInboxItemStatus = 'open' | 'accepted' | 'rejected' | 'snoozed' | 'superseded'

export interface KnowledgeInboxItemState {
  itemId: string
  kind: KnowledgeInboxActionKind
  target: string
  status: KnowledgeInboxItemStatus
  fingerprint: string
  updatedAt: string
  reason?: string
}

export interface KnowledgeInboxState {
  version: 1
  items: Record<string, KnowledgeInboxItemState>
}

export const KNOWLEDGE_INBOX_STATE_FILE = '.brain-knowledge-inbox-state.json'

export function knowledgeInboxItemId(kind: KnowledgeInboxActionKind, target: string): string {
  return `inbox:${kind}:${encodeURIComponent(target)}`
}

function itemFingerprint(kind: KnowledgeInboxActionKind, note: { relativePath: string; content: string; frontmatter: Record<string, any> }): string {
  return createHash('sha256')
    .update(kind)
    .update('\0')
    .update(note.relativePath)
    .update('\0')
    .update(JSON.stringify(note.frontmatter))
    .update('\0')
    .update(note.content)
    .digest('hex')
    .slice(0, 16)
}

function makeItem(
  kind: KnowledgeInboxActionKind,
  note: { relativePath: string; title: string; content: string; frontmatter: Record<string, any> },
  title: string,
  detail: string,
): KnowledgeInboxItem {
  return {
    id: knowledgeInboxItemId(kind, note.relativePath),
    kind,
    title,
    target: note.relativePath,
    detail,
    fingerprint: itemFingerprint(kind, note),
  }
}

function emptyState(): KnowledgeInboxState {
  return { version: 1, items: {} }
}

export function readKnowledgeInboxState(vault: Vault): KnowledgeInboxState {
  try {
    const path = vaultJoin(vault.vaultPath, KNOWLEDGE_INBOX_STATE_FILE)
    if (!existsSync(path)) return emptyState()
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<KnowledgeInboxState>
    if (parsed.version !== 1 || !parsed.items || typeof parsed.items !== 'object') return emptyState()
    return { version: 1, items: parsed.items as Record<string, KnowledgeInboxItemState> }
  } catch {
    return emptyState()
  }
}

function writeKnowledgeInboxState(vault: Vault, state: KnowledgeInboxState): void {
  assertCanWriteTool('brain_apply_inbox_item', [KNOWLEDGE_INBOX_STATE_FILE])
  writeFileSync(vaultJoin(vault.vaultPath, KNOWLEDGE_INBOX_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
}

function currentStateForItem(state: KnowledgeInboxState, item: KnowledgeInboxItem): KnowledgeInboxItemState | null {
  const record = state.items[item.id]
  if (!record) return null
  return record.fingerprint === item.fingerprint ? record : null
}

export function isKnowledgeInboxItemOpen(state: KnowledgeInboxState, item: KnowledgeInboxItem): boolean {
  const record = currentStateForItem(state, item)
  return !record || record.status === 'open'
}

export function recordKnowledgeInboxItemState(
  vault: Vault,
  item: KnowledgeInboxItem,
  status: Exclude<KnowledgeInboxItemStatus, 'open'>,
  reason?: string,
): KnowledgeInboxItemState {
  const state = readKnowledgeInboxState(vault)
  const record: KnowledgeInboxItemState = {
    itemId: item.id,
    kind: item.kind,
    target: item.target,
    status,
    fingerprint: item.fingerprint,
    updatedAt: new Date().toISOString(),
    reason,
  }
  state.items[item.id] = record
  writeKnowledgeInboxState(vault, state)
  appendActionLog(vault.vaultPath, {
    tool: 'brain_apply_inbox_item',
    mode: 'apply',
    targets: [KNOWLEDGE_INBOX_STATE_FILE],
    summary: `Knowledge Inbox State aktualisiert: ${item.id} -> ${status}`,
    meta: { itemId: item.id, status, kind: item.kind, target: item.target },
  })
  return record
}

function parseItemId(itemId: string): { kind: KnowledgeInboxActionKind; target: string } | null {
  const match = itemId.match(/^inbox:([^:]+):(.+)$/)
  if (!match) return null
  const kind = match[1] as KnowledgeInboxActionKind
  if (!['confirm_claim', 'reject_claim', 'runbook_preview', 'review_client_alias'].includes(kind)) return null
  return { kind, target: decodeURIComponent(match[2]) }
}

export function buildKnowledgeInboxItems(vault: Vault): KnowledgeInboxItem[] {
  const items: KnowledgeInboxItem[] = []
  for (const note of [...vault.notes.values()].sort((a, b) => b.lastModified - a.lastModified)) {
    if (!isActiveNote(note)) continue
    if (note.tags.includes('claim') && note.frontmatter.claim_status === 'provisional') {
      items.push(makeItem('confirm_claim', note, `Claim bestätigen: ${note.title}`, 'Setzt claim_status auf confirmed.'))
      items.push(makeItem('reject_claim', note, `Claim ablehnen: ${note.title}`, 'Setzt claim_status auf rejected.'))
    }

    const isCapture = note.tags.includes('auto-capture') || note.frontmatter.quelle === 'knowledge-harvester'
    if (!isCapture) continue
    if (['fuzzy_cwd', 'exact_content'].includes(String(note.frontmatter.client_match_method ?? ''))) {
      items.push(makeItem(
        'review_client_alias',
        note,
        `Kundenzuordnung prüfen: ${note.title}`,
        `Methode ${note.frontmatter.client_match_method}; Alias ${note.frontmatter.client_match_alias ?? '(keiner)'}.`,
      ))
    }
    if ((Number(note.frontmatter.runbook_readiness ?? 0) >= 55) || /## Durchgeführte Befehle/i.test(note.content)) {
      items.push(makeItem('runbook_preview', note, `Runbook Dry-Run: ${note.title}`, 'Führt generate_runbook dry-run-first für diesen Capture-Kontext aus.'))
    }
  }
  const state = readKnowledgeInboxState(vault)
  return items.filter(item => isKnowledgeInboxItemOpen(state, item))
}

function updateClaimStatus(vault: Vault, path: string, status: 'confirmed' | 'rejected', dryRun: boolean): unknown {
  const note = vault.notes.get(path)
  if (!note) throw new Error(`Claim nicht gefunden: ${path}`)
  const nextFrontmatter = {
    ...note.frontmatter,
    claim_status: status,
    aktualisiert: new Date().toISOString(),
  }
  const nextContent = `---\n${buildFrontmatter(nextFrontmatter)}---\n\n${stripFrontmatter(readFileSync(vaultJoin(vault.vaultPath, path), 'utf-8')).trimStart()}`
  if (dryRun) {
    return { path, before: note.frontmatter.claim_status ?? '(unset)', after: status }
  }
  assertCanWriteTool('brain_apply_inbox_item', [path])
  const fullPath = vaultJoin(vault.vaultPath, path)
  writeFileSync(fullPath, nextContent, 'utf-8')
  vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
  vault.buildLinkIndex()
  appendActionLog(vault.vaultPath, {
    tool: 'brain_apply_inbox_item',
    mode: 'apply',
    targets: [path],
    summary: `Claim status aktualisiert: ${path} -> ${status}`,
    meta: { claimStatus: status },
  })
  return { path, claimStatus: status }
}

export function brainApplyInboxItem(vault: Vault, options: BrainApplyInboxItemOptions): BrainApplyInboxItemResult {
  const dryRun = options.dryRun ?? true
  const parsed = parseItemId(options.itemId)
  if (!parsed) throw new Error(`Ungültige Knowledge-Inbox Item-ID: ${options.itemId}`)
  const item = buildKnowledgeInboxItems(vault).find(candidate => candidate.id === options.itemId)
  if (!item) throw new Error(`Knowledge-Inbox Item nicht gefunden oder nicht mehr aktuell: ${options.itemId}`)

  let result: unknown
  let nextStatus: Exclude<KnowledgeInboxItemStatus, 'open'> | null = null
  if (parsed.kind === 'confirm_claim') {
    result = updateClaimStatus(vault, parsed.target, 'confirmed', dryRun)
    nextStatus = 'accepted'
  } else if (parsed.kind === 'reject_claim') {
    result = updateClaimStatus(vault, parsed.target, 'rejected', dryRun)
    nextStatus = 'rejected'
  } else if (parsed.kind === 'runbook_preview') {
    const note = vault.notes.get(parsed.target)
    if (!note) throw new Error(`Capture nicht gefunden: ${parsed.target}`)
    const outputFolder = note.frontmatter.kunde ? `Kunden/${note.frontmatter.kunde}` : 'Knowledge/Runbooks'
    result = vault.generateRunbook(note.frontmatter.kunde ? String(note.frontmatter.kunde) : basename(parsed.target, '.md'), {
      outputFolder,
      dryRun,
    })
    nextStatus = 'accepted'
  } else {
    const note = vault.notes.get(parsed.target)
    result = {
      target: parsed.target,
      suggestion: note
        ? `"${note.frontmatter.client_match_alias ?? note.frontmatter.kunde ?? 'Kunde'}": ["${note.frontmatter.client_match_candidate ?? 'alias'}"]`
        : 'Capture nicht gefunden',
      applied: false,
      reason: 'Alias-Lernen bleibt absichtlich manuell, weil clients.json Projektkonfiguration ist.',
    }
    nextStatus = 'accepted'
  }

  const state = !dryRun && nextStatus
    ? recordKnowledgeInboxItemState(vault, item, nextStatus, `Action ${parsed.kind} ausgeführt`)
    : undefined

  return {
    dryRun,
    item,
    summary: dryRun ? `Dry-Run für ${item.id} ausgeführt` : `Knowledge-Inbox Item angewendet und State gespeichert: ${item.id}`,
    result,
    state,
  }
}
