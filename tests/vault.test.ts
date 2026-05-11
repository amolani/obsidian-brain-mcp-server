// Tests for vault.ts — core Vault class

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync, utimesSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { createTempVault, cleanupVault, writeNote } from './helpers.ts'

describe('Vault: indexing', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Note1.md',
      frontmatter: { status: 'aktiv', tags: ['test', 'foo'], datum: '2026-04-18' },
      title: 'Test Note 1',
      body: 'Content with [[Note2]] link.',
    })
    writeNote(vaultPath, {
      path: 'sub/Note2.md',
      frontmatter: { status: 'aktiv', tags: ['test'] },
      title: 'Test Note 2',
      body: 'Second note.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('indexes all .md files', () => {
    const stats = vault.getOverview()
    assert.equal(stats.totalNotes, 2)
  })

  test('extracts title from H1', () => {
    const ctx = vault.getNoteContext('Note1.md')
    assert.ok(ctx)
    assert.equal(ctx.frontmatter.status, 'aktiv')
  })

  test('parses frontmatter tags', () => {
    const ctx = vault.getNoteContext('Note1.md')
    assert.ok(ctx)
    assert.deepEqual(ctx.frontmatter.tags, ['test', 'foo'])
  })

  test('builds backlink index', () => {
    const ctx = vault.getNoteContext('Note2')
    assert.ok(ctx)
    assert.equal(ctx.backlinks.length, 1)
    assert.equal(ctx.backlinks[0].path, 'Note1.md')
  })
})

describe('Vault: link resolution', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, { path: 'Kunden/A/Note.md', title: 'Target' })
    writeNote(vaultPath, {
      path: 'Dashboard.md',
      body: [
        '[[Note]]',                            // by filename
        '[[Kunden/A/Note]]',                   // full path
        '[[Kunden/A/Note|Alias]]',             // alias
        '[[Kunden/A/Note\\|EscAlias]]',        // table-escaped pipe
      ].join('\n'),
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('resolves all 4 link styles to same target', () => {
    const ctx = vault.getNoteContext('Kunden/A/Note.md')
    assert.ok(ctx)
    assert.equal(ctx.backlinks.length, 1)
    assert.equal(ctx.backlinks[0].path, 'Dashboard.md')
  })
})

