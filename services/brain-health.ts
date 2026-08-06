import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Vault } from '../vault.ts'
import { diagnoseConfigFiles } from '../config.ts'
import {
  CLAUDE_HARVESTER_ASYNC,
  CLAUDE_HARVESTER_TIMEOUT_SECONDS,
} from './claude-hooks.ts'
import { isRecognizedLegacyGeneratedSurface } from './generated-surface-ownership.ts'
import { parseFrontmatter } from './note-parser.ts'
import { diagnoseBrainPolicy, loadBrainPolicy } from './policy.ts'
import { vaultJoin } from './vault-paths.ts'

export type BrainHealthStatus = 'ok' | 'warn' | 'fail'

export interface BrainHealthCheck {
  id: string
  label: string
  status: BrainHealthStatus
  message: string
}

export interface BrainHealthOptions {
  checkHooks?: boolean
}

export interface BrainHealthResult {
  status: BrainHealthStatus
  generatedAt: string
  vaultPath: string
  summary: { ok: number; warn: number; fail: number }
  checks: BrainHealthCheck[]
  nextActions: string[]
}

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function checkStatus(checks: BrainHealthCheck[]): BrainHealthStatus {
  if (checks.some(check => check.status === 'fail')) return 'fail'
  if (checks.some(check => check.status === 'warn')) return 'warn'
  return 'ok'
}

function summarize(checks: BrainHealthCheck[]): BrainHealthResult['summary'] {
  return {
    ok: checks.filter(check => check.status === 'ok').length,
    warn: checks.filter(check => check.status === 'warn').length,
    fail: checks.filter(check => check.status === 'fail').length,
  }
}

function fileExists(vault: Vault, relativePath: string): boolean {
  try {
    return existsSync(vaultJoin(vault.vaultPath, relativePath))
  } catch {
    return false
  }
}

const GENERATED_SURFACES = [
  ['brain_dashboard', 'Knowledge/_brain.md', 'brain-dashboard'],
  ['knowledge_index', 'Knowledge/index.md', 'knowledge-index'],
  ['hot_cache', 'Knowledge/hot.md', 'hot-cache'],
  ['capture_review', 'Maintenance/Capture Review.md', 'capture-review'],
  ['evidence_dashboard', 'Knowledge/evidence.md', 'evidence-dashboard'],
  ['knowledge_inbox', 'Maintenance/Knowledge Inbox.md', 'knowledge-inbox'],
  ['change_ledger', 'Maintenance/Change Ledger.md', 'change-ledger'],
  ['background_report', 'Maintenance/Background Run Report.md', 'brain-run-background'],
] as const

