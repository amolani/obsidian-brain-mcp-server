import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { atomicWriteJsonSync } from './atomic-file.ts'
import { AUTO_BUILD_MANIFEST_PATH } from './brain-auto-build.ts'
import { BRAIN_FEEDBACK_PATH, autoBuildFeedbackCategory, recordAutoBuildFeedback } from './brain-feedback.ts'
import { assertCanWriteTool } from './policy.ts'
import { assertSafeRelativePath, vaultJoin } from './vault-paths.ts'

export interface ArchiveAutoBuildRunOptions {
  sourcePath: string
  dryRun?: boolean
}

export interface ArchiveAutoBuildRunResult {
  dryRun: boolean
  sourcePath: string
  manifestPath: string
  archiveFolder: string
  archived: Array<{ from: string; to: string }>
  skipped: Array<{ path: string; reason: string }>
}

interface AutoBuildManifestEntry {
  sourcePath: string
  hash: string
  promotedAt: string
  archivedAt?: string
  archiveFolder?: string
  artifacts?: string[]
  archivedArtifacts?: Array<{ from: string; to: string }>
  archiveSkipped?: Array<{ path: string; reason: string }>
  reportPath?: string | null
  plan?: Array<{ action: string }>
}

interface AutoBuildManifest {
  version: 1
  sources: Record<string, AutoBuildManifestEntry>
}