describe('Vault: search', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Referenz/Docker.md',
      frontmatter: { status: 'aktiv', tags: ['docker', 'container'] },
      title: 'Docker',
      body: 'About docker and containers.',
    })
    writeNote(vaultPath, {
      path: 'Kunden/X/Docs.md',
      frontmatter: { status: 'aktiv', tags: ['kunde/x'] },
      title: 'X Docs',
      body: 'Customer docs mentioning docker once. See [[Technik/Docker/Traefik]] for edge routing.\n\n- [ ] Validate TLS renewal.',
    })
    writeNote(vaultPath, {
      path: 'Referenz/Git.md',
      frontmatter: { status: 'planung', tags: ['git'] },
      title: 'Git Notes',
      body: 'Git commands.',
    })
    writeNote(vaultPath, {
      path: 'Technik/Docker/Traefik.md',
      frontmatter: { status: 'aktiv', tags: ['docker', 'reverse-proxy', 'tls'] },
      title: 'Traefik Edge Router',
      body: [
        '## Reverse Proxy',
        'Traefik routes container workloads, terminates TLS certificates and exposes services from docker compose stacks.',
      ].join('\n'),
    })
    writeNote(vaultPath, {
      path: 'Archiv/Old Docker.md',
      frontmatter: { status: 'archiviert', tags: ['docker', 'reverse-proxy'] },
      title: 'Old Docker Proxy',
      body: 'Historic reverse proxy setup.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('full-text search ranks by relevance', () => {
    const results = vault.search({ query: 'docker' })
    assert.ok(results.length >= 2)
    // Docker.md has docker in title AND tags AND content → higher score
    assert.equal(results[0].path, 'Referenz/Docker.md')
  })

  test('folder filter', () => {
    const results = vault.search({ folder: 'Kunden' })
    assert.equal(results.length, 1)
    assert.equal(results[0].path, 'Kunden/X/Docs.md')
  })

  test('status filter', () => {
    const results = vault.search({ status: 'planung' })
    assert.equal(results.length, 1)
    assert.equal(results[0].path, 'Referenz/Git.md')
  })

  test('tag filter matches ALL tags (AND)', () => {
    const resBoth = vault.search({ tags: ['docker', 'container'] })
    assert.equal(resBoth.length, 1)

    const resNone = vault.search({ tags: ['docker', 'nonexistent'] })
    assert.equal(resNone.length, 0)
  })

  test('combined filters', () => {
    const results = vault.search({ folder: 'Referenz', status: 'aktiv' })
    assert.equal(results.length, 1)
    assert.equal(results[0].path, 'Referenz/Docker.md')
  })

  test('semantic_search ranks conceptually related notes with snippets', () => {
    const results = vault.semanticSearch({ query: 'container reverse proxy tls routing', limit: 3 })
    assert.ok(results.length > 0)
    assert.equal(results[0].path, 'Technik/Docker/Traefik.md')
    assert.ok(results[0].score >= 30)
    assert.match(results[0].snippet, /Traefik routes container workloads/i)
    assert.ok(results[0].matchedTerms.includes('traefik'))
  })

  test('semantic_search honors filters and skips archive by default', () => {
    const filtered = vault.semanticSearch({ query: 'docker proxy', folder: 'Technik/', tags: ['reverse-proxy'] })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].path, 'Technik/Docker/Traefik.md')

    const withoutArchive = vault.semanticSearch({ query: 'historic reverse proxy setup', minScore: 1 })
    assert.ok(!withoutArchive.some(r => r.path.startsWith('Archiv/')))

    const withArchive = vault.semanticSearch({ query: 'historic reverse proxy setup', minScore: 1, includeArchived: true })
    assert.ok(withArchive.some(r => r.path === 'Archiv/Old Docker.md'))
  })

  test('build_context_pack gathers semantic hits, linked notes, todos, and citations', () => {
    const pack = vault.buildContextPack({ query: 'customer docker tls routing', maxNotes: 4 })
    const notes = [...pack.primary, ...pack.linked]
    assert.equal(pack.query, 'customer docker tls routing')
    assert.ok(pack.primary.some(note => note.path === 'Technik/Docker/Traefik.md'))
    assert.ok(notes.some(note => note.path === 'Kunden/X/Docs.md'))
    assert.ok(pack.openTodos.some(todo => todo.path === 'Kunden/X/Docs.md' && todo.text.includes('TLS renewal')))
    assert.ok(pack.citations.includes('Technik/Docker/Traefik.md'))
    assert.ok(pack.suggestedNextActions.length > 0)
  })

  test('build_context_pack can disable linked expansion', () => {
    const pack = vault.buildContextPack({ query: 'container reverse proxy tls routing', includeLinked: false })
    assert.equal(pack.linked.length, 0)
    assert.ok(pack.primary.length > 0)
  })

  test('recall_context is manual read-only context recall', () => {
    const before = vault.getOverview().totalNotes
    const pack = vault.recallContext({ query: 'customer docker tls routing', maxNotes: 3 })

    assert.equal(pack.query, 'customer docker tls routing')
    assert.ok(pack.primary.length > 0)
    assert.ok(pack.citations.includes('Technik/Docker/Traefik.md'))
    assert.equal(vault.getOverview().totalNotes, before)
  })

  test('semantic index reports drift and can be rebuilt', () => {
    const before = vault.semanticIndexStatus()
    assert.equal(before.exists, false)
    assert.equal(before.totalNotes, 4)
    assert.ok(before.missingNotes.includes('Technik/Docker/Traefik.md'))

    const dryRun = vault.rebuildSemanticIndex({ dryRun: true })
    assert.equal(dryRun.dryRun, true)
    assert.equal(dryRun.indexedNotes, 4)
    assert.ok(!existsSync(join(vaultPath, '.semantic-index.json')))

    const applied = vault.rebuildSemanticIndex({ dryRun: false })
    assert.equal(applied.dryRun, false)
    assert.ok(existsSync(join(vaultPath, '.semantic-index.json')))

    const after = vault.semanticIndexStatus()
    assert.equal(after.exists, true)
    assert.equal(after.freshNotes, after.totalNotes)
    assert.equal(after.staleNotes.length, 0)

    const indexedResults = vault.semanticSearch({ query: 'container reverse proxy tls routing', limit: 1 })
    assert.equal(indexedResults[0].path, 'Technik/Docker/Traefik.md')

    const notePath = join(vaultPath, 'Technik/Docker/Traefik.md')
    writeFileSync(notePath, `${readFileSync(notePath, 'utf-8')}\n\nAdditional routing note.`, 'utf-8')
    vault.indexNote(notePath, statSync(notePath).mtimeMs)
    const stale = vault.semanticIndexStatus()
    assert.ok(stale.staleNotes.includes('Technik/Docker/Traefik.md'))
  })
})

describe('Vault: create_note templates', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('kunde template creates under Kunden/{title}/', () => {
    const { path } = vault.createNote('TestKunde', 'kunde')
    assert.equal(path, 'Kunden/TestKunde/TestKunde.md')
    assert.ok(existsSync(join(vaultPath, path)))
  })

  test('referenz template creates under Referenz/', () => {
    const { path } = vault.createNote('TestRef', 'referenz')
    assert.ok(path.startsWith('Referenz/'))
  })

  test('daily template uses date as filename', () => {
    const { path } = vault.createNote('ignored', 'daily')
    const today = new Date().toISOString().split('T')[0]
    assert.ok(path.endsWith(`${today}.md`))
  })

  test('unknown template throws', () => {
    assert.throws(() => vault.createNote('X', 'unknown'), /Unknown template/)
  })
})

