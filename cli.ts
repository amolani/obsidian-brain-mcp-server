#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Vault } from './vault.ts'
import { createDemoVault } from './services/demo-vault.ts'
import { installClaudeHooks } from './services/claude-hooks.ts'

interface ParsedArgs {
  command: string
  options: Record<string, string | boolean>
  positionals: string[]
}

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv
  const options: Record<string, string | boolean> = {}
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const raw = token.slice(2)
    const eq = raw.indexOf('=')
    if (eq >= 0) {
      options[raw.slice(0, eq)] = raw.slice(eq + 1)
      continue
    }
    const next = rest[i + 1]
    if (next && !next.startsWith('--')) {
      options[raw] = next
      i++
    } else {
      options[raw] = true
    }
  }
  return { command, options, positionals }
}

function optionString(options: Record<string, string | boolean>, name: string): string | undefined {
  const value = options[name]
  return typeof value === 'string' ? value : undefined
}

function optionPath(options: Record<string, string | boolean>, name: string): string | undefined {
  const value = optionString(options, name)
  return value ? resolve(value) : undefined
}

function requirePath(options: Record<string, string | boolean>, name: string): string {
  const value = optionPath(options, name)
  if (!value) throw new Error(`--${name} ist erforderlich`)
  return value
}

function bool(options: Record<string, string | boolean>, name: string): boolean {
  return options[name] === true || options[name] === 'true'
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function usage(): string {
  return `obsidian-brain

Usage:
  obsidian-brain doctor --vault <path> [--json] [--skip-hooks]
  obsidian-brain install-hooks --vault <path> [--apply] [--settings <path>] [--json]
  obsidian-brain init --vault <path> [--apply-hooks]
  obsidian-brain demo --out <path> [--force]
  obsidian-brain release-check
`
}

async function withVault<T>(vaultPath: string, fn: (vault: Vault) => T | Promise<T>): Promise<T> {
  const vault = new Vault(vaultPath)
  await vault.init()
  try {
    return await fn(vault)
  } finally {
    vault.shutdown()
  }
}

function formatHealth(result: ReturnType<Vault['brainHealthCheck']>): string {
  const checks = result.checks.map(check => `- ${check.status.padEnd(4)} ${check.id}: ${check.message}`).join('\n')
  const next = result.nextActions.length > 0
    ? result.nextActions.map(action => `- ${action}`).join('\n')
    : '- Keine unmittelbaren Aktionen'
  return [
    '# Obsidian Brain Doctor',
    '',
    `Status: ${result.status}`,
    `Vault: ${result.vaultPath}`,
    `Checks: ok ${result.summary.ok}, warn ${result.summary.warn}, fail ${result.summary.fail}`,
    '',
    '## Checks',
    checks,
    '',
    '## Next Actions',
    next,
  ].join('\n')
}

async function runDoctor(args: ParsedArgs): Promise<number> {
  const vaultPath = requirePath(args.options, 'vault')
  const result = await withVault(vaultPath, vault => vault.brainHealthCheck({ checkHooks: !bool(args.options, 'skip-hooks') }))
  if (bool(args.options, 'json')) printJson(result)
  else process.stdout.write(`${formatHealth(result)}\n`)
  return result.summary.fail > 0 ? 1 : 0
}

function formatHookInstall(result: ReturnType<typeof installClaudeHooks>): string {
  const changes = result.changes.length > 0
    ? result.changes.map(change => `- ${change.action}: ${change.detail}`).join('\n')
    : '- Keine Änderungen erforderlich'
  return [
    result.dryRun ? '# Hook Install Dry-Run' : '# Hooks installiert',
    '',
    `Settings: ${result.settingsPath}`,
    `Changed: ${result.changed}`,
    result.backupPath ? `Backup: ${result.backupPath}` : '',
    '',
    '## Changes',
    changes,
    '',
    result.dryRun && result.changed ? '## Preview settings.json' : '',
    result.dryRun && result.changed ? JSON.stringify(result.after, null, 2) : '',
  ].filter(Boolean).join('\n')
}

function runInstallHooks(args: ParsedArgs): number {
  const vaultPath = requirePath(args.options, 'vault')
  const result = installClaudeHooks({
    vaultPath,
    settingsPath: optionPath(args.options, 'settings'),
    apply: bool(args.options, 'apply'),
  })
  if (bool(args.options, 'json')) printJson(result)
  else process.stdout.write(`${formatHookInstall(result)}\n`)
  return 0
}

async function runInit(args: ParsedArgs): Promise<number> {
  const vaultPath = requirePath(args.options, 'vault')
  const health = await withVault(vaultPath, vault => vault.brainHealthCheck({ checkHooks: true }))
  const hooks = installClaudeHooks({
    vaultPath,
    apply: bool(args.options, 'apply-hooks'),
  })
  process.stdout.write([
    '# Obsidian Brain Init',
    '',
    `Vault: ${vaultPath}`,
    `Health: ${health.status} (ok ${health.summary.ok}, warn ${health.summary.warn}, fail ${health.summary.fail})`,
    `Hooks: ${hooks.dryRun ? 'dry-run' : 'applied'}; changed=${hooks.changed}`,
    '',
    hooks.dryRun ? 'Run again with --apply-hooks to write Claude Code hooks.' : 'Claude Code hooks are installed.',
  ].join('\n') + '\n')
  return health.summary.fail > 0 ? 1 : 0
}

function runDemo(args: ParsedArgs): number {
  const outPath = requirePath(args.options, 'out')
  const result = createDemoVault({ outPath, force: bool(args.options, 'force') })
  process.stdout.write([
    '# Demo Vault erstellt',
    '',
    `Path: ${result.outPath}`,
    `Files: ${result.files.length}`,
    '',
    result.files.map(file => `- ${file}`).join('\n'),
  ].join('\n') + '\n')
  return 0
}

function runCommand(name: string, command: string, args: string[]): void {
  process.stdout.write(`\n## ${name}\n`)
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: false,
  })
  if (result.status !== 0) {
    throw new Error(`${name} fehlgeschlagen (${result.status ?? 'signal'})`)
  }
}

