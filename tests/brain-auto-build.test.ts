import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('brain auto-build', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/Schule/Schule Auto Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture', 'prozedur', 'kunde/schule'],
        quelle: 'knowledge-harvester',
        kunde: 'Schule',
      },
      title: 'Schule Auto Capture',
      body: [
        '## Ablauf',
        '',
        '### 1. DHCP Zielrolle festlegen',
        '',
        'DHCP muss auf der Firewall laufen. Linuxmuster sollte DHCP nicht direkt bereitstellen.',
        '',
        '### 2. Umsetzung',
        '',
        '## Durchgeführte Befehle',
        '',
        '1. `systemctl disable isc-dhcp-server`',
        '2. `opnsense-cli dhcp scope apply`',
        '',
        '## Zusammenfassung',
        '',
        'DHCP wurde fuer Schule auf Firewall-Betrieb festgelegt und dokumentiert.',
        '',
        '## Fehler und Workarounds',
        '',
        '**Fehler:** `dhcp service conflict`',
        '**Fix:** `disable linuxmuster dhcp and use firewall scope`',
        '',
        'Offen: Scope pruefen.',
      ].join('\n'),
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('dry-run previews auto-build without writing derived artifacts', () => {
    const result = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      client: 'Schule',
      dryRun: true,
    })

    assert.equal(result.dryRun, true)
    assert.ok(result.steps.some(step => step.step === 'save_insight'))
    assert.ok(result.steps.some(step => step.step === 'extract_claims'))
    assert.ok(!existsSync(join(vaultPath, 'Knowledge', 'Insights')))
    assert.ok(!existsSync(join(vaultPath, 'Knowledge', '_brain.md')))
  })

  test('apply builds safe derived knowledge and refreshes surfaces', () => {
    const result = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      client: 'Schule',
      dryRun: false,
    })

    assert.equal(result.dryRun, false)
    assert.ok(result.steps.filter(step => step.applied).length >= 5)
    assert.ok(existsSync(join(vaultPath, 'Knowledge', 'Insights')))
    assert.ok(existsSync(join(vaultPath, 'Knowledge', 'Answers')))
    assert.ok(existsSync(join(vaultPath, 'Knowledge', 'Claims')))
    assert.ok(existsSync(join(vaultPath, 'Knowledge', '_brain.md')))
    assert.ok(existsSync(join(vaultPath, 'Knowledge', 'index.md')))
    assert.ok(existsSync(join(vaultPath, 'Knowledge', 'hot.md')))
    assert.ok(existsSync(join(vaultPath, 'Kunden', 'Schule', '_timeline.md')))
    assert.ok(existsSync(join(vaultPath, 'Kunden', 'Schule', '_snapshot.md')))
    assert.ok(existsSync(join(vaultPath, '.brain-auto-build-manifest.json')))
    assert.ok(result.reportPath)
    assert.ok(existsSync(join(vaultPath, result.reportPath)))
    assert.ok(result.plan.some(item => item.action === 'generate_runbook' && item.quality === 'pass'))
    assert.ok(result.steps.some(step => step.step === 'generate_runbook' && step.applied))
    const manifest = JSON.parse(readFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), 'utf-8'))
    assert.ok(manifest.sources['Kunden/Schule/Schule Auto Capture.md'].artifacts.length >= 4)

    const second = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      client: 'Schule',
      dryRun: false,
    })
    assert.ok(second.steps.some(step => step.step === 'manifest' && step.skipped))
  })

  test('auto-build respects new-note limits', () => {
    const limited = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      client: 'Schule',
      maxNewNotes: 1,
      dryRun: false,
    })

    assert.ok(limited.steps.some(step => step.summary.includes('note limit')))
  })

  test('auto-build artifacts can be archived safely by source run', () => {
    vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      client: 'Schule',
      dryRun: false,
    })
    const manifest = JSON.parse(readFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), 'utf-8'))
    const artifacts = manifest.sources['Kunden/Schule/Schule Auto Capture.md'].artifacts as string[]
    assert.ok(artifacts.length >= 4)
    assert.ok(artifacts.some(path => existsSync(join(vaultPath, path))))

    const preview = vault.archiveAutoBuildRun({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      dryRun: true,
    })
    assert.equal(preview.dryRun, true)
    assert.ok(preview.archived.length >= 4)
    assert.ok(artifacts.some(path => existsSync(join(vaultPath, path))))

    const applied = vault.archiveAutoBuildRun({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      dryRun: false,
    })
    assert.equal(applied.dryRun, false)
    assert.ok(applied.archived.length >= 4)
    assert.ok(applied.archived.every(item => existsSync(join(vaultPath, item.to))))
    assert.ok(applied.archived.every(item => !existsSync(join(vaultPath, item.from))))

    const updatedManifest = JSON.parse(readFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), 'utf-8'))
    assert.ok(updatedManifest.sources['Kunden/Schule/Schule Auto Capture.md'].archivedAt)

    const feedback = vault.brainFeedbackSummary()
    assert.ok(feedback.byCategory['auto_build:save_insight'].rejected >= 1)
    assert.ok(feedback.byCategory['auto_build:save_answer'].rejected >= 1)
    const metrics = vault.brainMetrics()
    assert.equal(metrics.autoBuild.archivedSources, 1)
    assert.ok(metrics.autoBuild.usefulnessScore < 1)
    assert.ok(metrics.autoBuild.learnedCategories >= 2)
  })

  test('auto-build gates adapt to repeated negative feedback', () => {
    for (let i = 0; i < 3; i++) {
      vault.recordBrainFeedback({
        itemId: `noise-runbook-${i}`,
        outcome: 'rejected',
        category: 'auto_build:generate_runbook',
        reason: 'test noise',
        dryRun: false,
      })
    }

    const result = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      client: 'Schule',
      dryRun: true,
    })

    const runbook = result.plan.find(item => item.action === 'generate_runbook')
    assert.equal(runbook?.quality, 'skip')
    assert.match(runbook?.reason ?? '', /feedback gate blocked/)
  })

  test('checkpoint, customer snapshot and metrics support long-session upkeep', () => {
    const checkpoint = vault.brainCheckpoint({
      title: 'DHCP Zwischenstand',
      summary: 'DHCP muss auf der Firewall bleiben. Offene Prüfung ist der Scope.',
      client: 'Schule',
      runAutoBuild: true,
      dryRun: false,
    })

    assert.equal(checkpoint.dryRun, false)
    assert.ok(existsSync(join(vaultPath, checkpoint.path)))
    assert.ok(checkpoint.autoBuild)

    const snapshot = vault.buildCustomerSnapshot({ client: 'Schule', dryRun: false })
    assert.equal(snapshot.dryRun, false)
    assert.ok(existsSync(join(vaultPath, 'Kunden', 'Schule', '_snapshot.md')))

    const metrics = vault.brainMetrics()
    assert.ok(metrics.notes >= 2)
    assert.ok(metrics.autoCaptures >= 1)
  })

  test('checkpoint claims stay provisional and do not produce final runbooks', () => {
    const checkpoint = vault.brainCheckpoint({
      title: 'DNS Zwischenstand',
      summary: 'bkbach.de ist nicht registriert. Spaeter muss die richtige Domain geprueft werden.',
      client: 'Schule',
      runAutoBuild: true,
      dryRun: false,
    })

    const autoBuild = checkpoint.autoBuild as any
    assert.ok(autoBuild.steps.some((step: any) => step.step === 'extract_claims'))
    assert.ok(autoBuild.plan.every((item: any) => item.action !== 'generate_runbook' || item.quality === 'skip'))

    const claims = [...vault.notes.values()].filter(note => note.relativePath.startsWith('Knowledge/Claims/'))
    assert.ok(claims.some(note => note.frontmatter.claim_status === 'provisional' && note.frontmatter.source_stage === 'checkpoint'))
  })

  test('research-only captures do not auto-promote to runbooks', async () => {
    writeNote(vaultPath, {
      path: 'Kunden/Schule/Research Only.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture', 'prozedur', 'kunde/schule'],
        quelle: 'knowledge-harvester',
        kunde: 'Schule',
      },
      title: 'Research Only',
      body: [
        '## Zusammenfassung',
        '',
        'Recherche-Zusammenfassung: Traefik hat noch keinen Resolver, DNS muss geprueft werden.',
        '',
        '## Durchgeführte Befehle',
        '',
        '1. `dig NS example.org @1.1.1.1`',
        '2. `cat /srv/docker/edulution-ui/traefik.yml`',
        '3. `docker ps --format "table {{.Names}}"`',
      ].join('\n'),
    })
    vault.shutdown()
    vault = new Vault(vaultPath)
    await vault.init()

    const result = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Research Only.md',
      client: 'Schule',
      dryRun: true,
    })

    const runbook = result.plan.find(item => item.action === 'generate_runbook')
    assert.equal(runbook?.quality, 'skip')
    assert.match(runbook?.reason ?? '', /Recherche\/Analyse/)
  })
})
