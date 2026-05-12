import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { scoreCapture } from './capture-scoring.ts'
import { buildFrontmatter } from './frontmatter-linter.ts'
import { classifyIntent } from './intent-classifier.ts'
import { stripFrontmatter } from './note-parser.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export interface MigrateBrainMetadataOptions {
  dryRun?: boolean
  limit?: number
}

export interface BrainMetadataMigrationChange {
  path: string
  fields: string[]
}

export interface BrainMetadataMigrationResult {
  dryRun: boolean
  scanned: number
  changed: BrainMetadataMigrationChange[]
}

function isCapture(note: NoteEntry): boolean {
  return note.tags.includes('auto-capture') || note.frontmatter.quelle === 'knowledge-harvester'
}

function isClaim(note: NoteEntry): boolean {
  return note.tags.includes('claim') || note.relativePath.startsWith('Knowledge/Claims/')
}

function updateNote(vault: Vault, note: NoteEntry, frontmatter: Record<string, any>): void {
  const fullPath = vaultJoin(vault.vaultPath, note.relativePath)
  const body = stripFrontmatter(readFileSync(fullPath, 'utf-8')).trimStart()
  writeFileSync(fullPath, `---\n${buildFrontmatter(frontmatter)}---\n\n${body}`, 'utf-8')
  vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
}

export function migrateBrainMetadata(vault: Vault, options: MigrateBrainMetadataOptions = {}): BrainMetadataMigrationResult {
  const dryRun = options.dryRun ?? true
  const changed: BrainMetadataMigrationChange[] = []
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000))
  const notes = [...vault.notes.values()].slice(0, limit)

  for (const note of notes) {
    const next = { ...note.frontmatter }
    const fields: string[] = []

    if (isCapture(note)) {
      const intent = note.frontmatter.session_intent
        ? { intent: String(note.frontmatter.session_intent), confidence: String(note.frontmatter.intent_confidence ?? 'low') }
        : classifyIntent(note.content, note.tags)
      const scores = scoreCapture({
        content: note.content,
        tags: note.tags,
        intent,
        clientMatchMethod: String(note.frontmatter.client_match_method ?? 'none'),
        redactionCount: Number(note.frontmatter.redactions ?? 0),
      })
      const defaults: Record<string, any> = {
        knowledge_type: 'capture',
        source_stage: 'stop_capture',
        session_intent: intent.intent,
        intent_confidence: intent.confidence,
        sensitive: note.frontmatter.sensitive ?? false,
        redactions: note.frontmatter.redactions ?? 0,
        capture_value: scores.captureValue,
        runbook_readiness: scores.runbookReadiness,
        review_need: scores.reviewNeed,
      }
      for (const [key, value] of Object.entries(defaults)) {
        if (next[key] === undefined || next[key] === null || next[key] === '') {
          next[key] = value
          fields.push(key)
        }
      }
    }

    if (isClaim(note)) {
      const defaults: Record<string, any> = {
        knowledge_type: 'claim',
        source_stage: note.frontmatter.source_stage ?? 'manual',
        claim_status: note.frontmatter.claim_status ?? 'provisional',
      }
      for (const [key, value] of Object.entries(defaults)) {
        if (next[key] === undefined || next[key] === null || next[key] === '') {
          next[key] = value
          fields.push(key)
        }
      }
    }

    if (fields.length > 0) {
      changed.push({ path: note.relativePath, fields })
      if (!dryRun) {
        assertCanWriteTool('migrate_brain_metadata', [note.relativePath])
        updateNote(vault, note, next)
      }
    }
  }

  if (!dryRun && changed.length > 0) {
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'migrate_brain_metadata',
      mode: 'apply',
      targets: changed.map(change => change.path),
      summary: `Brain-Metadaten migriert: ${changed.length} Notiz(en)`,
      meta: { changed: changed.length },
    })
  }

  return { dryRun, scanned: notes.length, changed }
}
