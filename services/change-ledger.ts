import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Vault } from '../vault.ts'
import { ACTION_LOG_FILE, appendActionLog } from './action-log.ts'
import { assertGeneratedSurfaceOwnership } from './generated-surface-ownership.ts'
import { assertCanWriteTool } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export interface BuildChangeLedgerOptions {
  dryRun?: boolean
  limit?: number
  adoptLegacyOwnership?: boolean
}

export interface ChangeLedgerResult {
  dryRun: boolean
  path: string
  entryCount: number
  content: string
}

const CHANGE_LEDGER_PATH = 'Maintenance/Change Ledger.md'

interface RawActionLogEntry {
  ts?: string
  tool?: string
  mode?: string
  targets?: string[]
  summary?: string
}

function readActionLog(vault: Vault, limit: number): RawActionLogEntry[] {
  const path = vaultJoin(vault.vaultPath, ACTION_LOG_FILE)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map(line => {
      try {
        return JSON.parse(line) as RawActionLogEntry
      } catch {
        return { summary: line }
      }
    })
    .reverse()
}

function targetLinks(targets: string[] = []): string {
  if (targets.length === 0) return '(keine)'
  return targets.slice(0, 6).map(target => target.endsWith('.md') ? `[[${target}|${target}]]` : `\`${target}\``).join(', ')
}

export function buildChangeLedger(vault: Vault, options: BuildChangeLedgerOptions = {}): ChangeLedgerResult {
  const dryRun = options.dryRun ?? true
  const limit = Math.max(1, Math.min(options.limit ?? 80, 500))
  const entries = readActionLog(vault, limit)
  const rows = entries.length > 0
    ? entries.map(entry => `| ${entry.ts ?? '(unknown)'} | \`${entry.tool ?? 'unknown'}\` | ${entry.mode ?? '?'} | ${entry.summary ?? ''} | ${targetLinks(entry.targets)} |`).join('\n')
    : '| - | - | - | Keine Action-Log-Einträge gefunden | - |'
  const content = `---\nstatus: aktiv\ntags:\n  - change-ledger\n  - maintenance\naktualisiert: ${new Date().toISOString()}\nquelle: change-ledger\n---\n\n# Change Ledger\n\nLetzte ${entries.length} geloggte Brain-Schreibaktionen.\n\n| Zeit | Tool | Mode | Summary | Targets |\n|---|---|---|---|---|\n${rows}\n`
  const result = { dryRun, path: CHANGE_LEDGER_PATH, entryCount: entries.length, content }

  if (!dryRun) {
    assertCanWriteTool('build_change_ledger', [CHANGE_LEDGER_PATH])
    assertGeneratedSurfaceOwnership(vault.vaultPath, CHANGE_LEDGER_PATH, 'change-ledger', {
      allowRecognizedLegacy: options.adoptLegacyOwnership === true,
    })
    mkdirSync(join(vault.vaultPath, 'Maintenance'), { recursive: true })
    const fullPath = vaultJoin(vault.vaultPath, CHANGE_LEDGER_PATH)
    writeFileSync(fullPath, content, 'utf-8')
    vault.indexNote(fullPath, statSync(fullPath).mtimeMs)
    vault.buildLinkIndex()
    appendActionLog(vault.vaultPath, {
      tool: 'build_change_ledger',
      mode: 'apply',
      targets: [CHANGE_LEDGER_PATH],
      summary: `Change Ledger aktualisiert (${entries.length} Einträge)`,
    })
  }

  return result
}
