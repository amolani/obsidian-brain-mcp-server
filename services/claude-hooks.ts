import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export interface HookInstallOptions {
  vaultPath: string
  settingsPath?: string
  apply?: boolean
}

export interface HookInstallChange {
  id: string
  action: 'add' | 'update'
  detail: string
}

export interface HookInstallResult {
  dryRun: boolean
  changed: boolean
  settingsPath: string
  backupPath: string | null
  changes: HookInstallChange[]
  before: Record<string, unknown>
  after: Record<string, unknown>
}

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const CLAUDE_HARVESTER_TIMEOUT_SECONDS = 120
export const CLAUDE_HARVESTER_ASYNC = true

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {}
  const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as unknown
  if (!isRecord(parsed)) throw new Error(`${settingsPath} muss ein JSON-Objekt enthalten`)
  return parsed
}

function commandContains(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle)
  if (Array.isArray(value)) return value.some(item => commandContains(item, needle))
  if (isRecord(value)) return Object.values(value).some(item => commandContains(item, needle))
  return false
}

function findCommandHandler(value: unknown, needle: string): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCommandHandler(item, needle)
      if (found) return found
    }
    return null
  }
  if (!isRecord(value)) return null
  if (typeof value.command === 'string' && value.command.includes(needle)) return value
  for (const item of Object.values(value)) {
    const found = findCommandHandler(item, needle)
    if (found) return found
  }
  return null
}

function matcherIncludesBash(value: unknown): boolean {
  return typeof value === 'string' && value.split('|').map(part => part.trim()).includes('Bash')
}

function defaultSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

function hookCommand(path: string): string {
  return `node "${path}"`
}

function requiredHook(event: string, hookName: string) {
  const path = join(PROJECT_ROOT, 'hooks', hookName)
  return {
    event,
    hookName,
    command: hookCommand(path),
    path,
  }
}

function ensureHook(
  settings: Record<string, unknown>,
  changes: HookInstallChange[],
  event: 'SessionStart' | 'PostToolUse' | 'Stop',
  desired: Record<string, unknown>,
  needle: string,
  requiredMatcher?: 'Bash',
  requiredHandlerOptions: string[] = [],
): void {
  if (!isRecord(settings.hooks)) {
    settings.hooks = {}
    changes.push({ id: 'hooks', action: 'add', detail: 'hooks-Objekt angelegt' })
  }
  const hooks = settings.hooks as Record<string, unknown>
  if (!Array.isArray(hooks[event])) {
    hooks[event] = []
    changes.push({ id: `hooks.${event}`, action: 'add', detail: `${event}-Hook-Liste angelegt` })
  }
  const entries = hooks[event] as unknown[]
  const existing = entries.find(entry => commandContains(entry, needle))
  if (!existing) {
    entries.push(desired)
    changes.push({ id: `hooks.${event}.${needle}`, action: 'add', detail: `${event}: ${needle} registriert` })
    return
  }
  if (requiredMatcher && isRecord(existing) && !matcherIncludesBash(existing.matcher)) {
    existing.matcher = existing.matcher
      ? `${String(existing.matcher)}|Bash`
      : 'Bash'
    changes.push({ id: `hooks.${event}.matcher`, action: 'update', detail: `${event}: Bash-Matcher ergänzt` })
  }
  const existingHandler = findCommandHandler(existing, needle)
  const desiredHandler = findCommandHandler(desired, needle)
  if (!existingHandler || !desiredHandler) return
  for (const option of requiredHandlerOptions) {
    if (Object.is(existingHandler[option], desiredHandler[option])) continue
    existingHandler[option] = clone(desiredHandler[option])
    changes.push({
      id: `hooks.${event}.${needle}.${option}`,
      action: 'update',
      detail: `${event}: ${needle} ${option}=${String(desiredHandler[option])}`,
    })
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function planClaudeHookInstall(options: HookInstallOptions): HookInstallResult {
  if (!options.vaultPath?.trim()) throw new Error('vaultPath ist erforderlich')

  const settingsPath = options.settingsPath ?? defaultSettingsPath()
  const before = readSettings(settingsPath)
  const after = clone(before)
  const changes: HookInstallChange[] = []

  if (!isRecord(after.env)) {
    after.env = {}
    changes.push({ id: 'env', action: 'add', detail: 'env-Objekt angelegt' })
  }
  const env = after.env as Record<string, unknown>
  if (env.VAULT_PATH !== options.vaultPath) {
    const action = Object.prototype.hasOwnProperty.call(env, 'VAULT_PATH') ? 'update' : 'add'
    env.VAULT_PATH = options.vaultPath
    changes.push({ id: 'env.VAULT_PATH', action, detail: `VAULT_PATH=${options.vaultPath}` })
  }

  const sessionContext = requiredHook('SessionStart', 'session-context.ts')
  ensureHook(after, changes, 'SessionStart', {
    hooks: [{
      type: 'command',
      command: sessionContext.command,
      timeout: 8,
      statusMessage: 'Loading Obsidian context...',
    }],
  }, sessionContext.path)

  const checkpoint = requiredHook('PostToolUse', 'session-checkpoint.ts')
  ensureHook(after, changes, 'PostToolUse', {
    matcher: 'Bash',
    hooks: [{
      type: 'command',
      command: checkpoint.command,
      timeout: 12,
      statusMessage: 'Checking long-session checkpoint...',
    }],
  }, checkpoint.path, 'Bash')

  const harvester = requiredHook('Stop', 'knowledge-harvester.ts')
  ensureHook(after, changes, 'Stop', {
    hooks: [{
      type: 'command',
      command: harvester.command,
      timeout: CLAUDE_HARVESTER_TIMEOUT_SECONDS,
      async: CLAUDE_HARVESTER_ASYNC,
    }],
  }, harvester.path, undefined, ['timeout', 'async'])

  return {
    dryRun: options.apply !== true,
    changed: changes.length > 0,
    settingsPath,
    backupPath: null,
    changes,
    before,
    after,
  }
}

export function installClaudeHooks(options: HookInstallOptions): HookInstallResult {
  const result = planClaudeHookInstall(options)
  if (result.dryRun || !result.changed) return result

  mkdirSync(dirname(result.settingsPath), { recursive: true })
  const backupPath = existsSync(result.settingsPath)
    ? `${result.settingsPath}.bak-${timestamp()}`
    : null
  if (backupPath) copyFileSync(result.settingsPath, backupPath)
  writeFileSync(result.settingsPath, `${JSON.stringify(result.after, null, 2)}\n`, 'utf-8')
  return { ...result, backupPath }
}
