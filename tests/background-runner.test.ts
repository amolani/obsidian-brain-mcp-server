import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('background brain runner', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/Acme/Captures/Session.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture', 'implementation'],
        quelle: 'knowledge-harvester',
        kunde: 'Acme',
        source_stage: 'stop_capture',
      },
      title: 'Session',
      body: '## Durchgeführte Befehle\n\n1. `systemctl restart app`\n',
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

  test('writes a background run report and keeps preview-only jobs dry-run', () => {
    const result = vault.runBackgroundBrain({
      dryRun: false,
      maxRuntimeMs: 10000,
      jobs: [
        'brain_metrics',
        'build_brain_dashboard',
        'build_capture_review',
        'build_evidence_dashboard',
        'build_knowledge_inbox',
        'build_change_ledger',
        'build_knowledge_index',
        'brain_schedule',
        'migrate_brain_metadata_preview',
        'safe_maintenance_preview',
        'semantic_index_preview',
      ],
    })

    assert.equal(result.dryRun, false)
    assert.equal(result.status, 'ok')
    assert.ok(existsSync(join(vaultPath, 'Maintenance', 'Background Run Report.md')))
    assert.ok(existsSync(join(vaultPath, '.brain-background-last-run.json')))
    assert.ok(!existsSync(join(vaultPath, '.brain-background.lock')))
    assert.equal(result.jobs.find(job => job.id === 'safe_maintenance_preview')?.status, 'ok')

    const report = readFileSync(join(vaultPath, 'Maintenance', 'Background Run Report.md'), 'utf-8')
    assert.match(report, /# Background Run Report/)
    assert.match(report, /safe_maintenance_preview/)
  })

  test('fails closed when a background lock already exists', () => {
    writeFileSync(join(vaultPath, '.brain-background.lock'), 'existing\n', 'utf-8')

    const result = vault.runBackgroundBrain({ dryRun: false, jobs: ['brain_metrics'] })

    assert.equal(result.status, 'fail')
    assert.equal(result.jobs[0].id, 'lock')
    assert.ok(existsSync(join(vaultPath, '.brain-background.lock')))
    assert.ok(!existsSync(join(vaultPath, 'Maintenance', 'Background Run Report.md')))
  })
})
