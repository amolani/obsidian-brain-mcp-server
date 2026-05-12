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

  test('automation defaults allow safe auto-build but keep risky tools out', () => {
    const policy = loadBrainPolicy()
    assert.equal(policy.automation.mode, 'auto_build')
    assert.equal(policy.automation.afterSession.promoteCaptures, true)
    assert.equal(policy.automation.afterSession.extractClaims, true)
    assert.equal(policy.automation.afterSession.buildCustomerSnapshot, true)
    assert.equal(policy.automation.afterSession.promoteRunbooks, true)
    assert.equal(policy.automation.limits.maxNewNotesPerRun, 12)
    assert.equal(policy.automation.limits.maxClaimsPerRun, 6)
    assert.equal(policy.automation.duringSession.allowManualAutoBuildTool, true)
    assert.equal(policy.automation.duringSession.autoCheckpoint, true)
    assert.equal(policy.automation.duringSession.runAutoBuildOnCheckpoint, true)
    assert.equal(policy.automation.duringSession.minMinutesBetweenCheckpoints, 30)
    assert.equal(policy.automation.duringSession.minCommandsBetweenCheckpoints, 12)
    assert.equal(policy.automation.duringSession.maxCheckpointsPerSession, 6)
    assert.equal(policy.tools.archive_auto_build_run.requiresDryRunDefault, true)
    assert.ok(policy.automation.neverAutoApply.includes('merge_duplicates'))
    assert.ok(policy.automation.neverAutoApply.includes('rename_note'))
  })
})
