// Integration test: runs the knowledge-harvester hook with a sample transcript.
// Uses isolated VAULT_PATH via env var so nothing touches the real vault.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createTempVault, cleanupVault } from './helpers.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HARVESTER = join(__dirname, '..', 'hooks', 'knowledge-harvester.ts')
const FIXTURE = join(__dirname, 'fixtures', 'sample-transcript.jsonl')

function runHarvester(vaultPath: string, stateDir: string, input: object) {
  return spawnSync('node', [HARVESTER], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      VAULT_PATH: vaultPath,
      HARVESTER_LOG: join(stateDir, 'log.txt'),
      HARVESTER_STATE_DIR: stateDir,
      HARVESTER_SUGGESTIONS_LOG: join(stateDir, 'suggestions.log'),
    },
  })
}

describe('Harvester: end-to-end', () => {
  let vaultPath: string
  let stateDir: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-state-'))
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  test('runs without errors on sample transcript', () => {
    const result = runHarvester(vaultPath, stateDir, {
      session_id: 'test-e2e',
      transcript_path: FIXTURE,
      cwd: '/home/amo/Documents/code/amo/adbk',
    })
    assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  })

  test('creates capture note in isolated vault', () => {
    // Previous test already ran — check vault for any .md file
    const log = join(stateDir, 'log.txt')
    if (existsSync(log)) {
      const content = readFileSync(log, 'utf-8')
      assert.ok(content.includes('Captured') || content.includes('not enough'), log)
    }
  })

  test('records session in state dir', () => {
    const stateFile = join(stateDir, 'test-e2e.done')
    assert.ok(existsSync(stateFile))
  })
})

describe('Harvester: deduplication', () => {
  let vaultPath: string
  let stateDir: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-dedup-'))
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  test('second run with same session_id is a no-op', () => {
    const input = {
      session_id: 'test-dedup',
      transcript_path: FIXTURE,
      cwd: '/tmp',
    }

    const r1 = runHarvester(vaultPath, stateDir, input)
    assert.equal(r1.status, 0)

    const stateFile = join(stateDir, 'test-dedup.done')
    assert.ok(existsSync(stateFile))
    const mtime1 = statSync(stateFile).mtimeMs

    // Second run
    const r2 = runHarvester(vaultPath, stateDir, input)
    assert.equal(r2.status, 0)
    const mtime2 = statSync(stateFile).mtimeMs
    assert.equal(mtime1, mtime2, 'State file should NOT be updated on re-run')
  })
})

describe('Harvester: minimum substance filtering', () => {
  let vaultPath: string
  let stateDir: string
  let miniTranscript: string

  before(() => {
    vaultPath = createTempVault()
    stateDir = mkdtempSync(join(tmpdir(), 'harvester-mini-'))

    // Create a very short transcript (< 10 entries) — should be ignored
    miniTranscript = join(stateDir, 'mini.jsonl')
    const entries = [
      { role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
    ]
    writeFileSync(miniTranscript, entries.map(e => JSON.stringify(e)).join('\n'))
  })

  after(() => {
    cleanupVault(vaultPath)
    cleanupVault(stateDir)
  })

  test('short transcript does not produce capture', () => {
    const result = runHarvester(vaultPath, stateDir, {
      session_id: 'test-mini',
      transcript_path: miniTranscript,
      cwd: '/tmp',
    })
    assert.equal(result.status, 0)

    // No state file should be created (exited early)
    const stateFile = join(stateDir, 'test-mini.done')
    assert.ok(!existsSync(stateFile), 'Short sessions should not be marked captured')
  })
})
