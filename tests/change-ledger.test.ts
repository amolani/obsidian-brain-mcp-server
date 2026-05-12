import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { appendActionLog } from '../services/action-log.ts'
import { cleanupVault, createTempVault } from './helpers.ts'

describe('change ledger', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    appendActionLog(vaultPath, {
      tool: 'test_tool',
      mode: 'apply',
      targets: ['Knowledge/Test.md'],
      summary: 'Test write',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('builds a dry-run-first markdown ledger from action log', () => {
    const preview = vault.buildChangeLedger({ dryRun: true })
    assert.equal(preview.dryRun, true)
    assert.equal(preview.entryCount, 1)
    assert.match(preview.content, /test_tool/)
    assert.ok(!existsSync(join(vaultPath, preview.path)))

    const applied = vault.buildChangeLedger({ dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.ok(existsSync(join(vaultPath, applied.path)))
  })
})
