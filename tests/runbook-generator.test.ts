import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NoteEntry } from '../vault.ts'
import { generateRunbook } from '../services/runbook-generator.ts'
import { cleanupVault, createTempVault } from './helpers.ts'

let vaultPath: string | null = null

afterEach(() => {
  if (vaultPath) cleanupVault(vaultPath)
  vaultPath = null
})

function note(path: string, overrides: Partial<NoteEntry> = {}): NoteEntry {
  return {
    path: `/vault/${path}`,
    relativePath: path,
    title: path.replace(/\.md$/, ''),
    frontmatter: {},
    tags: [],
    outgoingLinks: [],
    todos: [],
    lastModified: 1,
    content: '',
    ...overrides,
  }
}

describe('runbook-generator', () => {
  test('generates runbook from auto-capture sources and indexes it', () => {
    vaultPath = createTempVault()
    const notes = new Map<string, NoteEntry>([
      ['Kunden/Acme/Session.md', note('Kunden/Acme/Session.md', {
        title: 'Acme Session',
        frontmatter: { datum: '2026-04-28' },
        tags: ['auto-capture', 'prozedur'],
        content: `## Zusammenfassung

Setup summary.

## Durchgeführte Befehle

1. \`apt install nginx\`
2. \`systemctl enable nginx\`

## Fehler und Workarounds

### 1.
**Fehler:** broke
**Fix:** restart`,
      })],
    ])
    const indexed: string[] = []
    let rebuilt = false

    const result = generateRunbook({
      vaultPath,
      notes,
      indexNote(path) {
        indexed.push(path)
      },
      buildLinkIndex() {
        rebuilt = true
      },
    }, 'Acme', 'Output')

    assert.equal(result.path, 'Output/Runbook Acme.md')
    assert.equal(result.dryRun, false)
    assert.equal(result.sourceCount, 1)
    assert.equal(result.stepCount, 2)
    assert.equal(result.fixCount, 1)
    assert.ok(existsSync(join(vaultPath, result.path)))
    assert.deepEqual(indexed, [join(vaultPath, result.path)])
    assert.equal(rebuilt, true)
    const content = readFileSync(join(vaultPath, result.path), 'utf-8')
    assert.match(content, /# Runbook: Acme/)
    assert.match(content, /apt install nginx/)
    assert.match(content, /## Voraussetzungen/)
    assert.match(content, /## Rollback/)
    assert.match(content, /Bekannte Probleme/)
  })

  test('previews runbook without writing when dryRun is true', () => {
    vaultPath = createTempVault()
    const notes = new Map<string, NoteEntry>([
      ['Kunden/Acme/Session.md', note('Kunden/Acme/Session.md', {
        title: 'Acme Session',
        tags: ['auto-capture', 'prozedur'],
        content: `## Durchgeführte Befehle

1. \`apt install nginx\`
2. \`systemctl enable nginx\``,
      })],
    ])

    const result = generateRunbook({
      vaultPath,
      notes,
      indexNote() {
        throw new Error('should not index during dry-run')
      },
      buildLinkIndex() {
        throw new Error('should not rebuild during dry-run')
      },
    }, 'Acme', { outputFolder: 'Output', dryRun: true })

    assert.equal(result.dryRun, true)
    assert.equal(result.path, 'Output/Runbook Acme.md')
    assert.ok(!existsSync(join(vaultPath, result.path)))
    assert.match(result.content, /## Validierung/)
  })

  test('throws when no source notes match', () => {
    vaultPath = createTempVault()
    assert.throws(() => generateRunbook({
      vaultPath: vaultPath!,
      notes: new Map(),
      indexNote() {},
      buildLinkIndex() {},
    }, 'Missing'), /Keine Quell-Notizen/)
  })
})
