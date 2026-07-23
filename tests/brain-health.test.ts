import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('brain health check', () => {
  let vaultPath: string
  let vault: Vault
  const originalClientsPath = process.env.CLIENTS_PATH

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Knowledge/_brain.md',
      frontmatter: { status: 'aktiv', tags: ['brain'], quelle: 'brain-dashboard' },
      title: 'Brain Dashboard',
      body: 'Dashboard',
    })
    writeNote(vaultPath, {
      path: 'Knowledge/index.md',
      frontmatter: { status: 'aktiv', tags: ['index'], quelle: 'knowledge-index' },
      title: 'Knowledge Index',
      body: 'Index',
    })
    writeNote(vaultPath, {
      path: 'Knowledge/hot.md',
      frontmatter: { status: 'aktiv', tags: ['hot'], quelle: 'hot-cache' },
      title: 'Hot Cache',
      body: 'Hot',
    })
    for (const [path, quelle] of [
      ['Maintenance/Capture Review.md', 'capture-review'],
      ['Knowledge/evidence.md', 'evidence-dashboard'],
      ['Maintenance/Knowledge Inbox.md', 'knowledge-inbox'],
      ['Maintenance/Change Ledger.md', 'change-ledger'],
      ['Maintenance/Background Run Report.md', 'brain-run-background'],
    ]) {
      writeNote(vaultPath, {
        path,
        frontmatter: { status: 'aktiv', quelle },
        title: path,
        body: 'Generated surface.',
      })
    }
    writeFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), '{"version":1,"sources":{}}\n', 'utf-8')
    writeFileSync(join(vaultPath, '.action-log.jsonl'), '', 'utf-8')
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    if (originalClientsPath === undefined) delete process.env.CLIENTS_PATH
    else process.env.CLIENTS_PATH = originalClientsPath
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
    assert.ok(result.checks.some(check => check.id === 'config_clients' && check.status === 'ok'))
    assert.deepEqual(result.nextActions, [])
  })

  test('fails readiness when a configured classification file is malformed', () => {
    const clientsPath = join(vaultPath, 'invalid-clients.json')
    writeFileSync(clientsPath, '{ invalid json', 'utf-8')
    process.env.CLIENTS_PATH = clientsPath

    const result = vault.brainHealthCheck({ checkHooks: false })

    assert.equal(result.status, 'fail')
    assert.ok(result.checks.some(check => check.id === 'config_clients' && check.status === 'fail'))
  })

  test('fails readiness when a fixed generated surface has a foreign owner', () => {
    writeNote(vaultPath, {
      path: 'Maintenance/Knowledge Inbox.md',
      frontmatter: { status: 'aktiv', quelle: 'user' },
      title: 'Personal Inbox',
      body: 'User maintained.',
    })

    const result = vault.brainHealthCheck({ checkHooks: false })

    assert.equal(result.status, 'fail')
    assert.ok(result.checks.some(check => check.id === 'knowledge_inbox' && check.status === 'fail'))
  })

  test('fails readiness on a corrupt auto-build manifest', () => {
    writeFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), '{ broken', 'utf-8')

    const result = vault.brainHealthCheck({ checkHooks: false })

    assert.equal(result.status, 'fail')
    assert.ok(result.checks.some(check => check.id === 'auto_build_manifest' && check.status === 'fail'))
  })
})
