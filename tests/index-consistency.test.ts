import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

function relatedPaths(vault: Vault, path: string): string[] {
  const context = vault.getNoteContext(path)
  assert.ok(context)
  return context.relatedByTags.map(note => note.path)
}

describe('Vault: index consistency', () => {
  test('reindexing replaces old tag memberships with the current tags', async () => {
    const vaultPath = createTempVault()
    const subjectPath = writeNote(vaultPath, {
      path: 'Subject.md',
      frontmatter: { tags: ['old/one', 'old/two'] },
      title: 'Subject',
    })
    writeNote(vaultPath, {
      path: 'Old Peer.md',
      frontmatter: { tags: ['old/one', 'old/two'] },
      title: 'Old Peer',
    })
    writeNote(vaultPath, {
      path: 'New Peer.md',
      frontmatter: { tags: ['new/one', 'new/two'] },
      title: 'New Peer',
    })
    const vault = new Vault(vaultPath)

    try {
      await vault.init()
      vault.shutdown()
      assert.ok(relatedPaths(vault, 'Old Peer.md').includes('Subject.md'))

      writeNote(vaultPath, {
        path: 'Subject.md',
        frontmatter: { tags: ['new/one', 'new/two'] },
        title: 'Subject',
      })
      vault.indexNote(subjectPath, statSync(subjectPath).mtimeMs)

      assert.ok(!relatedPaths(vault, 'Old Peer.md').includes('Subject.md'))
      assert.ok(relatedPaths(vault, 'New Peer.md').includes('Subject.md'))
    } finally {
      vault.shutdown()
      cleanupVault(vaultPath)
    }
  })

  test('organize_referenz removes the source path from tag indexes before moving', async () => {
    const vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Referenz/Docker Move.md',
      frontmatter: { tags: ['docker', 'docker/compose'] },
      title: 'Docker Move',
      body: 'docker compose deployment',
    })
    writeNote(vaultPath, {
      path: 'Peer.md',
      frontmatter: { tags: ['docker', 'docker/compose'] },
      title: 'Peer',
    })
    const vault = new Vault(vaultPath)

    try {
      await vault.init()
      vault.shutdown()
      const result = vault.organizeReferenz(false)
      assert.equal(result.moved.length, 1)

      const replacementPath = writeNote(vaultPath, {
        path: 'Referenz/Docker Move.md',
        frontmatter: { tags: ['personal', 'replacement'] },
        title: 'Replacement',
      })
      vault.indexNote(replacementPath, statSync(replacementPath).mtimeMs)

      const related = relatedPaths(vault, 'Peer.md')
      assert.ok(related.includes(result.moved[0].to))
      assert.ok(!related.includes('Referenz/Docker Move.md'))
    } finally {
      vault.shutdown()
      cleanupVault(vaultPath)
    }
  })

  test('merge_duplicates removes the archived source path from tag indexes', async () => {
    const vaultPath = createTempVault()
    writeNote(vaultPath, {
      path: 'Dup/A.md',
      frontmatter: { tags: ['docker', 'setup', 'compose'] },
      title: 'Docker Setup',
      body: 'Docker compose setup with nginx reverse proxy.',
    })
    writeNote(vaultPath, {
      path: 'Dup/B.md',
      frontmatter: { tags: ['docker', 'setup', 'compose'] },
      title: 'Docker Setup Guide',
      body: 'Docker compose setup with nginx reverse proxy for production.',
    })
    const vault = new Vault(vaultPath)

    try {
      await vault.init()
      vault.shutdown()
      const result = vault.mergeDuplicates({
        noteA: 'Dup/A.md',
        noteB: 'Dup/B.md',
        dryRun: false,
        force: true,
      })
      assert.equal(result.applied.length, 1)
      const applied = result.applied[0]
      const archivedSource = applied.target === 'Dup/A.md' ? 'Dup/B.md' : 'Dup/A.md'

      const replacementPath = writeNote(vaultPath, {
        path: archivedSource,
        frontmatter: { tags: ['personal', 'replacement'] },
        title: 'Replacement',
      })
      vault.indexNote(replacementPath, statSync(replacementPath).mtimeMs)

      const related = relatedPaths(vault, applied.target)
      assert.ok(related.includes(applied.archived))
      assert.ok(!related.includes(archivedSource))
    } finally {
      vault.shutdown()
      cleanupVault(vaultPath)
    }
  })
})
