import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { NoteEntry, Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { assertGeneratedSurfaceOwnership } from './generated-surface-ownership.ts'
import { isAutoCaptureNote } from './note-scope.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export interface BuildCaptureReviewOptions {
  dryRun?: boolean
  adoptLegacyOwnership?: boolean
}

export interface CaptureReviewResult {
  dryRun: boolean
  path: string
  captureCount: number
  promotionCandidateCount: number
  uncertainClientCount: number
  noisyAutoBuildCount: number
  content: string
}

const CAPTURE_REVIEW_PATH = 'Maintenance/Capture Review.md'

function today(): string {
  return new Date().toISOString().split('T')[0]
}

function isPromotionCandidate(note: NoteEntry): boolean {
  return note.tags.includes('prozedur')
    || /## Durchgef.hrte (?:Befehle|Schritte)/i.test(note.content)
    || /## Fehler und Workarounds/i.test(note.content)
    || (note.content.match(/^\d+\.\s+/gm)?.length ?? 0) >= 3
}

function readAutoBuildManifest(vault: Vault): Record<string, any> {
  try {
    const raw = readFileSync(vaultJoin(vault.vaultPath, '.brain-auto-build-manifest.json'), 'utf-8')
    const parsed = JSON.parse(raw) as { sources?: Record<string, any> }
    return parsed.sources ?? {}
  } catch {
    return {}
  }
}

function links(notes: NoteEntry[]): string {
  return notes.length > 0
    ? notes.map(note => `- [[${note.relativePath}|${note.title}]]`).join('\n')
    : '- Keine Einträge'
}

function uncertainClientLines(notes: NoteEntry[]): string {
  const uncertain = notes.filter(note => ['fuzzy_cwd', 'exact_content'].includes(String(note.frontmatter.client_match_method ?? '')))
  return uncertain.length > 0
    ? uncertain.slice(0, 20).map(note => {
      const method = String(note.frontmatter.client_match_method ?? 'unknown')
      const confidence = String(note.frontmatter.client_match_confidence ?? 'unknown')
      const candidate = note.frontmatter.client_match_candidate ? `; Kandidat: \`${note.frontmatter.client_match_candidate}\`` : ''
      const alias = note.frontmatter.client_match_alias ? `; Alias: \`${note.frontmatter.client_match_alias}\`` : ''
      return `- [[${note.relativePath}|${note.title}]] - ${method}/${confidence}${candidate}${alias}`
    }).join('\n')
    : '- Keine unsicheren Kundenzuordnungen'
}

function renderCaptureReview(vault: Vault): CaptureReviewResult {
  const captures = [...vault.notes.values()]
    .filter(isAutoCaptureNote)
    .sort((a, b) => b.lastModified - a.lastModified)
  const promotionCandidates = captures.filter(isPromotionCandidate)
  const uncertainClientCount = captures.filter(note => ['fuzzy_cwd', 'exact_content'].includes(String(note.frontmatter.client_match_method ?? ''))).length
  const manifest = readAutoBuildManifest(vault)
  const noisy = Object.values(manifest).filter(entry => entry?.archivedAt || (entry?.artifacts?.length ?? 0) > 6)
  const newCaptures = captures.slice(0, 20)
  const candidates = promotionCandidates.slice(0, 20)
  const noisyLines = noisy.length > 0
    ? noisy.slice(0, 20).map((entry: any) => `- \`${entry.sourcePath ?? '(unknown)'}\` - ${entry.archivedAt ? 'archiviert' : 'viele Artefakte'}; pruefe \`archive_auto_build_run\` als Dry-Run.`).join('\n')
    : '- Keine auffaelligen Auto-Build-Laeufe'

  const content = `---
status: aktiv
tags:
  - capture-review
datum: ${today()}
quelle: capture-review
---

# Capture Review

## Neue Captures

${links(newCaptures)}

## Promotionskandidaten

${links(candidates)}

## Kundenzuordnung prüfen

${uncertainClientLines(captures)}

## Noisy Auto-Build Outputs

${noisyLines}

## Empfohlene naechste Aktionen

- Neue Captures zuerst mit \`vault_search\` oder \`get_note_context\` pruefen.
- Promotionskandidaten mit \`generate_runbook\` oder \`promote_capture_to_runbook\` als Dry-Run testen.
- Noisy Auto-Build-Laeufe mit \`archive_auto_build_run\` erst previewen, dann gezielt anwenden.
`

  return {
    dryRun: true,
    path: CAPTURE_REVIEW_PATH,
    captureCount: captures.length,
    promotionCandidateCount: promotionCandidates.length,
    uncertainClientCount,
    noisyAutoBuildCount: noisy.length,
    content,
  }
}

export function buildCaptureReview(vault: Vault, options: BuildCaptureReviewOptions = {}): CaptureReviewResult {
  const dryRun = options.dryRun ?? true
  const result = { ...renderCaptureReview(vault), dryRun }
  if (!dryRun) {
    assertCanWriteTool('build_capture_review', [CAPTURE_REVIEW_PATH])
    const fullPath = vaultJoin(vault.vaultPath, CAPTURE_REVIEW_PATH)
    assertGeneratedSurfaceOwnership(vault.vaultPath, CAPTURE_REVIEW_PATH, 'capture-review', {
      allowRecognizedLegacy: options.adoptLegacyOwnership === true,
    })
    mkdirSync(vaultJoin(vault.vaultPath, 'Maintenance'), { recursive: true })
    writeFileSync(fullPath, result.content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'build_capture_review',
      mode: 'apply',
      targets: [CAPTURE_REVIEW_PATH],
      summary: `Capture Review aktualisiert (${result.captureCount} Captures)`,
      meta: { promotionCandidates: result.promotionCandidateCount, uncertainClients: result.uncertainClientCount, noisyAutoBuild: result.noisyAutoBuildCount },
    })
  }
  return result
}
