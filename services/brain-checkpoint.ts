import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault.ts'
import { appendActionLog } from './action-log.ts'
import { assertCanWriteTool } from './policy.ts'
import { redactSecrets } from './secret-redaction.ts'
import { sanitizePathSegment, uniqueRelativePath, vaultJoin } from './vault-paths.ts'

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
  const title = options.title?.trim() || `Session Checkpoint ${nowStamp()}`
  const folder = 'Knowledge/Checkpoints'
  const redaction = redactSecrets(options.summary.trim())
  const redactionTypes = redaction.types.length > 0 ? redaction.types : ['none']
  const path = dryRun
    ? `${folder}/${sanitizePathSegment(title)}.md`
    : uniqueRelativePath(vault.vaultPath, folder, `${sanitizePathSegment(title)}.md`)
  const content = `---\nstatus: aktiv\ntags:\n  - checkpoint\n  - session\n${options.client ? `kunde: ${options.client}\n` : ''}aktualisiert: ${new Date().toISOString()}\nquelle: brain-checkpoint\nknowledge_type: checkpoint\nsource_stage: checkpoint\nsensitive: ${redaction.count > 0}\nredactions: ${redaction.count}\nredaction_types:\n${redactionTypes.map(type => `  - ${type}`).join('\n')}\n---\n\n# ${title}\n\n${redaction.content}\n${options.sourcePath ? `\nQuelle: [[${options.sourcePath}]]\n` : ''}`
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
      meta: { client: options.client, sourcePath: options.sourcePath, redactions: redaction.count },
    })
  }

  if (options.runAutoBuild) {
    autoBuild = vault.brainAutoBuild({
      sourcePath: options.sourcePath ?? (!dryRun ? path : undefined),
      client: options.client,
      dryRun,
    })
  }

  return { dryRun, path, content, autoBuild }
}