describe('Vault: capture auto-categorization', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('detects known client from content', () => {
    const result = vault.capture('Merian: DHCP-Scope festlegen für das VLAN')
    assert.equal(result.folder, 'Kunden/Merian')
    assert.ok(result.tags.includes('kunde/merian'))
  })

  test('auto-tags technical terms', () => {
    const result = vault.capture('Docker compose setup with nginx reverse proxy')
    assert.ok(result.tags.includes('docker'))
    assert.ok(result.tags.includes('nginx'))
  })

  test('capture_v2 routes technical captures into Technik subcategories', () => {
    const result = vault.captureV2('Docker compose setup with nginx reverse proxy')
    assert.equal(result.folder, 'Technik/Docker/Compose')
    assert.ok(result.tags.includes('docker'))
    assert.ok(result.tags.includes('docker/compose'))
    assert.equal(result.dryRun, false)
    assert.ok(existsSync(join(vaultPath, result.path)))
  })

  test('capture_v2 dry-run previews without writing', () => {
    const result = vault.captureV2('OPNsense VLAN Setup\n\nDetailed instructions here.', { dryRun: true })
    assert.equal(result.folder, 'Technik/Netzwerk/OPNsense')
    assert.equal(result.dryRun, true)
    assert.equal(result.wouldWrite, false)
    assert.ok(!existsSync(join(vaultPath, result.path)))
  })

  test('capture_v2 review mode defaults to dry-run', () => {
    const result = vault.captureV2('Linuxmuster Linbo start.conf debug procedure', { mode: 'review' })
    assert.equal(result.dryRun, true)
    assert.equal(result.reviewRequired, true)
  })

  test('capture_v2 normalizes tag aliases on write', () => {
    const result = vault.captureV2('Windows GPO gpupdate Konfiguration')
    assert.ok(result.tags.includes('group-policy'))
    assert.ok(!result.tags.includes('gpo'))
  })

  test('capture_v2 keeps repeated titles by creating unique paths', () => {
    const first = vault.captureV2('Unique Entry\n\nFirst body.')
    const second = vault.captureV2('Unique Entry\n\nSecond body.')
    assert.equal(first.path, 'Inbox/Unique Entry.md')
    assert.equal(second.path, 'Inbox/Unique Entry (2).md')
    assert.ok(existsSync(join(vaultPath, first.path)))
    assert.ok(existsSync(join(vaultPath, second.path)))
  })

  test('security keywords → Sicherheit folder', () => {
    const result = vault.capture('Sicherheitsbefund: offene Schwachstelle in Service X mit CVE-2024-1234')
    assert.equal(result.folder, 'Sicherheit')
  })

  test('unknown → Inbox fallback', () => {
    const result = vault.capture('Random thought about nothing specific here')
    assert.equal(result.folder, 'Inbox')
  })

  test('does NOT duplicate title in body', () => {
    const result = vault.capture('OPNsense VLAN Setup\n\nDetailed instructions here.')
    const content = readFileSync(join(vaultPath, result.path), 'utf-8')
    // Title should appear exactly once as H1
    const h1Count = (content.match(/^# OPNsense VLAN Setup/m) || []).length
    assert.equal(h1Count, 1)
  })
})

describe('Vault: todos', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'A.md',
      body: '- [ ] Task 1\n- [x] Done task\n- [ ] Task 2\n',
    })
    writeNote(vaultPath, {
      path: 'B.md',
      body: 'No todos here',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('extracts open todos only', () => {
    const items = vault.getTodoList()
    assert.equal(items.length, 1)
    assert.equal(items[0].file, 'A.md')
    assert.equal(items[0].todos.length, 2) // 2 open, 1 done excluded
  })

  test('folder filter', () => {
    const items = vault.getTodoList('NotExisting')
    assert.equal(items.length, 0)
  })
})

describe('Vault: orphan detection', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, { path: 'Dashboard.md', body: '[[Linked]]' })
    writeNote(vaultPath, { path: 'Linked.md', title: 'Linked Note' })
    writeNote(vaultPath, { path: 'Orphan.md', title: 'Orphan Note' })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('identifies notes without incoming links', () => {
    const stats = vault.getOverview()
    const orphanPaths = stats.orphanNotes.map(o => o.path)
    assert.ok(orphanPaths.includes('Orphan.md'))
    assert.ok(!orphanPaths.includes('Linked.md'))
  })
})

describe('Vault: note quality', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Dashboard.md',
      title: 'Dashboard',
      body: '[[Technik/Docker/Gute Docker Anleitung]]\n',
    })
    writeNote(vaultPath, {
      path: 'Technik/Docker/Gute Docker Anleitung.md',
      frontmatter: { status: 'aktiv', tags: ['docker', 'compose'], datum: '2026-04-18' },
      title: 'Gute Docker Anleitung',
      body: [
        '## Ziel',
        'Diese Anleitung beschreibt den sauberen Betrieb eines Docker Compose Stacks mit Reverse Proxy.',
        '',
        '## Vorgehen',
        '1. Compose-Datei prüfen.',
        '2. Netzwerk und Volumes anlegen.',
        '3. Stack starten und Logs prüfen.',
        '',
        'Siehe auch [[Dashboard]].',
      ].join('\n'),
    })
    writeNote(vaultPath, {
      path: 'Inbox/Untitled.md',
      title: 'Untitled',
      body: [
        '```bash',
        'docker ps',
        'docker logs app',
        '```',
        '',
        '```bash',
        'docker restart app',
        '```',
      ].join('\n'),
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('scores structured notes higher than dump notes', () => {
    const good = vault.scoreNoteQuality('Technik/Docker/Gute Docker Anleitung.md')
    const bad = vault.scoreNoteQuality('Inbox/Untitled.md')
    assert.ok(good)
    assert.ok(bad)
    assert.ok(good.score > bad.score)
    assert.equal(bad.grade, 'poor')
  })

  test('lists low quality notes under threshold', () => {
    const low = vault.listLowQualityNotes(69)
    assert.ok(low.some(n => n.path === 'Inbox/Untitled.md'))
    assert.ok(!low.some(n => n.path === 'Technik/Docker/Gute Docker Anleitung.md'))
  })

  test('maintenance report includes quality summary', () => {
    const report = vault.runMaintenance()
    assert.ok(report.quality.total >= 2)
    assert.ok(report.quality.averageScore > 0)
  })
})

