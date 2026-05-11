import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dailyNote } from '../services/daily-note.ts'
import { cleanupVault, createTempVault } from './helpers.ts'

let vaultPath: string | null = null

afterEach(() => {
  if (vaultPath) cleanupVault(vaultPath)
  vaultPath = null
})

describe('daily-note', () => {
  test('appends to existing daily note, reindexes, rebuilds links, and logs action', () => {
    vaultPath = createTempVault()
    const today = new Date().toISOString().split('T')[0]
    const relativePath = `Daily/${today}.md`
    const fullPath = join(vaultPath, relativePath)
    mkdirSync(join(vaultPath, 'Daily'), { recursive: true })
    writeFileSync(fullPath, `# ${today}\n`, 'utf-8')

    const indexed: string[] = []
    let rebuilt = false
    const result = dailyNote({
      vaultPath,
      createNote() {
        throw new Error('createNote should not be called')
      },
      indexNote(path) {
        indexed.push(path)
      },
      buildLinkIndex() {
        rebuilt = true
      },
    }, 'Appendix')

    assert.equal(result.path, relativePath)
    assert.equal(result.created, false)
    assert.match(result.content, /Appendix/)
    assert.deepEqual(indexed, [fullPath])
    assert.equal(rebuilt, true)
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"daily_note"/)
  })

  test('creates daily note through provided creator when missing', () => {
    vaultPath = createTempVault()
    const today = new Date().toISOString().split('T')[0]

    const result = dailyNote({
      vaultPath,
      createNote(title, template, content) {
        assert.equal(title, today)
        assert.equal(template, 'daily')
        mkdirSync(join(vaultPath!, 'Daily'), { recursive: true })
        const relativePath = `Daily/${today}.md`
        writeFileSync(join(vaultPath!, relativePath), `# ${today}\n\n${content}\n`, 'utf-8')
        return { path: relativePath }
      },
      indexNote() {},
      buildLinkIndex() {},
    }, 'First entry')

    assert.equal(result.created, true)
    assert.equal(result.path, `Daily/${today}.md`)
    assert.ok(existsSync(join(vaultPath, result.path)))
    assert.match(result.content, /First entry/)
  })
})
