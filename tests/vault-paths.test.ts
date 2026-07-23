import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeRelativePath, sanitizePathSegment, uniqueRelativePath, vaultJoin } from '../services/vault-paths.ts'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'obsidian-vault-paths-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('vault path safety', () => {
  test('rejects traversal, blank paths, controls, and empty generated names', () => {
    const vault = tempRoot()
    assert.throws(() => assertSafeRelativePath('../outside.md'), /Unsicherer Vault-Pfad/)
    assert.throws(() => assertSafeRelativePath('C:\\outside.md'), /Unsicherer Vault-Pfad/)
    assert.throws(() => assertSafeRelativePath(''), /Unsicherer Vault-Pfad/)
    assert.throws(() => assertSafeRelativePath('Knowledge/line\nbreak.md'), /Unsicherer Vault-Pfad/)
    assert.equal(sanitizePathSegment('line\nbreak:name'), 'line-break-name')
    assert.throws(() => uniqueRelativePath(vault, 'Knowledge', '..'), /Ungültiger Dateiname/)
  })

  test('keeps normal paths inside the vault', () => {
    const vault = tempRoot()
    assert.equal(vaultJoin(vault, 'Knowledge/Note.md'), join(vault, 'Knowledge', 'Note.md'))
  })

  test('rejects an existing parent symlink that escapes the vault', { skip: process.platform === 'win32' }, () => {
    const vault = tempRoot()
    const outside = tempRoot()
    mkdirSync(join(vault, 'Knowledge'))
    symlinkSync(outside, join(vault, 'Knowledge', 'external'), 'dir')

    assert.throws(
      () => vaultJoin(vault, 'Knowledge/external/note.md'),
      /verlässt über Symlink/,
    )
  })
})