describe('Vault: lifecycle automation', () => {
  let vaultPath: string
  let vault: Vault

  function ageNote(path: string, days: number): void {
    const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    utimesSync(join(vaultPath, path), date, date)
  }

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Technik/Old Active.md',
      frontmatter: { status: 'aktiv', tags: ['docker'], datum: '2024-01-01' },
      title: 'Old Active',
      body: 'A stable reference note without open work.',
    })
    ageNote('Technik/Old Active.md', 420)

    writeNote(vaultPath, {
      path: 'Technik/Old With Todo.md',
      frontmatter: { status: 'aktiv', tags: ['docker'], datum: '2024-01-01' },
      title: 'Old With Todo',
      body: '- [ ] Validate current production state before archiving.',
    })
    ageNote('Technik/Old With Todo.md', 420)

    writeNote(vaultPath, {
      path: 'Inbox/Missing Status.md',
      frontmatter: { tags: ['linuxmuster'], datum: '2026-01-01' },
      title: 'Missing Status',
      body: 'Structured note with enough context for active status.',
    })

    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('suggests status updates without changing files', () => {
    const suggestions = vault.suggestLifecycleUpdates()
    const archive = suggestions.find(s => s.path === 'Technik/Old Active.md')
    const active = suggestions.find(s => s.path === 'Inbox/Missing Status.md')
    const blocked = suggestions.find(s => s.path === 'Technik/Old With Todo.md')
    assert.ok(archive)
    assert.equal(archive.recommendedStatus, 'archiviert')
    assert.ok(active)
    assert.equal(active.recommendedStatus, 'aktiv')
    assert.ok(blocked)
    assert.deepEqual(blocked.blockedBy, ['open_todos'])
  })

  test('dry-run previews lifecycle updates only', () => {
    const result = vault.applyLifecycleUpdates({ dryRun: true })
    assert.equal(result.dryRun, true)
    assert.ok(result.updated.some(u => u.path === 'Technik/Old Active.md' && u.afterStatus === 'archiviert'))
    const raw = readFileSync(join(vaultPath, 'Technik/Old Active.md'), 'utf-8')
    assert.match(raw, /status: aktiv/)
  })

  test('apply updates frontmatter and indexes note', () => {
    const result = vault.applyLifecycleUpdates({
      dryRun: false,
      paths: ['Technik/Old Active.md', 'Inbox/Missing Status.md'],
    })
    assert.equal(result.updated.length, 2)
    const old = vault.getNoteContext('Technik/Old Active.md')
    const missing = vault.getNoteContext('Inbox/Missing Status.md')
    assert.ok(old)
    assert.ok(missing)
    assert.equal(old.frontmatter.status, 'archiviert')
    assert.equal(missing.frontmatter.status, 'aktiv')
    assert.equal(typeof old.frontmatter.lifecycle_reviewed, 'string')
  })
})

describe('Vault: safe maintenance', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Target/Magic.md',
      frontmatter: { status: 'aktiv', tags: ['links'], aliases: ['magic target'] },
      title: 'Magic Target',
      body: 'Target note.',
    })
    writeNote(vaultPath, {
      path: 'Source.md',
      frontmatter: { tags: ['links'] },
      title: 'Source',
      body: 'This mentions magic target plainly.',
    })
    writeNote(vaultPath, {
      path: 'new-folder/MovedNote.md',
      frontmatter: { status: 'aktiv', tags: ['links'] },
      title: 'MovedNote',
      body: 'Moved note.',
    })
    writeNote(vaultPath, {
      path: 'Dashboard.md',
      frontmatter: { status: 'aktiv', tags: ['dashboard'] },
      title: 'Dashboard',
      body: 'Broken: [[old-path/MovedNote]]',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('runSafeMaintenance dry-run previews without modifying files', () => {
    const sourceBefore = readFileSync(join(vaultPath, 'Source.md'), 'utf-8')
    const dashboardBefore = readFileSync(join(vaultPath, 'Dashboard.md'), 'utf-8')
    const result = vault.runSafeMaintenance({
      dryRun: true,
      steps: ['frontmatter', 'broken_links', 'link_suggestions', 'semantic_index'],
      minLinkConfidence: 0.85,
    })
    assert.equal(result.dryRun, true)
    assert.ok(result.steps.some(step => step.step === 'frontmatter' && step.changed > 0))
    assert.ok(result.steps.some(step => step.step === 'broken_links' && step.changed > 0))
    assert.ok(result.steps.some(step => step.step === 'link_suggestions' && step.changed > 0))
    assert.ok(result.steps.some(step => step.step === 'semantic_index' && step.changed > 0))
    assert.equal(readFileSync(join(vaultPath, 'Source.md'), 'utf-8'), sourceBefore)
    assert.equal(readFileSync(join(vaultPath, 'Dashboard.md'), 'utf-8'), dashboardBefore)
    assert.ok(!existsSync(join(vaultPath, '.semantic-index.json')))
  })

  test('runSafeMaintenance applies selected safe steps', () => {
    const result = vault.runSafeMaintenance({
      dryRun: false,
      steps: ['frontmatter', 'broken_links', 'link_suggestions', 'semantic_index'],
      minLinkConfidence: 0.85,
    })
    assert.equal(result.dryRun, false)
    assert.ok(result.totalChanged > 0)
    const source = readFileSync(join(vaultPath, 'Source.md'), 'utf-8')
    const dashboard = readFileSync(join(vaultPath, 'Dashboard.md'), 'utf-8')
    assert.match(source, /status: aktiv/)
    assert.match(source, /\[\[Target\/Magic\|magic target\]\]/)
    assert.match(dashboard, /\[\[new-folder\/MovedNote\]\]/)
    assert.ok(existsSync(join(vaultPath, '.semantic-index.json')))
  })
})

