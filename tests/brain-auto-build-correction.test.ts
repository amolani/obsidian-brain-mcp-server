import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import {
  attestSessionDigestFixture,
  cleanupVault,
  createTempVault,
  writeNote,
} from './helpers.ts'

const SOURCE_PATH = 'Kunden/Schule/DHCP Late Correction Capture.md'

interface ManifestRun {
  hash: string
  artifacts: string[]
  archivedAt?: string
  supersededAt?: string
  supersededByHash?: string
  archiveFolder?: string
  archivedArtifacts?: Array<{ from: string; to: string }>
  archiveSkipped?: Array<{ path: string; reason: string }>
  previousRuns?: ManifestRun[]
}

function digest(revision: 'initial' | 'corrected'): string {
  const initial = revision === 'initial'
  const decision = initial
    ? 'DHCP bleibt verbindlich auf dem Linuxmuster-Server.'
    : 'DHCP wird verbindlich auf der Firewall betrieben.'
  const change = initial
    ? 'Der Firewall-DHCP wurde deaktiviert und der Linuxmuster-DHCP aktiviert.'
    : 'Der Linuxmuster-DHCP wurde deaktiviert und der Firewall-Scope aktiviert.'
  const verification = initial
    ? 'Ein Testclient erhielt sein DHCP-Lease ausschließlich vom Linuxmuster-Server.'
    : 'Ein Testclient erhielt sein DHCP-Lease ausschließlich vom Firewall-Scope.'
  const suffix = initial ? '1' : '2'

  return attestSessionDigestFixture([
    '## Session Digest',
    '',
    '### Entscheidung',
    '',
    `- [F1] ${decision} _(Salienz 91/100 · Evidenz 88/100 · high)_`,
    '',
    '### Änderung / Fix',
    '',
    `- [F2] ${change} _(Salienz 94/100 · Evidenz 88/100 · high)_`,
    '',
    '### Verifikation',
    '',
    `- [F3] ${verification} _(Salienz 95/100 · Evidenz 88/100 · high)_`,
    '',
    '### Evidenz',
    '',
    `- [F1] \`bash_pair:dhcp-decision-${suffix}\` · Hash \`${suffix.repeat(12)}\` — decision persisted`,
    `- [F2] \`bash_pair:dhcp-change-${suffix}\` · Hash \`${suffix.repeat(12)}\` — service roles changed`,
    `- [F3] \`bash_pair:dhcp-verification-${suffix}\` · Hash \`${suffix.repeat(12)}\` — lease source verified`,
  ].join('\n'))
}

function writeCapture(vaultPath: string, revision: 'initial' | 'corrected'): void {
  writeNote(vaultPath, {
    path: SOURCE_PATH,
    frontmatter: {
      status: 'aktiv',
      tags: ['auto-capture', 'prozedur', 'kunde/schule'],
      quelle: 'knowledge-harvester',
      source_stage: 'stop_capture',
      kunde: 'Schule',
      session_intent: 'implementation',
      intent_confidence: 'high',
      evidence_quality: 'high',
    },
    title: 'DHCP Late Correction Capture',
    body: digest(revision),
  })
}

function manifestRun(vaultPath: string): ManifestRun {
  const manifest = JSON.parse(readFileSync(join(vaultPath, '.brain-auto-build-manifest.json'), 'utf-8')) as {
    sources: Record<string, ManifestRun>
  }
  return manifest.sources[SOURCE_PATH]
}