function generatedSurfaceCheck(vault: Vault, id: string, relativePath: string, owner: string): BrainHealthCheck {
  const fullPath = vaultJoin(vault.vaultPath, relativePath)
  if (!existsSync(fullPath)) {
    return { id, label: relativePath, status: 'warn', message: 'noch nicht erzeugt; repair_generated_surfaces oder Background-Run verwenden' }
  }
  try {
    const frontmatter = parseFrontmatter(readFileSync(fullPath, 'utf-8'))
    if (frontmatter.quelle !== owner) {
      if (isRecognizedLegacyGeneratedSurface(vault.vaultPath, relativePath, owner)) {
        return {
          id,
          label: relativePath,
          status: 'warn',
          message: `erkennbare Legacy-Surface ohne Ownership-Marker; repair_generated_surfaces mit adopt_legacy=true explizit prüfen/anwenden (${owner})`,
        }
      }
      return {
        id,
        label: relativePath,
        status: 'fail',
        message: `Ownership-Marker ungültig: erwartet quelle=${owner}, gefunden ${String(frontmatter.quelle ?? '(keiner)')}`,
      }
    }
    const ageDays = Math.max(0, (Date.now() - statSync(fullPath).mtimeMs) / 86_400_000)
    return ageDays > 7
      ? { id, label: relativePath, status: 'warn', message: `generator-owned, aber seit ${Math.floor(ageDays)} Tagen nicht aktualisiert` }
      : { id, label: relativePath, status: 'ok', message: `generator-owned und aktuell (${owner})` }
  } catch (err) {
    return {
      id,
      label: relativePath,
      status: 'fail',
      message: `nicht sicher diagnostizierbar: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function autoBuildManifestCheck(vault: Vault): BrainHealthCheck {
  const relativePath = '.brain-auto-build-manifest.json'
  const path = vaultJoin(vault.vaultPath, relativePath)
  if (!existsSync(path)) return { id: 'auto_build_manifest', label: 'Auto-build manifest', status: 'warn', message: 'noch kein Auto-Build-Lauf erfasst' }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version?: unknown; sources?: unknown }
    if (parsed.version !== 1 || !parsed.sources || typeof parsed.sources !== 'object' || Array.isArray(parsed.sources)) {
      throw new Error('version=1 und sources-Objekt erforderlich')
    }
    for (const [source, entry] of Object.entries(parsed.sources as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).hash !== 'string') {
        throw new Error(`ungültiger Source-Eintrag: ${source}`)
      }
    }
    return { id: 'auto_build_manifest', label: 'Auto-build manifest', status: 'ok', message: `${Object.keys(parsed.sources).length} Source-Einträge, Schema v1` }
  } catch (error) {
    return {
      id: 'auto_build_manifest',
      label: 'Auto-build manifest',
      status: 'fail',
      message: `beschädigt; Auto-Build bleibt fail-closed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function readClaudeSettings(): unknown | null {
  const home = process.env.HOME
  if (!home) return null
  const settingsPath = join(home, '.claude', 'settings.json')
  try {
    if (!existsSync(settingsPath)) return null
    return JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch {
    return null
  }
}

function containsCommand(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle)
  if (Array.isArray(value)) return value.some(item => containsCommand(item, needle))
  if (value && typeof value === 'object') return Object.values(value).some(item => containsCommand(item, needle))
  return false
}

function findCommandHandler(value: unknown, needles: string[]): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCommandHandler(item, needles)
      if (found) return found
    }
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const command = record.command
  if (
    typeof command === 'string'
    && needles.some(needle => command.includes(needle))
  ) return record
  for (const item of Object.values(record)) {
    const found = findCommandHandler(item, needles)
    if (found) return found
  }
  return null
}

function nextActions(checks: BrainHealthCheck[]): string[] {
  return checks
    .filter(check => check.status !== 'ok')
    .slice(0, 8)
    .map(check => `${check.label}: ${check.message}`)
}

export function brainHealthCheck(vault: Vault, options: BrainHealthOptions = {}): BrainHealthResult {
  const policyDiagnostic = diagnoseBrainPolicy()
  const policy = loadBrainPolicy()
  const checks: BrainHealthCheck[] = []
  const add = (id: string, label: string, status: BrainHealthStatus, message: string) => {
    checks.push({ id, label, status, message })
  }

  try {
    const stat = statSync(vault.vaultPath)
    add('vault_path', 'Vault path', stat.isDirectory() ? 'ok' : 'fail', stat.isDirectory() ? vault.vaultPath : 'VAULT_PATH ist kein Verzeichnis')
  } catch {
    add('vault_path', 'Vault path', 'fail', `Nicht lesbar: ${vault.vaultPath}`)
  }

  add(
    'policy_config',
    'Brain policy',
    policyDiagnostic.valid ? 'ok' : 'fail',
    policyDiagnostic.valid
      ? `gültig: ${policyDiagnostic.path}`
      : `${policyDiagnostic.path}: ${policyDiagnostic.errors.join('; ')}`,
  )
  for (const diagnostic of diagnoseConfigFiles()) {
    const status: BrainHealthStatus = !diagnostic.valid
      ? 'fail'
      : diagnostic.warnings.length > 0
        ? 'warn'
        : 'ok'
    const detail = diagnostic.errors.length > 0
      ? diagnostic.errors.join('; ')
      : diagnostic.warnings.length > 0
        ? diagnostic.warnings.join('; ')
        : `${diagnostic.entryCount} Einträge`
    add(`config_${diagnostic.id}`, diagnostic.label, status, `${detail}; ${diagnostic.path}`)
  }

  add('index', 'Vault index', vault.notes.size > 0 ? 'ok' : 'warn', `${vault.notes.size} Notizen indexiert`)
  add('working_memory', 'Working memory', policy.workingMemory.mode === 'manual_only' && !policy.workingMemory.allowAutomaticRecall ? 'ok' : 'warn', `mode=${policy.workingMemory.mode}, automatic=${policy.workingMemory.allowAutomaticRecall}`)
  add('auto_capture_policy', 'Auto-capture policy', policy.hooks.autoCapture ? 'ok' : 'warn', policy.hooks.autoCapture ? 'hooks.autoCapture=true' : 'hooks.autoCapture=false')
  add('auto_build_policy', 'Auto-build policy', policy.automation.mode === 'auto_build' ? 'ok' : 'warn', `automation.mode=${policy.automation.mode}`)
  add('checkpoint_policy', 'Long-session policy', policy.automation.duringSession.autoCheckpoint ? 'ok' : 'warn', `autoCheckpoint=${policy.automation.duringSession.autoCheckpoint}, minCommands=${policy.automation.duringSession.minCommandsBetweenCheckpoints}, minMinutes=${policy.automation.duringSession.minMinutesBetweenCheckpoints}`)
  add('risky_auto_apply', 'Risky auto-apply block', policy.automation.neverAutoApply.includes('merge_duplicates') && policy.automation.neverAutoApply.includes('rename_note') ? 'ok' : 'warn', `neverAutoApply=${policy.automation.neverAutoApply.join(', ')}`)

  const requiredTools = ['brain_auto_build', 'archive_auto_build_run', 'brain_checkpoint', 'brain_metrics', 'brain_run_background', 'record_brain_feedback', 'build_capture_review', 'build_evidence_dashboard', 'build_session_impact_report', 'repair_generated_surfaces', 'build_knowledge_inbox', 'brain_apply_inbox_item', 'brain_review_inbox_items', 'migrate_brain_metadata', 'build_change_ledger', 'promote_suggestion']
  for (const tool of requiredTools) {
    add(`tool_policy_${tool}`, `Tool policy ${tool}`, policy.tools[tool] ? 'ok' : 'fail', policy.tools[tool] ? `risk=${policy.tools[tool].risk}, write=${policy.tools[tool].write}` : 'Tool fehlt in brain-policy.json')
  }

  for (const [id, path, owner] of GENERATED_SURFACES) checks.push(generatedSurfaceCheck(vault, id, path, owner))

  checks.push(autoBuildManifestCheck(vault))
  add('action_log', 'Action log', fileExists(vault, '.action-log.jsonl') ? 'ok' : 'warn', fileExists(vault, '.action-log.jsonl') ? 'vorhanden' : 'noch keine geloggte Schreibaktion')

  const semantic = vault.semanticIndexStatus()
  const semanticFileExists = fileExists(vault, semantic.path)
  const semanticDrift = semantic.missingNotes.length + semantic.staleNotes.length + semantic.extraNotes.length
  add(
    'semantic_index',
    'Semantic index',
    !semanticFileExists || (semantic.exists && semanticDrift === 0) ? 'ok' : 'warn',
    !semanticFileExists
      ? 'optionaler Cache noch nicht gebaut; Semantic Search nutzt lokalen On-Demand-Fallback'
      : semantic.exists
      ? `${semantic.indexedNotes}/${semantic.totalNotes} indexiert; missing=${semantic.missingNotes.length}, stale=${semantic.staleNotes.length}, extra=${semantic.extraNotes.length}`
      : 'Datei vorhanden, aber ungültig; rebuild_semantic_index als Dry-Run prüfen',
  )

  if (options.checkHooks !== false) {
    const settings = readClaudeSettings()
    if (!settings) {
      add('claude_settings', 'Claude settings', 'warn', '~/.claude/settings.json nicht lesbar oder nicht vorhanden')
    } else {
      const settingsObj = settings && typeof settings === 'object' ? settings as Record<string, any> : {}
      const settingsVaultPath = settingsObj.env?.VAULT_PATH
      const sessionContext = `node ${join(PROJECT_ROOT, 'hooks', 'session-context.ts')}`
      const harvester = `node ${join(PROJECT_ROOT, 'hooks', 'knowledge-harvester.ts')}`
      const checkpoint = `node ${join(PROJECT_ROOT, 'hooks', 'session-checkpoint.ts')}`
      add('hook_vault_path', 'Hook VAULT_PATH', settingsVaultPath === vault.vaultPath ? 'ok' : 'warn', settingsVaultPath ? `VAULT_PATH=${settingsVaultPath}` : 'VAULT_PATH fehlt in ~/.claude/settings.json env')
      add('hook_session_start', 'SessionStart hook', containsCommand(settings, sessionContext) || containsCommand(settings, 'hooks/session-context.ts') ? 'ok' : 'warn', 'session-context.ts')
      const stopHandler = findCommandHandler(settingsObj.hooks?.Stop, [harvester, 'hooks/knowledge-harvester.ts'])
      if (!stopHandler) {
        add('hook_stop', 'Stop hook', 'warn', 'knowledge-harvester.ts fehlt')
      } else {
        const timeout = stopHandler.timeout
        const timeoutOk = typeof timeout === 'number'
          && Number.isFinite(timeout)
          && timeout >= CLAUDE_HARVESTER_TIMEOUT_SECONDS
        const asyncOk = stopHandler.async === CLAUDE_HARVESTER_ASYNC
        const issues: string[] = []
        if (!timeoutOk) {
          issues.push(`timeout=${typeof timeout === 'number' ? timeout : 'fehlt'}s (mindestens ${CLAUDE_HARVESTER_TIMEOUT_SECONDS}s)`)
        }
        if (!asyncOk) issues.push(`async=${String(stopHandler.async ?? 'fehlt')} (erwartet true)`)
        add(
          'hook_stop',
          'Stop hook',
          issues.length === 0 ? 'ok' : 'warn',
          issues.length === 0
            ? `knowledge-harvester.ts, timeout=${String(timeout)}s, async=true`
            : `knowledge-harvester.ts falsch konfiguriert: ${issues.join(', ')}; repair-hooks ausführen`,
        )
      }
      add('hook_post_tool_use', 'PostToolUse hook', containsCommand(settings, checkpoint) || containsCommand(settings, 'hooks/session-checkpoint.ts') ? 'ok' : 'warn', 'session-checkpoint.ts')
    }
  }

  return {
    status: checkStatus(checks),
    generatedAt: new Date().toISOString(),
    vaultPath: vault.vaultPath,
    summary: summarize(checks),
    checks,
    nextActions: nextActions(checks),
  }
}