describe('Vault: suggest_links_v2', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Technik/Docker/Compose.md',
      frontmatter: { status: 'aktiv', tags: ['docker'], aliases: ['docker compose'] },
      title: 'Docker Compose',
      body: 'Compose reference.',
    })
    writeNote(vaultPath, {
      path: 'Technik/Docker/Traefik.md',
      frontmatter: { status: 'aktiv', tags: ['docker', 'reverse-proxy'] },
      title: 'Traefik',
      body: 'Traefik reference.',
    })
    writeNote(vaultPath, {
      path: 'Technik/Docker/Nginx.md',
      frontmatter: { status: 'aktiv', tags: ['docker', 'reverse-proxy'] },
      title: 'Nginx',
      body: 'Nginx reference.',
    })
    writeNote(vaultPath, {
      path: 'Kunden/Test/Projekt.md',
      frontmatter: { status: 'aktiv', tags: ['docker'] },
      title: 'Projekt',
      body: 'Wir nutzen docker compose mit Traefik und Nginx im Stack.',
    })
    writeNote(vaultPath, {
      path: 'Kunden/Test/Bereits-verlinkt.md',
      frontmatter: { status: 'aktiv', tags: ['docker'] },
      title: 'Bereits verlinkt',
      body: 'Wir nutzen [[Technik/Docker/Compose|docker compose]] bereits.',
    })
    writeNote(vaultPath, {
      path: 'Kunden/Test/Codeblock.md',
      frontmatter: { status: 'aktiv', tags: ['docker'] },
      title: 'Codeblock',
      body: [
        '```text',
        'docker compose darf im Codeblock nicht verlinkt werden.',
        '```',
      ].join('\n'),
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('returns confidence scored suggestions with snippets', () => {
    const suggestions = vault.suggestLinksV2({ minConfidence: 0.5 })
    const compose = suggestions.find(s => s.source === 'Kunden/Test/Projekt.md' && s.target === 'Technik/Docker/Compose.md')
    assert.ok(compose)
    assert.ok(compose.confidence >= 0.8)
    assert.ok(compose.reasons.includes('alias'))
    assert.match(compose.snippet, /docker compose/i)
  })

  test('skips already linked mentions', () => {
    const suggestions = vault.suggestLinksV2({ minConfidence: 0.5 })
    assert.ok(!suggestions.some(s => s.source === 'Kunden/Test/Bereits-verlinkt.md' && s.target === 'Technik/Docker/Compose.md'))
  })

  test('supports maxPerNote cap', () => {
    const suggestions = vault.suggestLinksV2({ minConfidence: 0.5, maxPerNote: 2 })
    const projectSuggestions = suggestions.filter(s => s.source === 'Kunden/Test/Projekt.md')
    assert.equal(projectSuggestions.length, 2)
  })

  test('supports minConfidence threshold', () => {
    const suggestions = vault.suggestLinksV2({ minConfidence: 0.95 })
    assert.ok(suggestions.every(s => s.confidence >= 0.95))
  })

  test('apply_link_suggestions dry-run previews without modifying files', () => {
    const before = readFileSync(join(vaultPath, 'Kunden/Test/Projekt.md'), 'utf-8')
    const result = vault.applyLinkSuggestions({
      dryRun: true,
      sources: ['Kunden/Test/Projekt.md'],
      minConfidence: 0.85,
    })
    assert.equal(result.dryRun, true)
    assert.ok(result.linked.some(link => link.target === 'Technik/Docker/Compose.md'))
    const after = readFileSync(join(vaultPath, 'Kunden/Test/Projekt.md'), 'utf-8')
    assert.equal(after, before)
  })

  test('apply_link_suggestions links plain mentions and updates index', () => {
    const result = vault.applyLinkSuggestions({
      dryRun: false,
      sources: ['Kunden/Test/Projekt.md'],
      minConfidence: 0.85,
      maxTotal: 1,
    })
    assert.equal(result.linked.length, 1)
    const raw = readFileSync(join(vaultPath, 'Kunden/Test/Projekt.md'), 'utf-8')
    assert.match(raw, /\[\[Technik\/Docker\/Compose\|docker compose\]\]/)
    const ctx = vault.getNoteContext('Technik/Docker/Compose.md')
    assert.ok(ctx)
    assert.ok(ctx.backlinks.some(link => link.path === 'Kunden/Test/Projekt.md'))
  })

  test('apply_link_suggestions skips code blocks', () => {
    const result = vault.applyLinkSuggestions({
      dryRun: false,
      sources: ['Kunden/Test/Codeblock.md'],
      minConfidence: 0.85,
    })
    assert.equal(result.linked.length, 0)
    assert.ok(result.skipped.some(skip => skip.reason.includes('nicht sicher ersetzbar')))
    const raw = readFileSync(join(vaultPath, 'Kunden/Test/Codeblock.md'), 'utf-8')
    assert.ok(!raw.includes('[[Technik/Docker/Compose|docker compose]]'))
  })
})

