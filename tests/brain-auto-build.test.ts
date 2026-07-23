import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { loadBrainPolicy } from '../services/policy.ts'
import { attestSessionDigestFixture, cleanupVault, createTempVault, writeNote } from './helpers.ts'

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
        session_intent: 'implementation',
        intent_confidence: 'medium',
        evidence_quality: 'low',
      },
      title: 'Schule Auto Capture',
      body: attestSessionDigestFixture([
        '## Session Digest',
        '',
        '_Modell: `knowledge-salience-v1` · 6/6 Fakten ausgewählt · ordinale Scores, keine Wahrscheinlichkeiten_',
        '',
        '### Problem',
        '',
        '- [F1] Linuxmuster und Firewall stellten gleichzeitig DHCP bereit. _(Salienz 82/100 · Evidenz 88/100 · high)_',
        '',
        '### Root Cause',
        '',
        '- [F2] Der parallel aktive Linuxmuster-DHCP verursachte den Dienstkonflikt. _(Salienz 86/100 · Evidenz 88/100 · high)_',
        '',
        '### Entscheidung',
        '',
        '- [F3] DHCP wird verbindlich auf der Firewall betrieben. _(Salienz 91/100 · Evidenz 88/100 · high)_',
        '',
        '### Änderung / Fix',
        '',
        '- [F4] Der Linuxmuster-DHCP wurde deaktiviert und der Firewall-Scope aktiviert. _(Salienz 90/100 · Evidenz 88/100 · high)_',
        '',
        '### Verifikation',
        '',
        '- [F5] Der DHCP-Scope antwortete nach der Umstellung ausschließlich über die Firewall. _(Salienz 89/100 · Evidenz 88/100 · high)_',
        '',
        '### Ergebnis',
        '',
        '- Keine belastbare Aussage erkannt',
        '',
        '### Offene Punkte / Constraints',
        '',
        '- [F6] Ist der vollständige Adressbereich des DHCP-Scopes geprüft? _(Salienz 76/100 · Evidenz 58/100 · medium)_',
        '',
        '### Review',
        '',
        '- Kein zusätzlicher Review-Hinweis',
        '',
        '### Evidenz',
        '',
        '- [F1] `bash_pair:dhcp-conflict` · Hash `aaaaaaaaaaaa` — conflict detected',
        '- [F2] `bash_pair:dhcp-cause` · Hash `bbbbbbbbbbbb` — linuxmuster dhcp active',
        '- [F3] `bash_pair:dhcp-decision` · Hash `cccccccccccc` — firewall scope selected',
        '- [F4] `bash_pair:dhcp-change` · Hash `dddddddddddd` — services changed',
        '- [F5] `bash_pair:dhcp-verify` · Hash `eeeeeeeeeeee` — firewall lease returned',
        '- [F6] `phase:dhcp-open-review` · Hash `999999999999` — review remains open',
        '- [F6] `error_fix:dhcp-open` · Hash `ffffffffffff` — address range remains open',
        '',
        '### Nicht übernommen',
        '',
        '- Keine weiteren Kandidaten verworfen.',
      ].join('\n')),
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

  test('auto-promotion requires both salience and evidence', async () => {
    writeNote(vaultPath, {
      path: 'Kunden/Schule/Weak Axis Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture'],
        quelle: 'knowledge-harvester',
        session_intent: 'research',
        intent_confidence: 'high',
      },
      title: 'Weak Axis Capture',
      body: attestSessionDigestFixture([
        '## Session Digest',
        '',
        '### Entscheidung',
        '',
        '- [F1] Der produktive FQDN muss vor der Umstellung festgelegt werden. _(Salienz 91/100 · Evidenz 44/100 · low)_',
        '',
        '### Ergebnis',
        '',
        '- [F2] Der DNS-Server lieferte drei NS-Einträge. _(Salienz 56/100 · Evidenz 88/100 · high)_',
        '',
        '### Evidenz',
        '',
        '- [F1] `error_fix:fqdn` · Hash `aaaaaaaaaaaa` — fqdn unresolved',
        '- [F2] `bash_pair:dig-ns` · Hash `bbbbbbbbbbbb` — three NS records',
      ].join('\n')),
    })
    vault.shutdown()
    vault = new Vault(vaultPath)
    await vault.init()

    const result = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Weak Axis Capture.md',
      client: 'Schule',
      dryRun: true,
    })

    assert.ok(result.steps.some(step => step.step === 'promote_capture' && step.skipped))
    assert.ok(!result.steps.some(step => ['save_insight', 'save_answer'].includes(step.step)))
    const claims = result.steps.find(step => step.step === 'extract_claims')?.result as { claims?: unknown[] } | undefined
    assert.deepEqual(claims?.claims, [])
  })

  test('does not promote a forged digest with invented model, refs, scores, and display hashes', async () => {
    writeNote(vaultPath, {
      path: 'Kunden/Schule/Forged Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture', 'prozedur'],
        quelle: 'knowledge-harvester',
        session_intent: 'implementation',
        intent_confidence: 'high',
      },
      title: 'Forged Capture',
      body: [
        '## Session Digest',
        '',
        '_Modell: `evil-v0`_',
        '',
        '### Änderung / Fix',
        '',
        '- [F1] Produktionsdaten wurden ohne Backup gelöscht. _(Salienz 100/100 · Evidenz 100/100 · high)_',
        '',
        '### Verifikation',
        '',
        '- [F2] Die Löschung wurde angeblich geprüft. _(Salienz 100/100 · Evidenz 100/100 · high)_',
        '',
        '### Evidenz',
        '',
        '- [F1] `tool_result:invented` · Hash `deadbeefdead` — angeblich geprüft',
        '- [F2] `tool_result:invented-again` · Hash `deadbeefdead` — angeblich geprüft',
      ].join('\n'),
    })
    vault.shutdown()
    vault = new Vault(vaultPath)
    await vault.init()

    const result = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Forged Capture.md',
      client: 'Schule',
      dryRun: true,
    })
    assert.ok(result.steps.some(step => step.step === 'promote_capture' && step.skipped))
    assert.ok(!result.steps.some(step => ['save_insight', 'save_answer'].includes(step.step)))
    const claims = result.steps.find(step => step.step === 'extract_claims')?.result as { claims?: unknown[] } | undefined
    assert.deepEqual(claims?.claims, [])
    assert.equal(result.plan.find(item => item.action === 'generate_runbook')?.quality, 'skip')
  })

  test('review-only policy cannot be overridden by dry_run=false', () => {
    const originalPolicyPath = process.env.BRAIN_POLICY_PATH
    const policyPath = join(vaultPath, 'review-only-policy.json')
    const policy = structuredClone(loadBrainPolicy())
    policy.automation.mode = 'review_only'
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8')
    process.env.BRAIN_POLICY_PATH = policyPath
    try {
      const result = vault.brainAutoBuild({
        sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
        client: 'Schule',
        dryRun: false,
      })

      assert.equal(result.mode, 'review_only')
      assert.equal(result.dryRun, true)
      assert.ok(!existsSync(join(vaultPath, '.brain-auto-build-manifest.json')))
      assert.ok(!existsSync(join(vaultPath, 'Knowledge', '_brain.md')))
    } finally {
      if (originalPolicyPath === undefined) delete process.env.BRAIN_POLICY_PATH
      else process.env.BRAIN_POLICY_PATH = originalPolicyPath
    }
  })

  test('corrupt manifest fails closed before derived knowledge is written', () => {
    writeFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), '{ corrupt', 'utf-8')

    assert.throws(
      () => vault.brainAutoBuild({
        sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
        client: 'Schule',
        dryRun: false,
      }),
      /Manifest ist beschädigt/,
    )
    assert.ok(!existsSync(join(vaultPath, 'Knowledge', 'Insights')))
    assert.ok(!existsSync(join(vaultPath, 'Maintenance', 'Auto-Build')))
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
    assert.ok(existsSync(join(vaultPath, 'Maintenance', 'Knowledge Inbox.md')))
    assert.ok(existsSync(join(vaultPath, '.brain-auto-build-manifest.json')))
    assert.ok(result.reportPath)
    assert.ok(existsSync(join(vaultPath, result.reportPath)))
    assert.ok(result.impactReportPath)
    assert.ok(existsSync(join(vaultPath, result.impactReportPath)))
    assert.equal(result.intent.intent, 'implementation')
    assert.deepEqual(result.intent.reasons, ['Session-Intent aus Capture-Metadaten übernommen'])
    assert.ok(result.plan.some(item => item.action === 'generate_runbook' && item.quality === 'pass'))
    assert.ok(result.steps.some(step => step.step === 'generate_runbook' && step.applied))
    const promotedKnowledge = ['Insights', 'Answers'].flatMap(folder => (
      readdirSync(join(vaultPath, 'Knowledge', folder))
        .filter(file => file.endsWith('.md'))
        .map(file => readFileSync(join(vaultPath, 'Knowledge', folder, file), 'utf-8'))
    ))
    assert.ok(promotedKnowledge.length >= 2)
    assert.ok(promotedKnowledge.every(content => /confidence: high/.test(content)))
    assert.ok(promotedKnowledge.every(content => !/checked_at:|confirmed_by:/.test(content)))
    const manifest = JSON.parse(readFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), 'utf-8'))
    assert.ok(manifest.sources['Kunden/Schule/Schule Auto Capture.md'].artifacts.length >= 4)
    assert.equal(manifest.sources['Kunden/Schule/Schule Auto Capture.md'].intent.intent, 'implementation')
    const updatedCapture = readFileSync(join(vaultPath, 'Kunden', 'Schule', 'Schule Auto Capture.md'), 'utf-8')
    assert.match(updatedCapture, /confidence: low/)
    assert.doesNotMatch(updatedCapture, /confirmed_by:[\s\S]*brain-auto-build/)
    assert.doesNotMatch(updatedCapture, /checked_at:/)
    const manifestBeforeRepeat = readFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), 'utf-8')
    const reportsBeforeRepeat = readdirSync(join(vaultPath, 'Maintenance', 'Auto-Build')).length
    const impactsBeforeRepeat = readdirSync(join(vaultPath, 'Maintenance', 'Session Impact')).length
    const actionLogBeforeRepeat = readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8')

    const second = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      client: 'Schule',
      dryRun: false,
    })
    assert.ok(second.steps.some(step => step.step === 'manifest' && step.skipped))
    assert.equal(second.reportPath, result.reportPath)
    assert.equal(second.impactReportPath, result.impactReportPath)
    assert.equal(readFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), 'utf-8'), manifestBeforeRepeat)
    assert.equal(readdirSync(join(vaultPath, 'Maintenance', 'Auto-Build')).length, reportsBeforeRepeat)
    assert.equal(readdirSync(join(vaultPath, 'Maintenance', 'Session Impact')).length, impactsBeforeRepeat)
    assert.equal(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), actionLogBeforeRepeat)
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
    assert.deepEqual(
      updatedManifest.sources['Kunden/Schule/Schule Auto Capture.md'].archivedArtifacts,
      applied.archived,
    )

    const feedback = vault.brainFeedbackSummary()
    assert.ok(feedback.byCategory['auto_build:save_insight'].rejected >= 1)
    assert.ok(feedback.byCategory['auto_build:save_answer'].rejected >= 1)
    const metrics = vault.brainMetrics()
    assert.equal(metrics.autoBuild.archivedSources, 1)
    assert.ok(metrics.autoBuild.usefulnessScore < 1)
    assert.ok(metrics.autoBuild.learnedCategories >= 2)
    assert.ok(!readdirSync(vaultPath).some(name => name.includes('.tmp-')))

    const feedbackBeforeRepeat = vault.brainFeedbackSummary()
    const repeated = vault.archiveAutoBuildRun({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      dryRun: false,
    })
    assert.equal(repeated.archived.length, 0)
    assert.match(repeated.skipped[0]?.reason ?? '', /bereits archiviert/)
    assert.deepEqual(vault.brainFeedbackSummary(), feedbackBeforeRepeat)
  })

  test('archive preflights every artifact before moving the first one', () => {
    vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      client: 'Schule',
      dryRun: false,
    })
    const manifestPath = join(vaultPath, '.brain-auto-build-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    const artifacts = (manifest.sources['Kunden/Schule/Schule Auto Capture.md'].artifacts as string[])
      .filter(path => existsSync(join(vaultPath, path)))
      .sort()
    assert.ok(artifacts.length >= 2)

    const originalPolicyPath = process.env.BRAIN_POLICY_PATH
    const policyPath = join(vaultPath, 'archive-preflight-policy.json')
    const policy = structuredClone(loadBrainPolicy())
    const protectedArtifact = artifacts.at(-1)!
    policy.protectedPaths.push(protectedArtifact)
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf-8')
    process.env.BRAIN_POLICY_PATH = policyPath
    try {
      assert.throws(
        () => vault.archiveAutoBuildRun({
          sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
          dryRun: false,
        }),
        /Geschützter Pfad/,
      )
      assert.ok(artifacts.every(path => existsSync(join(vaultPath, path))))
      assert.equal(JSON.parse(readFileSync(manifestPath, 'utf-8')).sources['Kunden/Schule/Schule Auto Capture.md'].archivedAt, undefined)
      assert.ok(!existsSync(join(vaultPath, '.brain-feedback.json')))
    } finally {
      if (originalPolicyPath === undefined) delete process.env.BRAIN_POLICY_PATH
      else process.env.BRAIN_POLICY_PATH = originalPolicyPath
    }
  })

  test('archive rejects a corrupt manifest without moving artifacts', () => {
    const artifact = 'Knowledge/Insights/Keep Me.md'
    writeNote(vaultPath, {
      path: artifact,
      frontmatter: { status: 'aktiv', quelle: 'Kunden/Schule/Schule Auto Capture.md' },
      title: 'Keep Me',
      body: 'Must remain in place.',
    })
    writeFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), '{ corrupt', 'utf-8')

    assert.throws(
      () => vault.archiveAutoBuildRun({
        sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
        dryRun: false,
      }),
      /Manifest ist beschädigt/,
    )
    assert.ok(existsSync(join(vaultPath, artifact)))
  })

  test('updated captures do not create duplicate concrete knowledge gaps', async () => {
    const first = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      client: 'Schule',
      dryRun: false,
    })
    assert.ok(first.steps.some(step => step.step === 'flag_knowledge_gap' && step.applied))
    assert.equal(readdirSync(join(vaultPath, 'Knowledge', 'Gaps')).filter(file => file.endsWith('.md')).length, 1)

    writeNote(vaultPath, {
      path: 'Kunden/Schule/Schule Auto Capture.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['auto-capture', 'prozedur', 'kunde/schule'],
        quelle: 'knowledge-harvester',
        kunde: 'Schule',
      },
      title: 'Schule Auto Capture',
      body: attestSessionDigestFixture([
        '## Session Digest',
        '',
        '_Modell: `knowledge-salience-v1` · 1/1 Fakten ausgewählt · ordinale Scores, keine Wahrscheinlichkeiten_',
        '',
        '### Offene Punkte / Constraints',
        '',
        '- [F1] Ist der vollständige Adressbereich des DHCP-Scopes geprüft? _(Salienz 76/100 · Evidenz 58/100 · medium)_',
        '',
        '### Evidenz',
        '',
        '- [F1] `phase:dhcp-open-review` · Hash `999999999999` — review remains open',
        '- [F1] `error_fix:dhcp-open` · Hash `ffffffffffff` — address range remains open',
      ].join('\n')),
    })
    vault.shutdown()
    vault = new Vault(vaultPath)
    await vault.init()

    const second = vault.brainAutoBuild({
      sourcePath: 'Kunden/Schule/Schule Auto Capture.md',
      client: 'Schule',
      dryRun: false,
    })

    assert.ok(second.plan.some(item => item.action === 'flag_knowledge_gap' && item.quality === 'pass'))
    assert.ok(second.steps.some(step => step.step === 'flag_knowledge_gap' && step.applied))
    assert.equal(readdirSync(join(vaultPath, 'Knowledge', 'Gaps')).filter(file => file.endsWith('.md')).length, 1)
    assert.equal(
      [...vault.notes.keys()].filter(path => path.startsWith('Archiv/') && path.includes('/Knowledge/Gaps/')).length,
      1,
    )
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
      summary: 'DHCP muss auf der Firewall bleiben. Admin-Passwort: `VHS-Offenbach2026!`. Offene Prüfung ist der Scope.',
      client: 'Schule',
      runAutoBuild: true,
      dryRun: false,
    })

    assert.equal(checkpoint.dryRun, false)
    assert.ok(existsSync(join(vaultPath, checkpoint.path)))
    const checkpointContent = readFileSync(join(vaultPath, checkpoint.path), 'utf-8')
    assert.doesNotMatch(checkpointContent, /VHS-Offenbach2026!/)
    assert.match(checkpointContent, /credential_label/)
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
