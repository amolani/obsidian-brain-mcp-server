// Tests for services/action-log.ts — every vault-write emits one JSONL entry.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { ACTION_LOG_FILE, appendActionLog } from '../services/action-log.ts'
import { createTempVault, cleanupVault, writeNote } from './helpers.ts'

function readLogLines(vaultPath: string): Array<Record<string, any>> {
  const file = join(vaultPath, ACTION_LOG_FILE)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l))
}

describe('ActionLog: append + format', () => {
  let vaultPath: string

  before(() => {
    vaultPath = createTempVault()
  })

  after(() => {
    cleanupVault(vaultPath)
  })

  test('appendActionLog writes one JSON line with required fields', () => {
    appendActionLog(vaultPath, {
      tool: 'test_tool',
      mode: 'apply',
      targets: ['Note.md'],
      summary: 'hello',
    })
    const lines = readLogLines(vaultPath)
    assert.equal(lines.length, 1)
    const entry = lines[0]
    assert.equal(entry.tool, 'test_tool')
    assert.equal(entry.mode, 'apply')
    assert.deepEqual(entry.targets, ['Note.md'])
    assert.equal(entry.summary, 'hello')
    assert.ok(typeof entry.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(entry.ts))
  })

  test('successive writes append (do not overwrite)', () => {
    appendActionLog(vaultPath, { tool: 't2', mode: 'apply', targets: [], summary: 's2' })
    const lines = readLogLines(vaultPath)
    assert.equal(lines.length, 2)
    assert.equal(lines[1].tool, 't2')
  })
})

describe('ActionLog: vault writers emit entries', () => {
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

  test('capture emits a capture entry', () => {
    vault.capture('Merian: Test-Capture mit docker')
    const lines = readLogLines(vaultPath)
    const entry = lines.find(l => l.tool === 'capture')
    assert.ok(entry, 'expected one capture entry')
    assert.equal(entry.mode, 'apply')
    assert.equal(entry.targets.length, 1)
    assert.match(entry.targets[0], /^Kunden\/Merian\//)
  })

  test('createNote emits a create_note entry', () => {
    const before = readLogLines(vaultPath).length
    vault.createNote('LogTestRef', 'referenz')
    const lines = readLogLines(vaultPath)
    assert.equal(lines.length, before + 1)
    const entry = lines[lines.length - 1]
    assert.equal(entry.tool, 'create_note')
    assert.equal(entry.meta?.template, 'referenz')
  })
})

describe('ActionLog: dry-run does not write', () => {
  let vaultPath: string
  let vault: Vault

  before(async () => {
    vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Dashboard.md',
      body: '[[Missing]]',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  after(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('fix_broken_links dry-run produces no action-log entry', () => {
    vault.fixBrokenLinks(true)
    const entries = readLogLines(vaultPath).filter(l => l.tool === 'fix_broken_links')
    assert.equal(entries.length, 0)
  })
})