describe('brain auto-build incremental correction lineage', () => {
  let vaultPath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeCapture(vaultPath, 'initial')
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('archives every previous derived artifact before promoting a contradictory late correction', async () => {
    const first = vault.brainAutoBuild({
      sourcePath: SOURCE_PATH,
      client: 'Schule',
      dryRun: false,
    })
    assert.ok(first.steps.some(step => step.step === 'generate_runbook' && step.applied))

    const initialRun = manifestRun(vaultPath)
    const initialArtifacts = [...initialRun.artifacts].sort()
    assert.ok(initialArtifacts.length >= 6)
    assert.ok(initialArtifacts.every(path => existsSync(join(vaultPath, path))))

    writeCapture(vaultPath, 'corrected')
    vault.shutdown()
    vault = new Vault(vaultPath)
    await vault.init()

    const second = vault.brainAutoBuild({
      sourcePath: SOURCE_PATH,
      client: 'Schule',
      dryRun: false,
    })

    const supersedeStep = second.steps.find(step => step.step === 'supersede_previous_run')
    assert.equal(supersedeStep?.applied, true)
    assert.equal(supersedeStep?.skipped, false)

    const correctedRun = manifestRun(vaultPath)
    assert.notEqual(correctedRun.hash, initialRun.hash)
    assert.equal(correctedRun.previousRuns?.length, 1)
    const previous = correctedRun.previousRuns![0]
    assert.equal(previous.hash, initialRun.hash)
    assert.ok(previous.archivedAt)
    assert.ok(previous.supersededAt)
    assert.equal(previous.supersededByHash, correctedRun.hash)
    assert.match(previous.archiveFolder ?? '', /^Archiv\/Auto-Build\/Superseded\//)
    assert.deepEqual([...previous.artifacts].sort(), initialArtifacts)

    const archived = previous.archivedArtifacts ?? []
    const skipped = previous.archiveSkipped ?? []
    const fullyAccounted = [
      ...archived.map(item => item.from),
      ...skipped.map(item => item.path),
    ].sort()
    assert.deepEqual(fullyAccounted, initialArtifacts)
    assert.equal(skipped.length, 0)
    assert.ok(archived.every(item => item.to.startsWith(`${previous.archiveFolder}/`)))
    assert.ok(archived.every(item => existsSync(join(vaultPath, item.to))))

    const archivedContent = archived
      .map(item => readFileSync(join(vaultPath, item.to), 'utf-8'))
      .join('\n')
    assert.match(archivedContent, /DHCP bleibt verbindlich auf dem Linuxmuster-Server/)

    assert.ok(correctedRun.artifacts.length >= 6)
    assert.ok(correctedRun.artifacts.every(path => existsSync(join(vaultPath, path))))
    const activeContent = correctedRun.artifacts
      .map(path => readFileSync(join(vaultPath, path), 'utf-8'))
      .join('\n')
    assert.match(activeContent, /DHCP wird verbindlich auf der Firewall betrieben/)
    assert.doesNotMatch(activeContent, /DHCP bleibt verbindlich auf dem Linuxmuster-Server/)
    assert.doesNotMatch(activeContent, /Linuxmuster-DHCP aktiviert/)

    const oldClaimPaths = initialArtifacts
      .filter(path => path.startsWith('Knowledge/Claims/'))
      .filter(path => !correctedRun.artifacts.includes(path))
    assert.ok(oldClaimPaths.length > 0)
    assert.ok(oldClaimPaths.every(path => !existsSync(join(vaultPath, path))))

    const actionLog = readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8')
    assert.match(actionLog, /brain_auto_build_supersede/)
    assert.match(actionLog, new RegExp(initialRun.hash))
    assert.match(actionLog, new RegExp(correctedRun.hash))
  })

  test('preflights ownership for the complete correction transaction before moving the first artifact', async () => {
    vault.brainAutoBuild({
      sourcePath: SOURCE_PATH,
      client: 'Schule',
      dryRun: false,
    })
    const initialRun = manifestRun(vaultPath)
    const initialArtifacts = [...initialRun.artifacts]

    const foreignPath = 'Knowledge/Insights/User Owned.md'
    writeNote(vaultPath, {
      path: foreignPath,
      frontmatter: { status: 'aktiv', quelle: 'manual' },
      title: 'User Owned',
      body: 'Diese Notiz darf durch ein manipuliertes Manifest nicht verschoben werden.',
    })
    const manifestPath = join(vaultPath, '.brain-auto-build-manifest.json')
    const tamperedManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      sources: Record<string, ManifestRun>
    }
    tamperedManifest.sources[SOURCE_PATH].artifacts.push(foreignPath)
    const committedManifest = `${JSON.stringify(tamperedManifest, null, 2)}\n`
    writeFileSync(manifestPath, committedManifest, 'utf-8')
    writeCapture(vaultPath, 'corrected')

    vault.shutdown()
    vault = new Vault(vaultPath)
    await vault.init()

    assert.throws(
      () => vault.brainAutoBuild({
        sourcePath: SOURCE_PATH,
        client: 'Schule',
        dryRun: false,
      }),
      /kann der Quelle nicht sicher zugeordnet werden/,
    )

    assert.ok(initialArtifacts.every(path => existsSync(join(vaultPath, path))))
    assert.ok(existsSync(join(vaultPath, foreignPath)))
    assert.equal(readFileSync(manifestPath, 'utf-8'), committedManifest)
    assert.ok(!existsSync(join(vaultPath, 'Archiv', 'Auto-Build', 'Superseded')))
  })
})
