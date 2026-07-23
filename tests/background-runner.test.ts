import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
    assert.ok(!readdirSync(vaultPath).some(name => name.includes('.brain-background-last-run.json.tmp-')))
    assert.ok(!readdirSync(join(vaultPath, 'Maintenance')).some(name => name.includes('Background Run Report.md.tmp-')))
    assert.equal(result.jobs.find(job => job.id === 'safe_maintenance_preview')?.status, 'ok')

    const report = readFileSync(join(vaultPath, 'Maintenance', 'Background Run Report.md'), 'utf-8')
    assert.match(report, /# Background Run Report/)
    assert.match(report, /safe_maintenance_preview/)
    assert.match(report, /## Intelligence Signals/)
    assert.match(report, /Review-Backlog:/)
  })

  test('fails closed when a background lock already exists', () => {
    writeFileSync(join(vaultPath, '.brain-background.lock'), 'existing\n', 'utf-8')

    const result = vault.runBackgroundBrain({ dryRun: false, jobs: ['brain_metrics'] })

    assert.equal(result.status, 'fail')
    assert.equal(result.jobs[0].id, 'lock')
    assert.ok(existsSync(join(vaultPath, '.brain-background.lock')))
    assert.ok(!existsSync(join(vaultPath, 'Maintenance', 'Background Run Report.md')))
  })

  test('maps a failed health check to a failed background job', () => {
    const originalHealthCheck = vault.brainHealthCheck.bind(vault)
    vault.brainHealthCheck = options => {
      const result = originalHealthCheck(options)
      return {
        ...result,
        status: 'fail' as const,
        summary: { ...result.summary, fail: result.summary.fail + 1 },
      }
    }

    const result = vault.runBackgroundBrain({ jobs: ['brain_health_check'], isolateJobs: false })

    assert.equal(result.status, 'fail')
    assert.equal(result.jobs[0]?.status, 'fail')
  })

  test('reports an individual job that exceeds its runtime budget', () => {
    const originalMetrics = vault.brainMetrics.bind(vault)
    vault.brainMetrics = () => {
      const until = Date.now() + 15
      while (Date.now() < until) {
        // Busy work makes the synchronous job exceed its cooperative budget.
      }
      return originalMetrics()
    }

    const result = vault.runBackgroundBrain({
      jobs: ['brain_metrics'],
      maxRuntimeMs: 1000,
      maxJobRuntimeMs: 1,
      isolateJobs: false,
    })

    assert.equal(result.status, 'fail')
    assert.equal(result.maxJobRuntimeMs, 1)
    assert.equal(result.jobs[0]?.status, 'fail')
    assert.match(result.jobs[0]?.summary ?? '', /Job-Budget 1 ms überschritten/)
  })

  test('hard-stops an isolated job at its deadline', () => {
    const result = vault.runBackgroundBrain({
      jobs: ['brain_metrics'],
      maxRuntimeMs: 1000,
      maxJobRuntimeMs: 1,
    })

    assert.equal(result.status, 'fail')
    assert.equal(result.jobs[0]?.status, 'fail')
    assert.match(result.jobs[0]?.summary ?? '', /Hard timeout/)
  })

  test('refuses an apply run before jobs when the fixed report is user-owned', () => {
    writeNote(vaultPath, {
      path: 'Maintenance/Background Run Report.md',
      frontmatter: { status: 'aktiv', quelle: 'user' },
      title: 'My Background Notes',
      body: 'Do not replace this file.',
    })
    const before = readFileSync(join(vaultPath, 'Maintenance', 'Background Run Report.md'), 'utf-8')

    assert.throws(
      () => vault.runBackgroundBrain({ dryRun: false, jobs: ['brain_metrics'] }),
      /nicht von brain-run-background generiert/,
    )

    assert.equal(readFileSync(join(vaultPath, 'Maintenance', 'Background Run Report.md'), 'utf-8'), before)
    assert.ok(!existsSync(join(vaultPath, '.brain-background.lock')))
    assert.ok(!existsSync(join(vaultPath, '.brain-background-last-run.json')))
  })

  test('previews and processes queued auto-captures when explicitly enabled', () => {
    const manifestPath = join(vaultPath, '.brain-auto-build-manifest.json')
    const preview = vault.runBackgroundBrain({
      jobs: ['brain_auto_build'],
      runAutoBuild: true,
      maxAutoBuildSources: 1,
    })
    const previewDetail = preview.jobs[0]?.detail as { queued: number; processed: number; remaining: number }

    assert.equal(preview.status, 'ok')
    assert.equal(previewDetail.queued, 1)
    assert.equal(previewDetail.processed, 1)
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf-8')), { version: 1, sources: {} })

    const applied = vault.runBackgroundBrain({
      dryRun: false,
      jobs: ['brain_auto_build'],
      runAutoBuild: true,
      maxAutoBuildSources: 1,
      maxJobRuntimeMs: 10000,
    })
    const appliedDetail = applied.jobs[0]?.detail as { queued: number; processed: number; remaining: number }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { sources: Record<string, unknown> }

    assert.equal(applied.status, 'ok')
    assert.equal(appliedDetail.processed, 1)
    assert.ok(manifest.sources['Kunden/Acme/Captures/Session.md'])

    const repeated = vault.runBackgroundBrain({
      dryRun: false,
      jobs: ['brain_auto_build'],
      runAutoBuild: true,
      maxAutoBuildSources: 1,
    })
    const repeatedDetail = repeated.jobs[0]?.detail as { queued: number; processed: number }
    assert.equal(repeatedDetail.queued, 0)
    assert.equal(repeatedDetail.processed, 0)

    vault.archiveAutoBuildRun({
      sourcePath: 'Kunden/Acme/Captures/Session.md',
      dryRun: false,
    })
    const afterArchive = vault.runBackgroundBrain({
      dryRun: false,
      jobs: ['brain_auto_build'],
      runAutoBuild: true,
      maxAutoBuildSources: 1,
    })
    const afterArchiveDetail = afterArchive.jobs[0]?.detail as { queued: number; processed: number }
    assert.equal(afterArchiveDetail.queued, 0)
    assert.equal(afterArchiveDetail.processed, 0)
  })

  test('warns when the persisted review backlog grows between runs', async () => {
    const first = vault.runBackgroundBrain({ dryRun: false, jobs: ['brain_metrics'] })
    assert.equal(first.status, 'ok')

    writeNote(vaultPath, {
      path: 'Knowledge/Claims/New Claim.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['claim'],
        claim_status: 'provisional',
        quelle: 'Kunden/Acme/Captures/Session.md',
      },
      title: 'New Claim',
      body: 'A newly queued provisional claim.',
    })
    vault.shutdown()
    vault = new Vault(vaultPath)
    await vault.init()

    const second = vault.runBackgroundBrain({ dryRun: false, jobs: ['brain_metrics'] })

    assert.equal(second.status, 'warn')
    assert.ok(second.nextActions.some(action => /Review-Backlog/.test(action)))
  })
})