async function runReleaseCheck(): Promise<number> {
  runCommand('Typecheck', 'npm', ['run', 'typecheck'])
  runCommand('Tests', 'npm', ['test'])

  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')) as { bin?: unknown }
  const bin = pkg.bin as Record<string, string> | undefined
  if (!bin?.['obsidian-brain'] || !bin?.['obsidian-brain-mcp']) {
    throw new Error('package.json muss obsidian-brain und obsidian-brain-mcp bins enthalten')
  }
  const changelog = readFileSync(join(PROJECT_ROOT, 'CHANGELOG.md'), 'utf-8')
  if (!changelog.includes('## Unreleased')) throw new Error('CHANGELOG.md braucht einen Unreleased-Eintrag')

  const demoPath = mkdtempSync(join(tmpdir(), 'obsidian-brain-demo-'))
  try {
    createDemoVault({ outPath: demoPath, force: true })
    const health = await withVault(demoPath, vault => vault.brainHealthCheck({ checkHooks: false }))
    if (health.summary.fail > 0) throw new Error(`Demo health check failed: ${health.summary.fail} fail`)
    process.stdout.write(`\n## Demo Health\nStatus: ${health.status}; fail=${health.summary.fail}\n`)
  } finally {
    rmSync(demoPath, { recursive: true, force: true })
  }

  process.stdout.write('\nRelease check passed.\n')
  return 0
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'doctor':
      return runDoctor(args)
    case 'install-hooks':
      return runInstallHooks(args)
    case 'init':
      return runInit(args)
    case 'demo':
      return runDemo(args)
    case 'release-check':
      return runReleaseCheck()
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(usage())
      return 0
    default:
      process.stderr.write(`${usage()}\nUnbekannter Befehl: ${args.command}\n`)
      return 1
  }
}

main()
  .then(code => {
    process.exitCode = code
  })
  .catch(err => {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`obsidian-brain: ${msg}\n`)
    process.exitCode = 1
  })
