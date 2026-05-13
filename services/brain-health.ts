import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Vault } from '../vault.ts'
import { loadBrainPolicy } from './policy.ts'
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

function nextActions(checks: BrainHealthCheck[]): string[] {
  return checks
    .filter(check => check.status !== 'ok')
    .slice(0, 8)
    .map(check => `${check.label}: ${check.message}`)
}

export function brainHealthCheck(vault: Vault, options: BrainHealthOptions = {}): BrainHealthResult {
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

  add('index', 'Vault index', vault.notes.size > 0 ? 'ok' : 'warn', `${vault.notes.size} Notizen indexiert`)
  add('working_memory', 'Working memory', policy.workingMemory.mode === 'manual_only' && !policy.workingMemory.allowAutomaticRecall ? 'ok' : 'warn', `mode=${policy.workingMemory.mode}, automatic=${policy.workingMemory.allowAutomaticRecall}`)
  add('auto_capture_policy', 'Auto-capture policy', policy.hooks.autoCapture ? 'ok' : 'warn', policy.hooks.autoCapture ? 'hooks.autoCapture=true' : 'hooks.autoCapture=false')
  add('auto_build_policy', 'Auto-build policy', policy.automation.mode === 'auto_build' ? 'ok' : 'warn', `automation.mode=${policy.automation.mode}`)
  add('checkpoint_policy', 'Long-session policy', policy.automation.duringSession.autoCheckpoint ? 'ok' : 'warn', `autoCheckpoint=${policy.automation.duringSession.autoCheckpoint}, minCommands=${policy.automation.duringSession.minCommandsBetweenCheckpoints}, minMinutes=${policy.automation.duringSession.minMinutesBetweenCheckpoints}`)
  add('risky_auto_apply', 'Risky auto-apply block', policy.automation.neverAutoApply.includes('merge_duplicates') && policy.automation.neverAutoApply.includes('rename_note') ? 'ok' : 'warn', `neverAutoApply=${policy.automation.neverAutoApply.join(', ')}`)

  const requiredTools = ['brain_auto_build', 'archive_auto_build_run', 'brain_checkpoint', 'brain_metrics', 'brain_run_background', 'record_brain_feedback', 'build_capture_review', 'build_evidence_dashboard', 'build_session_impact_report', 'build_knowledge_inbox', 'brain_apply_inbox_item', 'migrate_brain_metadata', 'build_change_ledger']
  for (const tool of requiredTools) {
    add(`tool_policy_${tool}`, `Tool policy ${tool}`, policy.tools[tool] ? 'ok' : 'fail', policy.tools[tool] ? `risk=${policy.tools[tool].risk}, write=${policy.tools[tool].write}` : 'Tool fehlt in brain-policy.json')
  }

  const surfaces = [
    ['brain_dashboard', 'Knowledge/_brain.md'],
    ['knowledge_index', 'Knowledge/index.md'],
    ['hot_cache', 'Knowledge/hot.md'],
  ] as const
  for (const [id, path] of surfaces) {
    add(id, path, fileExists(vault, path) ? 'ok' : 'warn', fileExists(vault, path) ? 'vorhanden' : 'noch nicht erzeugt')
  }

  add('auto_build_manifest', 'Auto-build manifest', fileExists(vault, '.brain-auto-build-manifest.json') ? 'ok' : 'warn', fileExists(vault, '.brain-auto-build-manifest.json') ? 'vorhanden' : 'noch kein Auto-Build-Lauf erfasst')
  add('action_log', 'Action log', fileExists(vault, '.action-log.jsonl') ? 'ok' : 'warn', fileExists(vault, '.action-log.jsonl') ? 'vorhanden' : 'noch keine geloggte Schreibaktion')

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
      add('hook_stop', 'Stop hook', containsCommand(settings, harvester) || containsCommand(settings, 'hooks/knowledge-harvester.ts') ? 'ok' : 'warn', 'knowledge-harvester.ts')
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
