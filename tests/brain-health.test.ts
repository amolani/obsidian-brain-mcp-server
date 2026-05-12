import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('brain health check', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Knowledge/_brain.md',
      frontmatter: { status: 'aktiv', tags: ['brain'] },
      title: 'Brain Dashboard',
      body: 'Dashboard',
    })
    writeNote(vaultPath, {
      path: 'Knowledge/index.md',
      frontmatter: { status: 'aktiv', tags: ['index'] },
      title: 'Knowledge Index',
      body: 'Index',
    })
    writeNote(vaultPath, {
      path: 'Knowledge/hot.md',
      frontmatter: { status: 'aktiv', tags: ['hot'] },
      title: 'Hot Cache',
      body: 'Hot',
    })
    writeFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), '{"version":1,"sources":{}}\n', 'utf-8')
    writeFileSync(join(vaultPath, '.action-log.jsonl'), '', 'utf-8')
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('reports operational readiness without writing to the vault', () => {
    const result = vault.brainHealthCheck({ checkHooks: false })

    assert.equal(result.status, 'ok')
    assert.equal(result.summary.fail, 0)
    assert.ok(result.checks.some(check => check.id === 'auto_build_policy' && check.status === 'ok'))
    assert.ok(result.checks.some(check => check.id === 'brain_dashboard' && check.status === 'ok'))
    assert.ok(result.checks.some(check => check.id === 'tool_policy_brain_auto_build' && check.status === 'ok'))
    assert.deepEqual(result.nextActions, [])
  })
})
