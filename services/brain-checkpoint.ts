import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { buildFrontmatter } from './frontmatter-linter.ts'
import { assertCanWriteTool } from './policy.ts'
import { redactSecrets } from './secret-redaction.ts'
import { assertSafePathSegment, assertSafeRelativePath, assertSingleLineText, sanitizePathSegment, uniqueRelativePath, vaultJoin } from './vault-paths.ts'

export interface BrainCheckpointOptions {
  title?: string
  summary: string
  client?: string
  sourcePath?: string
  runAutoBuild?: boolean
  dryRun?: boolean
}

export interface BrainCheckpointResult {
  dryRun: boolean
  path: string
  content: string
  autoBuild?: unknown
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function brainCheckpoint(vault: Vault, options: BrainCheckpointOptions): BrainCheckpointResult {
  const dryRun = options.dryRun ?? true
  if (!options.summary?.trim()) throw new Error('summary ist erforderlich')
  const title = options.title === undefined
    ? `Session Checkpoint ${nowStamp()}`
    : assertSingleLineText(options.title, 'title')
  const client = options.client === undefined ? undefined : assertSafePathSegment(options.client, 'client')
  const sourcePath = options.sourcePath === undefined ? undefined : assertSafeRelativePath(options.sourcePath)
  const folder = 'Knowledge/Checkpoints'
  const redaction = redactSecrets(options.summary.trim())
  const redactionTypes = redaction.types.length > 0 ? redaction.types : ['none']
  const fileStem = sanitizePathSegment(title)
  if (!fileStem) throw new Error('title ergibt keinen gültigen Dateinamen')
  const path = dryRun
    ? `${folder}/${fileStem}.md`
    : uniqueRelativePath(vault.vaultPath, folder, `${fileStem}.md`)
  const content = `---\n${buildFrontmatter({
    status: 'aktiv',
    tags: ['checkpoint', 'session'],
    ...(client ? { kunde: client } : {}),
    aktualisiert: new Date().toISOString(),
    quelle: 'brain-checkpoint',
    knowledge_type: 'checkpoint',
    source_stage: 'checkpoint',
    sensitive: redaction.count > 0,
    redactions: redaction.count,
    redaction_types: redactionTypes,
  })}---\n\n# ${title}\n\n${redaction.content}\n${sourcePath ? `\nQuelle: [[${sourcePath}]]\n` : ''}`
  let autoBuild: unknown

  if (!dryRun) {
    assertCanWriteTool('brain_checkpoint', [path])
    mkdirSync(vaultJoin(vault.vaultPath, folder), { recursive: true })
    const fullPath = vaultJoin(vault.vaultPath, path)
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'brain_checkpoint',
      mode: 'apply',
      targets: [path],
      summary: `Brain Checkpoint geschrieben: ${path}`,
      meta: { client, sourcePath, redactions: redaction.count },
    })
  }

  if (options.runAutoBuild) {
    autoBuild = vault.brainAutoBuild({
      sourcePath: sourcePath ?? (!dryRun ? path : undefined),
      client,
      dryRun,
    })
  }

  return { dryRun, path, content, autoBuild }
}
