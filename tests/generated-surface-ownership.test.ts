import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

interface FixedSurface {
  path: string
  owner: string
  run: (dryRun: boolean) => { dryRun: boolean; content: string }
}

describe('fixed generated surface ownership', () => {
  let vaultPath: string
  let vault: Vault
  let surfaces: FixedSurface[]

  beforeEach(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Technik/Netzwerk/DHCP.md',
      frontmatter: { status: 'aktiv', tags: ['dhcp'] },
      title: 'DHCP',
      body: 'DHCP laeuft auf der Firewall.',
    })
    writeNote(vaultPath, {
      path: 'Technik/Netzwerk/DNS.md',
      frontmatter: { status: 'aktiv', tags: ['dns'] },
      title: 'DNS',
      body: 'DNS laeuft ebenfalls auf der Firewall.',
    })
    writeNote(vaultPath, {
      path: 'Kunden/Acme/Captures/Session.md',
      frontmatter: { status: 'aktiv', tags: ['auto-capture', 'prozedur'], quelle: 'knowledge-harvester' },
      title: 'Acme Session',
      body: '## Durchgeführte Befehle\n\n1. `systemctl restart dhcpd`',
    })

    vault = new Vault(vaultPath)
    await vault.init()
    surfaces = [
      {
        path: 'Knowledge/index.md',
        owner: 'knowledge-index',
        run: dryRun => vault.buildKnowledgeIndex({ dryRun }),
      },
      {
        path: 'Knowledge/hot.md',
        owner: 'hot-cache',
        run: dryRun => vault.updateHotCache({ query: 'dhcp', dryRun }),
      },
      {
        path: 'Maintenance/Knowledge Inbox.md',
        owner: 'knowledge-inbox',
        run: dryRun => vault.buildKnowledgeInbox({ dryRun }),
      },
      {
        path: 'Maintenance/Change Ledger.md',
        owner: 'change-ledger',
        run: dryRun => vault.buildChangeLedger({ dryRun }),
      },
      {
        path: 'Knowledge/_brain.md',
        owner: 'brain-dashboard',
        run: dryRun => vault.buildBrainDashboard({ dryRun }),
      },
      {
        path: 'Kunden/Acme/_snapshot.md',
        owner: 'customer-snapshot',
        run: dryRun => vault.buildCustomerSnapshot({ client: 'Acme', dryRun }),
      },
      {
        path: 'Kunden/Acme/_timeline.md',
        owner: 'memory-timeline',
        run: dryRun => vault.buildMemoryTimeline({ client: 'Acme', dryRun }),
      },
      {
        path: 'Knowledge/Runbooks/Runbook Acme.md',
        owner: 'runbook-generator',
        run: dryRun => vault.generateRunbook('Acme', { outputFolder: 'Knowledge/Runbooks', dryRun }),
      },
      {
        path: 'Technik/Netzwerk/_MOC.md',
        owner: 'moc-generator',
        run: dryRun => ({ dryRun, content: JSON.stringify(vault.generateMocs(dryRun, 2)) }),
      },
    ]
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('dry-runs leave user files untouched and apply refuses to overwrite them', () => {
    for (const surface of surfaces) {
      const userContent = `# User maintained ${surface.path}\n\nDo not replace.\n`
      writeNote(vaultPath, { path: surface.path, body: userContent })
      const fullPath = join(vaultPath, surface.path)

      const preview = surface.run(true)
      assert.equal(preview.dryRun, true, surface.path)
      assert.equal(readFileSync(fullPath, 'utf-8'), userContent, surface.path)

      assert.throws(
        () => surface.run(false),
        new RegExp(`nicht von ${surface.owner} generiert`),
        surface.path,
      )
      assert.equal(readFileSync(fullPath, 'utf-8'), userContent, surface.path)
    }

    assert.equal(existsSync(join(vaultPath, '.action-log.jsonl')), false)
  })

  test('each generator marks and may refresh only its own surface', () => {
    for (const surface of surfaces) {
      writeNote(vaultPath, {
        path: surface.path,
        frontmatter: { quelle: surface.owner },
        title: 'Stale generated surface',
      })

      const applied = surface.run(false)
      assert.equal(applied.dryRun, false, surface.path)
      const content = readFileSync(join(vaultPath, surface.path), 'utf-8')
      assert.match(content, new RegExp(`^quelle: ${surface.owner}$`, 'm'), surface.path)
      assert.doesNotThrow(() => surface.run(false), surface.path)
    }
  })

  test('repairs all core fixed surfaces dry-run-first', () => {
    const preview = vault.repairGeneratedSurfaces()
    assert.equal(preview.dryRun, true)
    assert.equal(preview.repaired, 0)
    assert.equal(preview.surfaces.length, 7)
    assert.ok(!existsSync(join(vaultPath, 'Knowledge', '_brain.md')))

    const applied = vault.repairGeneratedSurfaces({ dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.equal(applied.repaired, 7)
    for (const surface of applied.surfaces) assert.ok(existsSync(join(vaultPath, surface.path)), surface.path)
  })

  test('repair preflights every surface before its first write', () => {
    writeNote(vaultPath, {
      path: 'Maintenance/Change Ledger.md',
      frontmatter: { quelle: 'user' },
      title: 'Personal Ledger',
      body: 'Never replace.',
    })

    assert.throws(
      () => vault.repairGeneratedSurfaces({ dryRun: false }),
      /nicht von change-ledger generiert/,
    )
    assert.ok(!existsSync(join(vaultPath, 'Knowledge', '_brain.md')))
    assert.ok(!existsSync(join(vaultPath, '.action-log.jsonl')))
  })

  test('recognizes legacy generator output but adopts it only with explicit opt-in', () => {
    writeNote(vaultPath, {
      path: 'Knowledge/index.md',
      frontmatter: { status: 'aktiv', tags: ['knowledge-index'] },
      title: 'Knowledge Index',
      body: '## Bereiche\n\n- Knowledge: 2 Notizen',
    })
    writeNote(vaultPath, {
      path: 'Knowledge/hot.md',
      frontmatter: { status: 'aktiv', tags: ['hot-cache', 'manual-only'] },
      title: 'Hot Cache: Legacy',
      body: 'Manuell aktualisierter Arbeitskontext. Diese Datei wird nicht automatisch in Sessions injiziert.\n\n## Relevante Notizen',
    })

    const health = vault.brainHealthCheck({ checkHooks: false })
    assert.equal(health.checks.find(check => check.id === 'knowledge_index')?.status, 'warn')
    assert.equal(health.checks.find(check => check.id === 'hot_cache')?.status, 'warn')
    assert.throws(
      () => vault.repairGeneratedSurfaces({ dryRun: false }),
      /nicht von knowledge-index generiert/,
    )
    assert.equal(existsSync(join(vaultPath, '.action-log.jsonl')), false)

    const preview = vault.repairGeneratedSurfaces({ adoptLegacy: true })
    assert.equal(preview.dryRun, true)
    assert.deepEqual(preview.recognizedLegacy.sort(), ['Knowledge/hot.md', 'Knowledge/index.md'])
    assert.doesNotMatch(readFileSync(join(vaultPath, 'Knowledge/index.md'), 'utf-8'), /quelle:/)

    const applied = vault.repairGeneratedSurfaces({ dryRun: false, adoptLegacy: true })
    assert.equal(applied.adoptLegacy, true)
    assert.match(readFileSync(join(vaultPath, 'Knowledge/index.md'), 'utf-8'), /^quelle: knowledge-index$/m)
    assert.match(readFileSync(join(vaultPath, 'Knowledge/hot.md'), 'utf-8'), /^quelle: hot-cache$/m)
  })
})
