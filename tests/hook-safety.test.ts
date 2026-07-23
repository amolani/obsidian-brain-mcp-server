import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const policyPath = join(projectRoot, 'brain-policy.json')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) cleanupVault(root)
})

function runHook(name: string, vaultPath: string, input = '') {
  return spawnSync(process.execPath, [join(projectRoot, 'hooks', name)], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      VAULT_PATH: vaultPath,
      BRAIN_POLICY_PATH: policyPath,
    },
  })
}

describe('hook write safety', () => {
  test('standalone daily-note hook logs its write exactly once', () => {
    const vaultPath = createTempVault()
    roots.push(vaultPath)

    const first = runHook('daily-note-hook.ts', vaultPath)
    const second = runHook('daily-note-hook.ts', vaultPath)

    assert.equal(first.status, 0, first.stderr)
    assert.equal(second.status, 0, second.stderr)
    const today = new Date().toISOString().split('T')[0]
    assert.ok(existsSync(join(vaultPath, 'Daily', `${today}.md`)))
    const entries = readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8').trim().split('\n')
    assert.equal(entries.length, 1)
    assert.equal(JSON.parse(entries[0]).tool, 'create_daily_note')
  })

  test('session-start never applies folder organization from an invalid policy', () => {
    const vaultPath = createTempVault()
    roots.push(vaultPath)
    writeNote(vaultPath, {
      path: 'Referenz/Docker Notes.md',
      title: 'Docker Notes',
      body: 'Docker compose configuration.',
    })
    const invalidPolicyPath = join(vaultPath, 'unsafe-policy.json')
    const policy = JSON.parse(readFileSync(policyPath, 'utf-8'))
    policy.hooks.autoOrganize = true
    writeFileSync(invalidPolicyPath, `${JSON.stringify(policy)}\n`, 'utf-8')

    const result = spawnSync(process.execPath, [join(projectRoot, 'hooks', 'session-context.ts')], {
      input: JSON.stringify({ cwd: '/tmp/unmatched-project' }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        VAULT_PATH: vaultPath,
        BRAIN_POLICY_PATH: invalidPolicyPath,
      },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(join(vaultPath, 'Referenz', 'Docker Notes.md')))
    assert.ok(!existsSync(join(vaultPath, 'Technik', 'Docker', 'Docker Notes.md')))
  })

  test('daily-note hook does not follow an escaping Daily symlink', { skip: process.platform === 'win32' }, () => {
    const vaultPath = createTempVault()
    const outsidePath = createTempVault()
    roots.push(vaultPath, outsidePath)
    symlinkSync(outsidePath, join(vaultPath, 'Daily'), 'dir')

    const result = runHook('daily-note-hook.ts', vaultPath)
    const today = new Date().toISOString().split('T')[0]

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /"result":"continue"/)
    assert.ok(!existsSync(join(outsidePath, `${today}.md`)))
    assert.match(result.stderr, /verlässt über Symlink/)
  })
})