describe('Vault: customer dashboard', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/TestClient/Installationsplan.md',
      frontmatter: { status: 'aktiv', tags: ['linuxmuster', 'projekt'], datum: '2026-04-18' },
      title: 'Installationsplan',
      body: [
        '## Übersicht',
        'Installation mit bekanntem Problem bei DHCP.',
        '- [ ] Firewall-Regeln prüfen',
      ].join('\n'),
    })
    writeNote(vaultPath, {
      path: 'Kunden/TestClient/Runbook TestClient.md',
      frontmatter: { status: 'aktiv', tags: ['runbook', 'testclient'], datum: '2026-04-19' },
      title: 'Runbook TestClient',
      body: '## Schritte\n\n1. Setup durchführen.',
    })
    writeNote(vaultPath, {
      path: 'Kunden/TestClient/TestClient — linuxmuster Setup.md',
      frontmatter: { status: 'aktiv', tags: ['auto-capture', 'linuxmuster'], datum: '2026-04-20', quelle: 'knowledge-harvester' },
      title: 'TestClient — linuxmuster Setup',
      body: '## Fehler und Workarounds\n\nProblem wurde mit Workaround gelöst.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('dry-run previews dashboard without writing', () => {
    const result = vault.buildCustomerDashboard('TestClient', { dryRun: true })
    assert.equal(result.path, 'Kunden/TestClient/_dashboard.md')
    assert.equal(result.noteCount, 3)
    assert.equal(result.todoCount, 1)
    assert.equal(result.runbookCount, 1)
    assert.equal(result.captureCount, 1)
    assert.ok(result.content.includes('# TestClient Dashboard'))
    assert.ok(!existsSync(join(vaultPath, result.path)))
  })

  test('rejects unsafe customer names', () => {
    assert.throws(
      () => vault.buildCustomerDashboard('../Outside', { dryRun: true }),
      /Ungültiger Kundenname/
    )
  })

  test('does not overwrite a manual customer dashboard', () => {
    writeNote(vaultPath, {
      path: 'Kunden/ManualClient/_dashboard.md',
      frontmatter: { status: 'aktiv', tags: ['manual'] },
      title: 'Manual Dashboard',
      body: 'This file is maintained manually.',
    })
    assert.throws(
      () => vault.buildCustomerDashboard('ManualClient', { dryRun: false }),
      /nicht auto-generiert/
    )
  })

  test('apply writes and indexes dashboard', () => {
    const result = vault.buildCustomerDashboard('TestClient', { dryRun: false })
    assert.ok(existsSync(join(vaultPath, result.path)))
    const ctx = vault.getNoteContext(result.path)
    assert.ok(ctx)
    assert.equal(ctx.frontmatter.quelle, 'customer-dashboard')
  })
})

describe('Vault: organizeReferenz', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Referenz/Docker Stuff.md',
      frontmatter: { tags: ['docker'] },
      body: 'docker compose up',
    })
    writeNote(vaultPath, {
      path: 'Referenz/Random Thought.md',
      body: 'Something unclassifiable',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('dryRun does not move files', () => {
    const result = vault.organizeReferenz(true)
    assert.ok(result.dryRun)
    assert.ok(existsSync(join(vaultPath, 'Referenz/Docker Stuff.md')))
  })

  test('moves classifiable notes to Technik/', () => {
    const result = vault.organizeReferenz(false)
    assert.ok(result.moved.some(m => m.to.startsWith('Technik/Docker/')))
    assert.ok(existsSync(join(vaultPath, result.moved[0].to)))
    assert.ok(!existsSync(join(vaultPath, 'Referenz/Docker Stuff.md')))
  })

  test('skips unclassifiable notes', () => {
    const result = vault.organizeReferenz(false)
    assert.ok(result.skipped.some(s => s.path.includes('Random Thought')))
  })
})

describe('Vault: generate_mocs', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    // Kunden/Neckartenzlingen/ with 3 notes → should get MOC
    writeNote(vaultPath, { path: 'Kunden/Neckartenzlingen/A.md', title: 'A' })
    writeNote(vaultPath, { path: 'Kunden/Neckartenzlingen/B.md', title: 'B' })
    writeNote(vaultPath, { path: 'Kunden/Neckartenzlingen/C.md', title: 'C' })

    // Kunden/HUG/ with 1 note → skipped (minNotes=2)
    writeNote(vaultPath, { path: 'Kunden/HUG/Zugangsdaten.md', title: 'Z' })

    // Technik/Docker/Compose/ → 2 notes = MOC
    writeNote(vaultPath, { path: 'Technik/Docker/Compose/X.md', title: 'X' })
    writeNote(vaultPath, { path: 'Technik/Docker/Compose/Y.md', title: 'Y' })

    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('dry run creates no files', () => {
    const result = vault.generateMocs(true)
    assert.ok(result.length >= 1)
    assert.ok(!existsSync(join(vaultPath, 'Kunden/Neckartenzlingen/_MOC.md')))
  })

  test('creates MOC for folders with >= 2 notes', () => {
    const result = vault.generateMocs(false)
    const created = result.filter(r => r.action === 'created')
    assert.ok(created.length >= 2, 'Expected at least 2 created MOCs')
    assert.ok(existsSync(join(vaultPath, 'Kunden/Neckartenzlingen/_MOC.md')))
    assert.ok(existsSync(join(vaultPath, 'Technik/Docker/Compose/_MOC.md')))
  })

  test('skips folders with < minNotes', () => {
    const result = vault.generateMocs(false)
    const hug = result.find(r => r.path.includes('HUG'))
    if (hug) assert.equal(hug.action, 'skipped')
  })

  test('MOC contains dataview queries', () => {
    const content = readFileSync(join(vaultPath, 'Kunden/Neckartenzlingen/_MOC.md'), 'utf-8')
    assert.ok(content.includes('```dataview'))
    assert.ok(content.includes('FROM "Kunden/Neckartenzlingen"'))
    assert.ok(content.includes('TASK'))
  })

  test('respects quelle: moc-generator marker', () => {
    // Modify the existing MOC to add custom content and remove marker
    const mocPath = join(vaultPath, 'Kunden/Neckartenzlingen/_MOC.md')
    const modified = readFileSync(mocPath, 'utf-8').replace('quelle: moc-generator', 'quelle: manual')
    writeFileSync(mocPath, modified, 'utf-8')

    // Re-init vault to pick up changes
    vault.shutdown()
    vault = new Vault(vaultPath)
    return vault.init().then(() => {
      const result = vault.generateMocs(false)
      const entry = result.find(r => r.path === 'Kunden/Neckartenzlingen/_MOC.md')
      assert.equal(entry?.action, 'skipped')
      assert.ok(entry?.reason?.includes('nicht auto-generiert'))
    })
  })
})

