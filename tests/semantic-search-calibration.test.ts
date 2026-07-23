import { statSync } from 'node:fs'
import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Vault } from '../vault.ts'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

describe('semantic search calibration-frontmatter isolation', () => {
  let vaultPath: string
  let notePath: string
  let vault: Vault

  beforeEach(async () => {
    vaultPath = createTempVault()
    notePath = writeNote(vaultPath, {
      path: 'Referenz/Generic Capture.md',
      title: 'Generic Capture',
      frontmatter: {
        status: 'aktiv',
        projekt: 'Public Project',
        calibration_capture_schema: 'calibration-capture-v2',
        calibration_snapshot_payloads: ['blindreviewtokenalpha'],
      },
      body: 'Ordinary retained knowledge about a stable service.',
    })
    vault = new Vault(vaultPath)
    await vault.init()
  })

  afterEach(() => {
    vault.shutdown()
    cleanupVault(vaultPath)
  })

  test('does not vectorize internal calibration frontmatter', () => {
    const blinded = vault.semanticSearch({
      query: 'blindreviewtokenalpha',
      minScore: 1,
      useIndex: false,
    })
    const ordinary = vault.semanticSearch({
      query: 'ordinary retained knowledge',
      minScore: 1,
      useIndex: false,
    })

    assert.deepEqual(blinded, [])
    assert.ok(ordinary.some(result => result.path === 'Referenz/Generic Capture.md'))
  })

  test('does not stale the semantic index for calibration-only metadata changes', () => {
    vault.rebuildSemanticIndex({ dryRun: false })

    notePath = writeNote(vaultPath, {
      path: 'Referenz/Generic Capture.md',
      title: 'Generic Capture',
      frontmatter: {
        status: 'aktiv',
        projekt: 'Public Project',
        calibration_capture_schema: 'calibration-capture-v2',
        calibration_snapshot_payloads: ['blindreviewtokenbeta'],
      },
      body: 'Ordinary retained knowledge about a stable service.',
    })
    vault.indexNote(notePath, statSync(notePath).mtimeMs)

    const calibrationOnly = vault.semanticIndexStatus()
    assert.deepEqual(calibrationOnly.staleNotes, [])
    assert.equal(calibrationOnly.freshNotes, 1)

    notePath = writeNote(vaultPath, {
      path: 'Referenz/Generic Capture.md',
      title: 'Generic Capture',
      frontmatter: {
        status: 'aktiv',
        projekt: 'Changed Public Project',
        calibration_capture_schema: 'calibration-capture-v2',
        calibration_snapshot_payloads: ['blindreviewtokenbeta'],
      },
      body: 'Ordinary retained knowledge about a stable service.',
    })
    vault.indexNote(notePath, statSync(notePath).mtimeMs)

    assert.deepEqual(vault.semanticIndexStatus().staleNotes, [
      'Referenz/Generic Capture.md',
    ])
  })
})
