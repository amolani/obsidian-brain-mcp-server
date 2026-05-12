import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { AUTO_BUILD_MANIFEST_PATH } from './brain-auto-build.ts'
import { autoBuildFeedbackCategory, recordAutoBuildFeedback } from './brain-feedback.ts'
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
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AutoBuildManifest>
  return { version: 1, sources: parsed.sources ?? {} }
}

function writeManifest(vault: Vault, manifest: AutoBuildManifest): void {
  writeFileSync(vaultJoin(vault.vaultPath, AUTO_BUILD_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
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
  const archiveFolder = entry?.archiveFolder ?? archiveFolderFor(sourcePath)
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

  if (!dryRun) assertCanWriteTool('archive_auto_build_run', [AUTO_BUILD_MANIFEST_PATH])

  const artifacts = [...new Set([...(entry.artifacts ?? []), entry.reportPath].filter((path): path is string => typeof path === 'string' && path.endsWith('.md')))]
  for (const artifact of artifacts) {
    const safeArtifact = assertSafeRelativePath(artifact)
    const sourceFull = vaultJoin(vault.vaultPath, safeArtifact)
    const target = uniqueArchiveTarget(vault, `${archiveFolder}/${safeArtifact}`)
    const targetFull = vaultJoin(vault.vaultPath, target)
    if (!existsSync(sourceFull)) {
      skipped.push({ path: safeArtifact, reason: 'nicht mehr vorhanden' })
      continue
    }
    archived.push({ from: safeArtifact, to: target })
    if (dryRun) continue
    assertCanWriteTool('archive_auto_build_run', [safeArtifact, target, AUTO_BUILD_MANIFEST_PATH])
    mkdirSync(dirname(targetFull), { recursive: true })
    renameSync(sourceFull, targetFull)
    vault.removeNoteFromIndex(safeArtifact)
    vault.indexNote(targetFull, statSync(targetFull).mtimeMs)
  }

  if (!dryRun) {
    manifest.sources[sourcePath] = {
      ...entry,
      archivedAt: new Date().toISOString(),
      archiveFolder,
    }
    const feedback = recordAutoBuildFeedback(vault, {
      sourcePath,
      categories: feedbackCategories(entry, archived),
      outcome: 'rejected',
      reason: 'archived:auto_build_run',
      dryRun: false,
    })
    writeManifest(vault, manifest)
    vault.buildLinkIndex()
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
