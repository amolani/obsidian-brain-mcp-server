import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter } from './frontmatter-linter.ts'
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
}

export function knowledgeInboxItemId(kind: KnowledgeInboxActionKind, target: string): string {
  return `inbox:${kind}:${encodeURIComponent(target)}`
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
    if (note.tags.includes('claim') && note.frontmatter.claim_status === 'provisional') {
      items.push({
        id: knowledgeInboxItemId('confirm_claim', note.relativePath),
        kind: 'confirm_claim',
        title: `Claim bestätigen: ${note.title}`,
        target: note.relativePath,
        detail: 'Setzt claim_status auf confirmed.',
      })
      items.push({
        id: knowledgeInboxItemId('reject_claim', note.relativePath),
        kind: 'reject_claim',
        title: `Claim ablehnen: ${note.title}`,
        target: note.relativePath,
        detail: 'Setzt claim_status auf rejected.',
      })
    }

    const isCapture = note.tags.includes('auto-capture') || note.frontmatter.quelle === 'knowledge-harvester'
    if (!isCapture) continue
    if (['fuzzy_cwd', 'exact_content'].includes(String(note.frontmatter.client_match_method ?? ''))) {
      items.push({
        id: knowledgeInboxItemId('review_client_alias', note.relativePath),
        kind: 'review_client_alias',
        title: `Kundenzuordnung prüfen: ${note.title}`,
        target: note.relativePath,
        detail: `Methode ${note.frontmatter.client_match_method}; Alias ${note.frontmatter.client_match_alias ?? '(keiner)'}.`,
      })
    }
    if ((Number(note.frontmatter.runbook_readiness ?? 0) >= 55) || /## Durchgeführte Befehle/i.test(note.content)) {
      items.push({
        id: knowledgeInboxItemId('runbook_preview', note.relativePath),
        kind: 'runbook_preview',
        title: `Runbook Dry-Run: ${note.title}`,
        target: note.relativePath,
        detail: 'Führt generate_runbook dry-run-first für diesen Capture-Kontext aus.',
      })
    }
  }
  return items
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
  if (parsed.kind === 'confirm_claim') {
    result = updateClaimStatus(vault, parsed.target, 'confirmed', dryRun)
  } else if (parsed.kind === 'reject_claim') {
    result = updateClaimStatus(vault, parsed.target, 'rejected', dryRun)
  } else if (parsed.kind === 'runbook_preview') {
    const note = vault.notes.get(parsed.target)
    if (!note) throw new Error(`Capture nicht gefunden: ${parsed.target}`)
    const outputFolder = note.frontmatter.kunde ? `Kunden/${note.frontmatter.kunde}` : 'Knowledge/Runbooks'
    result = vault.generateRunbook(note.frontmatter.kunde ? String(note.frontmatter.kunde) : basename(parsed.target, '.md'), {
      outputFolder,
      dryRun,
    })
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
  }

  return {
    dryRun,
    item,
    summary: dryRun ? `Dry-Run für ${item.id} ausgeführt` : `Knowledge-Inbox Item angewendet: ${item.id}`,
    result,
  }
}
