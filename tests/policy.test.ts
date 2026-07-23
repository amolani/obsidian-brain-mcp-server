import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canWriteTool,
  diagnoseBrainPolicy,
  isAutomaticRecallAllowed,
  isProtectedPath,
  loadBrainPolicy,
  reloadBrainPolicy,
} from '../services/policy.ts'

const originalPolicyPath = process.env.BRAIN_POLICY_PATH
const tempRoots: string[] = []

afterEach(() => {
  if (originalPolicyPath === undefined) delete process.env.BRAIN_POLICY_PATH
  else process.env.BRAIN_POLICY_PATH = originalPolicyPath
  reloadBrainPolicy()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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
    const unknown = canWriteTool('misspelled_writer', ['Technik/Docker/A.md'])
    assert.equal(unknown.allowed, false)
    assert.match(unknown.reason ?? '', /Keine Tool-Policy/)
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
    assert.equal(policy.tools.brain_health_check.write, false)
    assert.equal(policy.tools.record_calibration_label.requiresDryRunDefault, true)
    assert.equal(policy.tools.record_calibration_judgement.requiresDryRunDefault, true)
    assert.equal(policy.tools.brain_calibration_review_batch.write, false)
    assert.equal(policy.tools.brain_calibration_summary.write, false)
    assert.equal(policy.tools.brain_calibration_evaluate.write, false)
    assert.ok(policy.automation.neverAutoApply.includes('merge_duplicates'))
    assert.ok(policy.automation.neverAutoApply.includes('rename_note'))
  })

  test('invalid policy fails closed and blocks writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'obsidian-policy-invalid-'))
    tempRoots.push(root)
    const path = join(root, 'brain-policy.json')
    writeFileSync(path, '{ invalid json', 'utf-8')
    process.env.BRAIN_POLICY_PATH = path

    const policy = reloadBrainPolicy()
    const diagnostic = diagnoseBrainPolicy()

    assert.equal(diagnostic.valid, false)
    assert.equal(policy.automation.mode, 'off')
    assert.equal(policy.hooks.autoCapture, false)
    const write = canWriteTool('rename_note', ['Technik/Docker/A.md'])
    assert.equal(write.allowed, false)
    assert.match(write.reason ?? '', /fail-closed/)
  })

  test('invalid tool entries make the complete policy fail closed', () => {
    const root = mkdtempSync(join(tmpdir(), 'obsidian-policy-invalid-tool-'))
    tempRoots.push(root)
    const path = join(root, 'brain-policy.json')
    const policy = JSON.parse(JSON.stringify(loadBrainPolicy())) as Record<string, any>
    policy.tools.daily_note.write = 'yes'
    writeFileSync(path, `${JSON.stringify(policy)}\n`, 'utf-8')
    process.env.BRAIN_POLICY_PATH = path

    reloadBrainPolicy()
    const diagnostic = diagnoseBrainPolicy()

    assert.equal(diagnostic.valid, false)
    assert.match(diagnostic.errors.join('; '), /daily_note\.write muss boolean sein/)
    assert.equal(canWriteTool('daily_note', ['Daily/2026-01-01.md']).allowed, false)
  })

  test('missing nested automation and hook fields fail closed instead of inheriting write-on defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'obsidian-policy-missing-fields-'))
    tempRoots.push(root)
    const path = join(root, 'brain-policy.json')
    const policy = JSON.parse(JSON.stringify(loadBrainPolicy())) as Record<string, any>
    delete policy.automation.afterSession.buildDashboard
    delete policy.automation.duringSession.autoCheckpoint
    delete policy.hooks.autoCapture
    delete policy.tools.promote_suggestion
    writeFileSync(path, `${JSON.stringify(policy)}\n`, 'utf-8')
    process.env.BRAIN_POLICY_PATH = path

    const diagnostic = diagnoseBrainPolicy()

    assert.equal(diagnostic.valid, false)
    assert.match(diagnostic.errors.join('; '), /buildDashboard muss boolean sein/)
    assert.match(diagnostic.errors.join('; '), /autoCheckpoint muss boolean sein/)
    assert.match(diagnostic.errors.join('; '), /hooks\.autoCapture muss boolean sein/)
    assert.match(diagnostic.errors.join('; '), /Tool-Policy fehlt: promote_suggestion/)
    assert.equal(loadBrainPolicy().automation.mode, 'off')
    assert.equal(canWriteTool('build_brain_dashboard', ['Knowledge/_brain.md']).allowed, false)
  })

  test('rejects hook-driven folder organization required to stay manual in V1', () => {
    const root = mkdtempSync(join(tmpdir(), 'obsidian-policy-auto-organize-'))
    tempRoots.push(root)
    const path = join(root, 'brain-policy.json')
    const policy = JSON.parse(JSON.stringify(loadBrainPolicy())) as Record<string, any>
    policy.hooks.autoOrganize = true
    writeFileSync(path, `${JSON.stringify(policy)}\n`, 'utf-8')
    process.env.BRAIN_POLICY_PATH = path

    const fallback = reloadBrainPolicy()
    const diagnostic = diagnoseBrainPolicy()

    assert.equal(diagnostic.valid, false)
    assert.match(diagnostic.errors.join('; '), /autoOrganize muss für V1 false sein/)
    assert.equal(fallback.hooks.autoOrganize, false)
  })

  test('detects policy drift at the same path without restarting the process', () => {
    const root = mkdtempSync(join(tmpdir(), 'obsidian-policy-drift-'))
    tempRoots.push(root)
    const path = join(root, 'brain-policy.json')
    writeFileSync(path, `${JSON.stringify(loadBrainPolicy())}\n`, 'utf-8')
    process.env.BRAIN_POLICY_PATH = path

    assert.equal(reloadBrainPolicy().automation.mode, 'auto_build')
    assert.equal(diagnoseBrainPolicy().valid, true)
    assert.equal(canWriteTool('daily_note', ['Daily/2026-01-01.md']).allowed, true)

    writeFileSync(path, '{ malformed after startup', 'utf-8')

    assert.equal(diagnoseBrainPolicy().valid, false)
    assert.equal(loadBrainPolicy().automation.mode, 'off')
    assert.equal(canWriteTool('daily_note', ['Daily/2026-01-01.md']).allowed, false)
  })
})
