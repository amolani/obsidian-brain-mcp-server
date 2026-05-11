import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildNoteFromTemplate,
  createNote,
  fileNameForTemplate,
  targetFolderForTemplate,
} from '../services/note-creator.ts'
import { cleanupVault, createTempVault } from './helpers.ts'

let vaultPath: string | null = null

afterEach(() => {
  if (vaultPath) cleanupVault(vaultPath)
  vaultPath = null
})

describe('note-creator', () => {
  test('builds template content and appends custom content', () => {
    const content = buildNoteFromTemplate({
      title: 'Docker TLS',
      template: 'referenz',
      tags: ['docker', 'tls'],
      content: 'Custom body',
    })

    assert.match(content, /# Docker TLS/)
    assert.match(content, /  - docker/)
    assert.match(content, /  - tls/)
    assert.match(content, /## Befehle/)
    assert.ok(content.endsWith('\n\nCustom body\n'))
  })

  test('keeps target folder and filename rules compatible with Vault createNote', () => {
    const today = new Date().toISOString().split('T')[0]

    assert.equal(targetFolderForTemplate('Acme', 'kunde'), 'Kunden/Acme')
    assert.equal(targetFolderForTemplate('Runbook', 'troubleshooting'), 'Referenz')
    assert.equal(targetFolderForTemplate('X', 'daily'), 'Daily')
    assert.equal(targetFolderForTemplate('X', 'referenz', 'Custom'), 'Custom')
    assert.equal(fileNameForTemplate('ignored', 'daily'), `${today}.md`)
    assert.equal(fileNameForTemplate('Docker', 'referenz'), 'Docker.md')
  })

  test('writes note, indexes it, and logs the action', () => {
    vaultPath = createTempVault()
    const indexed: string[] = []

    const result = createNote({
      vaultPath,
      indexNote(fullPath) {
        indexed.push(fullPath)
      },
    }, {
      title: 'TestRef',
      template: 'referenz',
      tags: ['test'],
    })

    const fullPath = join(vaultPath, result.path)
    assert.equal(result.path, 'Referenz/TestRef.md')
    assert.ok(existsSync(fullPath))
    assert.deepEqual(indexed, [fullPath])
    assert.match(readFileSync(fullPath, 'utf-8'), /# TestRef/)
    assert.match(readFileSync(join(vaultPath, '.action-log.jsonl'), 'utf-8'), /"tool":"create_note"/)
  })

  test('throws for unknown templates before writing', () => {
    assert.throws(() => buildNoteFromTemplate({ title: 'X', template: 'unknown' }), /Unknown template/)
  })
})