describe('Vault: frontmatter linting', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    // Note with messy frontmatter
    writeNote(vaultPath, {
      path: 'MessyNote.md',
      frontmatter: {
        Status: 'aktiv',               // capital S - should be lowercase
        tags: ['LMN', 'proxmox', 'pve', 'proxmox'],  // alias + case + dupe
        datum: '14.04.2026',           // wrong format
      },
      title: 'Messy Note',
    })
    // Clean note (baseline)
    writeNote(vaultPath, {
      path: 'Clean.md',
      frontmatter: {
        status: 'aktiv',
        tags: ['docker'],
        datum: '2026-04-18',
      },
      title: 'Clean Note',
    })
    // Note without status (should get issue)
    writeNote(vaultPath, {
      path: 'NoStatus.md',
      frontmatter: { tags: ['test'] },
      title: 'No Status Note',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('detects missing status', () => {
    const issues = vault.lintFrontmatter()
    assert.ok(issues.some(i => i.path === 'NoStatus.md' && i.field === 'status'))
  })

  test('detects invalid date format', () => {
    const issues = vault.lintFrontmatter()
    assert.ok(issues.some(i => i.path === 'MessyNote.md' && i.field === 'datum'))
  })

  test('detects tag alias issues', () => {
    const issues = vault.lintFrontmatter()
    const tagIssues = issues.filter(i => i.path === 'MessyNote.md' && i.field === 'tags')
    assert.ok(tagIssues.length >= 1, 'Should flag LMN → linuxmuster')
  })

  test('detects lowercase field names', () => {
    const issues = vault.lintFrontmatter()
    assert.ok(issues.some(i => i.path === 'MessyNote.md' && i.field === 'Status'))
  })

  test('clean note has no issues', () => {
    const issues = vault.lintFrontmatter()
    assert.ok(!issues.some(i => i.path === 'Clean.md'), 'Clean note should have no issues')
  })

  test('dryRun does not modify files', () => {
    const before = readFileSync(join(vaultPath, 'MessyNote.md'), 'utf-8')
    vault.fixFrontmatter(true)
    const after = readFileSync(join(vaultPath, 'MessyNote.md'), 'utf-8')
    assert.equal(before, after)
  })

  test('fix normalizes tags and dedupes', () => {
    const result = vault.fixFrontmatter(false)
    const fixed = result.fixed.find(f => f.path === 'MessyNote.md')
    assert.ok(fixed)
    const content = readFileSync(join(vaultPath, 'MessyNote.md'), 'utf-8')
    // LMN and pve should be normalized to linuxmuster/proxmox; dedupe proxmox
    assert.ok(content.includes('linuxmuster'))
    assert.ok(!content.match(/lmn/i)?.[0])
    // Duplicate proxmox removed
    const proxmoxCount = (content.match(/- proxmox/g) || []).length
    assert.equal(proxmoxCount, 1)
  })

  test('fix lowercases field names', () => {
    const content = readFileSync(join(vaultPath, 'MessyNote.md'), 'utf-8')
    assert.ok(content.includes('status: aktiv'))
    assert.ok(!content.match(/^Status:/m))
  })

  test('fix adds missing status', () => {
    const content = readFileSync(join(vaultPath, 'NoStatus.md'), 'utf-8')
    assert.ok(content.includes('status: aktiv'))
  })
})

describe('Vault: broken links', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    // Create a note that exists
    writeNote(vaultPath, {
      path: 'new-folder/MovedNote.md',
      title: 'Moved Note',
      body: 'This note was moved from oldpath.',
    })
    // Create a note with broken + working links
    writeNote(vaultPath, {
      path: 'Dashboard.md',
      body: [
        '[[MovedNote]]',           // will resolve (basename match)
        '[[NonExistentTarget]]',   // broken, no candidates
        '[[old-path/MovedNote]]',  // broken but candidate available
      ].join('\n'),
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('finds broken links', () => {
    const broken = vault.findBrokenLinks()
    const targets = broken.map(b => b.target)
    assert.ok(targets.includes('NonExistentTarget'))
    assert.ok(targets.includes('old-path/MovedNote'))
    assert.ok(!targets.includes('MovedNote')) // this one resolves by basename
  })

  test('suggests candidates for broken links', () => {
    const broken = vault.findBrokenLinks()
    const oldPath = broken.find(b => b.target === 'old-path/MovedNote')
    assert.ok(oldPath)
    assert.ok(oldPath!.candidates.length >= 1)
    assert.equal(oldPath!.candidates[0].confidence, 'high')
    assert.equal(oldPath!.candidates[0].path, 'new-folder/MovedNote.md')
  })

  test('dryRun does not modify files', () => {
    const before = readFileSync(join(vaultPath, 'Dashboard.md'), 'utf-8')
    vault.fixBrokenLinks(true)
    const after = readFileSync(join(vaultPath, 'Dashboard.md'), 'utf-8')
    assert.equal(before, after)
  })

  test('fix_broken_links replaces high-confidence targets', () => {
    const result = vault.fixBrokenLinks(false)
    assert.ok(result.fixed.length >= 1)
    const content = readFileSync(join(vaultPath, 'Dashboard.md'), 'utf-8')
    assert.ok(content.includes('[[new-folder/MovedNote]]'))
  })

  test('skips ambiguous links', () => {
    const result = vault.fixBrokenLinks(true)
    // NonExistentTarget has no candidates → skipped
    assert.ok(result.skipped.some(s => s.oldLink === 'NonExistentTarget'))
  })
})

describe('Vault: find_duplicates', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'A/Docker Setup.md',
      frontmatter: { tags: ['docker', 'container', 'setup'] },
      title: 'Docker Setup Guide',
      body: 'Setting up docker compose with nginx and traefik on ubuntu server.',
    })
    writeNote(vaultPath, {
      path: 'A/Docker Installation.md',
      frontmatter: { tags: ['docker', 'container', 'setup'] },
      title: 'Docker Setup and Installation',
      body: 'Setting up docker compose with nginx and traefik on ubuntu server for production.',
    })
    writeNote(vaultPath, {
      path: 'A/Docker Consumer.md',
      frontmatter: { tags: ['docker'] },
      title: 'Docker Consumer',
      body: 'See [[Docker Installation]] for the production checklist.',
    })
    writeNote(vaultPath, {
      path: 'B/Git Notes.md',
      frontmatter: { tags: ['git'] },
      title: 'Git Notes',
      body: 'Random git commands that nothing in common with docker.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('finds similar notes', () => {
    const dups = vault.findDuplicates(40)
    assert.ok(dups.length >= 1, 'Should find at least 1 duplicate pair')
    // The two Docker notes should be the top match
    assert.ok(
      dups[0].titleA.toLowerCase().includes('docker') &&
      dups[0].titleB.toLowerCase().includes('docker'),
      'Top match should be the two Docker notes'
    )
  })

  test('does not match unrelated notes', () => {
    const dups = vault.findDuplicates(60)
    for (const d of dups) {
      // Git Notes should never pair with Docker Setup at high threshold
      assert.ok(
        !(d.titleA.includes('Git') && d.titleB.includes('Docker')),
        'Git and Docker should not be duplicates'
      )
    }
  })

  test('provides confidence level', () => {
    const dups = vault.findDuplicates(40)
    if (dups.length > 0) {
      assert.ok(['high', 'medium', 'low'].includes(dups[0].confidence))
      assert.ok(['merge', 'review', 'link'].includes(dups[0].suggestion))
    }
  })

  test('score threshold filters results', () => {
    const allDups = vault.findDuplicates(0)
    const strictDups = vault.findDuplicates(80)
    assert.ok(strictDups.length <= allDups.length)
  })

  test('merge_duplicates dry-run previews without modifying files', () => {
    const before = readFileSync(join(vaultPath, 'A/Docker Setup.md'), 'utf-8')
    const result = vault.mergeDuplicates({
      noteA: 'A/Docker Setup.md',
      noteB: 'A/Docker Installation.md',
      dryRun: true,
    })
    assert.equal(result.dryRun, true)
    assert.equal(result.applied.length, 0)
    assert.equal(result.plans.length, 1)
    assert.ok(result.plans[0].mergedPreview.includes('Zusammengeführt aus Duplikat'))
    const after = readFileSync(join(vaultPath, 'A/Docker Setup.md'), 'utf-8')
    assert.equal(before, after)
  })

  test('merge_duplicates skips explicit unrelated pairs unless forced', () => {
    const result = vault.mergeDuplicates({
      noteA: 'A/Docker Setup.md',
      noteB: 'B/Git Notes.md',
      dryRun: false,
    })
    assert.equal(result.applied.length, 0)
    assert.equal(result.skipped.length, 1)
    assert.ok(existsSync(join(vaultPath, 'B/Git Notes.md')))
  })

  test('merge_duplicates apply archives duplicate, updates target, and rewrites inbound links', () => {
    const result = vault.mergeDuplicates({
      noteA: 'A/Docker Setup.md',
      noteB: 'A/Docker Installation.md',
      dryRun: false,
      force: true,
    })
    assert.equal(result.applied.length, 1)
    assert.ok(existsSync(join(vaultPath, result.applied[0].archived)))
    const targetContent = readFileSync(join(vaultPath, result.applied[0].target), 'utf-8')
    assert.ok(targetContent.includes('Zusammengeführt aus Duplikat'))
    assert.ok(targetContent.includes('production'))
    assert.ok(targetContent.includes('Archiv/Duplikate/'))
    const consumerContent = readFileSync(join(vaultPath, 'A/Docker Consumer.md'), 'utf-8')
    assert.ok(consumerContent.includes('[[A/Docker Setup]]'))
    assert.ok(!consumerContent.includes('[[Docker Installation]]'))
  })
})

describe('Vault: generate_runbook', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Kunden/TestClient/Session1.md',
      frontmatter: { tags: ['auto-capture', 'prozedur'], datum: '2026-04-10' },
      title: 'TestClient Session 1',
      body: `## Durchgeführte Befehle

1. \`apt install nginx\`
2. \`systemctl enable nginx\`

## Fehler und Workarounds

### 1.
**Fehler:** \`something broke\`
**Fix:** \`do this instead\``,
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('generates runbook from auto-captures', () => {
    const result = vault.generateRunbook('TestClient')
    assert.ok(result.sourceCount >= 1)
    assert.ok(result.stepCount >= 2)
    assert.ok(result.fixCount >= 1)
    assert.ok(existsSync(join(vaultPath, result.path)))
  })

  test('throws if no sources found', () => {
    assert.throws(() => vault.generateRunbook('NonexistentClient'), /Keine Quell-Notizen/)
  })
})
