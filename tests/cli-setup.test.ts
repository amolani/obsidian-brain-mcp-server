import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installClaudeHooks, planClaudeHookInstall } from '../services/claude-hooks.ts'
import { createDemoVault } from '../services/demo-vault.ts'

const roots: string[] = []

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cli setup and hooks', () => {
  test('plans hook installation without writing settings', () => {
    const root = tempDir('obsidian-hooks-')
    const settingsPath = join(root, 'settings.json')
    const result = planClaudeHookInstall({
      vaultPath: '/tmp/example-vault',
      settingsPath,
    })

    assert.equal(result.dryRun, true)
    assert.equal(result.changed, true)
    assert.ok(!existsSync(settingsPath))
    assert.equal((result.after.env as any).VAULT_PATH, '/tmp/example-vault')
    assert.ok(JSON.stringify(result.after).includes('session-checkpoint.ts'))
  })

  test('applies hooks with backup and preserves unrelated settings', () => {
    const root = tempDir('obsidian-hooks-')
    const settingsPath = join(root, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      env: { EXISTING: '1' },
      hooks: {
        PostToolUse: [{
          matcher: 'Edit',
          hooks: [{ type: 'command', command: 'node /tmp/custom.js' }],
        }],
      },
    }, null, 2), 'utf-8')

    const result = installClaudeHooks({
      vaultPath: '/tmp/example-vault',
      settingsPath,
      apply: true,
    })

    assert.equal(result.dryRun, false)
    assert.equal(result.changed, true)
    assert.ok(result.backupPath)
    assert.ok(existsSync(result.backupPath!))

    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    assert.equal(written.env.EXISTING, '1')
    assert.equal(written.env.VAULT_PATH, '/tmp/example-vault')
    assert.ok(JSON.stringify(written).includes('/tmp/custom.js'))
    assert.ok(written.hooks.PostToolUse.some((entry: any) => entry.matcher === 'Bash' && JSON.stringify(entry).includes('session-checkpoint.ts')))

    const second = installClaudeHooks({ vaultPath: '/tmp/example-vault', settingsPath, apply: true })
    assert.equal(second.changed, false)
  })

  test('repairs checkpoint hook matcher without duplicating the hook', () => {
    const root = tempDir('obsidian-hooks-')
    const settingsPath = join(root, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({
      env: { VAULT_PATH: '/tmp/example-vault' },
      hooks: {
        PostToolUse: [{
          matcher: 'Edit',
          hooks: [{ type: 'command', command: 'node /home/amo/Documents/obsidian-brain-mcp/hooks/session-checkpoint.ts' }],
        }],
      },
    }, null, 2), 'utf-8')

    const result = installClaudeHooks({
      vaultPath: '/tmp/example-vault',
      settingsPath,
      apply: true,
    })

    assert.equal(result.changed, true)
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const matching = written.hooks.PostToolUse.filter((entry: any) => JSON.stringify(entry).includes('session-checkpoint.ts'))
    assert.equal(matching.length, 1)
    assert.match(matching[0].matcher, /Bash/)
  })

  test('demo generator creates a health-checkable vault', async () => {
    const root = tempDir('obsidian-cli-')
    const demoPath = join(root, 'demo')
    const result = createDemoVault({ outPath: demoPath })
    assert.equal(result.files.length, 18)
    assert.ok(existsSync(join(demoPath, 'Knowledge', '_brain.md')))
  })
})
