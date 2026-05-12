import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canWriteTool,
  isAutomaticRecallAllowed,
  isProtectedPath,
  loadBrainPolicy,
} from '../services/policy.ts'

describe('brain policy', () => {
  test('defaults keep working memory manual only', () => {
    const policy = loadBrainPolicy()
    assert.equal(policy.workingMemory.mode, 'manual_only')
    assert.equal(policy.workingMemory.allowAutomaticRecall, false)
    assert.equal(isAutomaticRecallAllowed(), false)
  })

  test('protects system folders from writes', () => {
    assert.equal(isProtectedPath('.obsidian/workspace.json'), true)
    assert.equal(isProtectedPath('Templates/Runbook.md'), true)
    assert.equal(isProtectedPath('Technik/Docker/Compose.md'), false)
  })

  test('read-only tools cannot write and writer tools cannot touch protected paths', () => {
    assert.equal(canWriteTool('recall_context', []).allowed, false)
    assert.equal(canWriteTool('rename_note', ['Technik/Docker/A.md']).allowed, true)
    const blocked = canWriteTool('rename_note', ['.obsidian/workspace.json'])
    assert.equal(blocked.allowed, false)
    assert.match(blocked.reason ?? '', /Geschützter Pfad/)
  })

  test('hook defaults disable automatic organization', () => {
    const policy = loadBrainPolicy()
    assert.equal(policy.hooks.createDailyNote, true)
    assert.equal(policy.hooks.autoCapture, true)
    assert.equal(policy.hooks.appendDailyCaptureLink, true)
    assert.equal(policy.hooks.autoOrganize, false)
  })
})
