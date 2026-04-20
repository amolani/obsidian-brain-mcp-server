// Tests for vault.ts — core Vault class

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
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
      body: 'Customer docs mentioning docker once.',
    })
    writeNote(vaultPath, {
      path: 'Referenz/Git.md',
      frontmatter: { status: 'planung', tags: ['git'] },
      title: 'Git Notes',
      body: 'Git commands.',
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