function readManifest(vault: Vault): AutoBuildManifest {
  const path = vaultJoin(vault.vaultPath, AUTO_BUILD_MANIFEST_PATH)
  if (!existsSync(path)) return { version: 1, sources: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AutoBuildManifest>
    if (parsed.version !== 1 || !parsed.sources || typeof parsed.sources !== 'object' || Array.isArray(parsed.sources)) {
      throw new Error('version=1 und sources-Objekt erforderlich')
    }
    for (const [sourcePath, entry] of Object.entries(parsed.sources)) {
      if (!entry || typeof entry !== 'object' || typeof entry.hash !== 'string') {
        throw new Error(`ungültiger Source-Eintrag: ${sourcePath}`)
      }
      if (entry.artifacts !== undefined && (!Array.isArray(entry.artifacts) || entry.artifacts.some(item => typeof item !== 'string'))) {
        throw new Error(`ungültige Artefaktliste: ${sourcePath}`)
      }
      if (entry.reportPath !== undefined && entry.reportPath !== null && typeof entry.reportPath !== 'string') {
        throw new Error(`ungültiger Report-Pfad: ${sourcePath}`)
      }
      if (entry.archiveFolder !== undefined && typeof entry.archiveFolder !== 'string') {
        throw new Error(`ungültiger Archivordner: ${sourcePath}`)
      }
      if (entry.archivedArtifacts !== undefined && (!Array.isArray(entry.archivedArtifacts) || entry.archivedArtifacts.some(item => (
        !item || typeof item.from !== 'string' || typeof item.to !== 'string'
      )))) {
        throw new Error(`ungültige Archivspuren: ${sourcePath}`)
      }
    }
    return { version: 1, sources: parsed.sources }
  } catch (error) {
    throw new Error(`Auto-Build-Manifest ist beschädigt (${AUTO_BUILD_MANIFEST_PATH}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

function writeManifest(vault: Vault, manifest: AutoBuildManifest): void {
  atomicWriteJsonSync(vaultJoin(vault.vaultPath, AUTO_BUILD_MANIFEST_PATH), manifest)
}

function archiveFolderFor(sourcePath: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const source = sourcePath.replace(/\.md$/, '').split('/').pop()?.replace(/[/\\:*?"<>|]/g, '-').trim() || 'source'
  return `Archiv/Auto-Build/${date}/${source}`
}

function uniqueArchiveTarget(vault: Vault, target: string): string {
  if (!existsSync(vaultJoin(vault.vaultPath, target))) return target
  const ext = extname(target)
  const stem = ext ? target.slice(0, -ext.length) : target
  let counter = 2
  let candidate = `${stem} (${counter})${ext}`
  while (existsSync(vaultJoin(vault.vaultPath, candidate))) {
    counter++
    candidate = `${stem} (${counter})${ext}`
  }
  return candidate
}

function feedbackCategories(entry: AutoBuildManifestEntry, archived: Array<{ from: string; to: string }>): string[] {
  const categories = new Set<string>()
  for (const item of archived) {
    if (item.from.startsWith('Knowledge/Claims/')) categories.add(autoBuildFeedbackCategory('extract_claims'))
    if (item.from.startsWith('Knowledge/Insights/')) categories.add(autoBuildFeedbackCategory('save_insight'))
    if (item.from.startsWith('Knowledge/Answers/')) categories.add(autoBuildFeedbackCategory('save_answer'))
    if (item.from.startsWith('Knowledge/Gaps/')) categories.add(autoBuildFeedbackCategory('flag_knowledge_gap'))
    if (/\/Runbooks?\/|Runbook/i.test(item.from)) categories.add(autoBuildFeedbackCategory('generate_runbook'))
  }
  if (categories.size === 0) {
    for (const item of entry.plan ?? []) categories.add(autoBuildFeedbackCategory(item.action))
  }
  return [...categories]
}

export function archiveAutoBuildRun(vault: Vault, options: ArchiveAutoBuildRunOptions): ArchiveAutoBuildRunResult {
  const sourcePath = assertSafeRelativePath(options.sourcePath)
  const dryRun = options.dryRun !== false
  const manifest = readManifest(vault)
  const entry = manifest.sources[sourcePath]
  const archiveFolder = assertSafeRelativePath(entry?.archiveFolder ?? archiveFolderFor(sourcePath))
  const archived: ArchiveAutoBuildRunResult['archived'] = []
  const skipped: ArchiveAutoBuildRunResult['skipped'] = []

  if (!entry) {
    return {
      dryRun,
      sourcePath,
      manifestPath: AUTO_BUILD_MANIFEST_PATH,
      archiveFolder,
      archived,
      skipped: [{ path: sourcePath, reason: 'kein Auto-Build-Manifest-Eintrag gefunden' }],
    }
  }

  if (entry.archivedAt) {
    return {
      dryRun,
      sourcePath,
      manifestPath: AUTO_BUILD_MANIFEST_PATH,
      archiveFolder,
      archived,
      skipped: [{ path: sourcePath, reason: `bereits archiviert: ${entry.archivedAt}` }],
    }
  }

  const artifacts = [...new Set([...(entry.artifacts ?? []), entry.reportPath].filter((path): path is string => typeof path === 'string' && path.endsWith('.md')))]
  for (const artifact of artifacts) {
    const safeArtifact = assertSafeRelativePath(artifact)
    const sourceFull = vaultJoin(vault.vaultPath, safeArtifact)
    const target = uniqueArchiveTarget(vault, `${archiveFolder}/${safeArtifact}`)
    if (!existsSync(sourceFull)) {
      skipped.push({ path: safeArtifact, reason: 'nicht mehr vorhanden' })
      continue
    }
    archived.push({ from: safeArtifact, to: target })
  }

  if (!dryRun) {
    const targets = archived.flatMap(item => [item.from, item.to])
    const categories = feedbackCategories(entry, archived)

    // Validate the complete transaction before creating folders or moving the
    // first artifact. This prevents a protected/disabled later target from
    // leaving an earlier artifact archived without a manifest commit.
    assertCanWriteTool('archive_auto_build_run', [AUTO_BUILD_MANIFEST_PATH, ...targets])
    if (categories.length > 0) assertCanWriteTool('record_brain_feedback', [BRAIN_FEEDBACK_PATH])
    for (const item of archived) mkdirSync(dirname(vaultJoin(vault.vaultPath, item.to)), { recursive: true })

    const moved: ArchiveAutoBuildRunResult['archived'] = []
    try {
      for (const item of archived) {
        const sourceFull = vaultJoin(vault.vaultPath, item.from)
        const targetFull = vaultJoin(vault.vaultPath, item.to)
        // rename(2) replaces an existing target on some platforms. Recheck
        // immediately before the move to narrow the collision window.
        if (existsSync(targetFull)) throw new Error(`Archivziel existiert bereits: ${item.to}`)
        renameSync(sourceFull, targetFull)
        moved.push(item)
      }

      manifest.sources[sourcePath] = {
        ...entry,
        archivedAt: new Date().toISOString(),
        archiveFolder,
        archivedArtifacts: archived.map(item => ({ ...item })),
        archiveSkipped: skipped.map(item => ({ ...item })),
      }
      // The atomic manifest replacement is the commit marker. A failed write
      // leaves the previous manifest intact and triggers the move rollback.
      writeManifest(vault, manifest)
    } catch (error) {
      const rollbackErrors: string[] = []
      for (const item of [...moved].reverse()) {
        const sourceFull = vaultJoin(vault.vaultPath, item.from)
        const targetFull = vaultJoin(vault.vaultPath, item.to)
        try {
          if (!existsSync(targetFull)) continue
          if (existsSync(sourceFull)) throw new Error(`Quellpfad wurde während Rollback neu angelegt: ${item.from}`)
          mkdirSync(dirname(sourceFull), { recursive: true })
          renameSync(targetFull, sourceFull)
        } catch (rollbackError) {
          rollbackErrors.push(`${item.to}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
      }
      vault.refreshIndex()
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(rollbackErrors.length > 0
        ? `Auto-Build-Archivierung fehlgeschlagen (${detail}); Rollback unvollständig: ${rollbackErrors.join('; ')}`
        : `Auto-Build-Archivierung fehlgeschlagen; alle Moves zurückgerollt: ${detail}`)
    }

    vault.refreshIndex()
    let feedback: ReturnType<typeof recordAutoBuildFeedback> = []
    if (categories.length > 0) {
      try {
        feedback = recordAutoBuildFeedback(vault, {
          sourcePath,
          categories,
          outcome: 'rejected',
          reason: 'archived:auto_build_run',
          dryRun: false,
        })
      } catch (error) {
        // Archiving and its manifest are already committed. Keep that coherent
        // state and expose the ancillary learning failure in the result.
        skipped.push({
          path: BRAIN_FEEDBACK_PATH,
          reason: `Archivierung abgeschlossen, Feedback konnte nicht gespeichert werden: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
    appendActionLog(vault.vaultPath, {
      tool: 'archive_auto_build_run',
      mode: 'apply',
      targets: [sourcePath, ...archived.map(item => item.to), AUTO_BUILD_MANIFEST_PATH],
      summary: `Auto-Build-Artefakte archiviert: ${sourcePath}`,
      meta: { archived: archived.length, skipped: skipped.length, archiveFolder, feedback: feedback.map(item => item.entry.category) },
    })
  }

  return {
    dryRun,
    sourcePath,
    manifestPath: AUTO_BUILD_MANIFEST_PATH,
    archiveFolder,
    archived,
    skipped,
  }
}
