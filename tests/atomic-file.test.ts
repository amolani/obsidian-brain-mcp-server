import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import { atomicWriteFileSync, atomicWriteJsonSync } from '../services/atomic-file.ts'
import { cleanupVault } from './helpers.ts'

describe('atomic persistent file writes', () => {
  const cleanupPaths: string[] = []

  afterEach(() => {
    for (const path of cleanupPaths) cleanupVault(path)
    cleanupPaths.length = 0
  })

  test('replaces text and JSON targets without leaving temporary files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-state-'))
    cleanupPaths.push(directory)
    const textPath = join(directory, 'state.txt')
    const jsonPath = join(directory, 'state.json')
    writeFileSync(textPath, 'old\n', 'utf-8')

    atomicWriteFileSync(textPath, 'new\n')
    atomicWriteJsonSync(jsonPath, { version: 1, ready: true })

    assert.equal(readFileSync(textPath, 'utf-8'), 'new\n')
    assert.deepEqual(JSON.parse(readFileSync(jsonPath, 'utf-8')), { version: 1, ready: true })
    assert.ok(!readdirSync(directory).some(name => name.includes('.tmp-')))
  })

  test('removes its temporary file when the final rename fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atomic-state-failure-'))
    cleanupPaths.push(directory)
    const directoryTarget = join(directory, 'cannot-replace')
    mkdirSync(directoryTarget)

    assert.throws(() => atomicWriteFileSync(directoryTarget, 'state\n'))
    assert.ok(!readdirSync(directory).some(name => name.startsWith('cannot-replace.tmp-')))
  })
})
