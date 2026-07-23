import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateLongSessionCheckpoint } from '../services/long-session-monitor.ts'
import { recordSessionEvent, markSessionCheckpoint } from '../services/session-state.ts'
import { loadBrainPolicy } from '../services/policy.ts'
import { cleanupVault } from './helpers.ts'

describe('long session checkpoint monitor', () => {
  let cleanupPaths: string[] = []

  afterEach(() => {
    for (const path of cleanupPaths) cleanupVault(path)
    cleanupPaths = []
  })

  test('triggers by command threshold and respects debounce after checkpoint', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'session-state-'))
    cleanupPaths.push(stateDir)
    const policy = loadBrainPolicy()
    const state = recordSessionEvent({
      stateDir,
      sessionId: 'monitor-test',
      commandCount: policy.automation.duringSession.minCommandsBetweenCheckpoints,
      now: new Date('2026-05-12T10:00:00Z'),
    })

    const due = evaluateLongSessionCheckpoint(state, policy, new Date('2026-05-12T10:00:01Z'))
    assert.equal(due.shouldCheckpoint, true)
    assert.ok(due.reasons.some(reason => reason.includes('commands')))

    const marked = markSessionCheckpoint({
      stateDir,
      sessionId: 'monitor-test',
      path: 'Knowledge/Checkpoints/Test.md',
      autoBuildRan: true,
      now: new Date('2026-05-12T10:00:02Z'),
    })
    const debounced = evaluateLongSessionCheckpoint(marked, policy, new Date('2026-05-12T10:05:00Z'))
    assert.equal(debounced.shouldCheckpoint, false)
    assert.ok(debounced.reasons.some(reason => reason.includes('debounce')))
    assert.ok(!readdirSync(stateDir).some(name => name.includes('.tmp-')))
  })

  test('caps checkpoints per session', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'session-state-limit-'))
    cleanupPaths.push(stateDir)
    const policy = loadBrainPolicy()
    let state = recordSessionEvent({
      stateDir,
      sessionId: 'limit-test',
      commandCount: 100,
      now: new Date('2026-05-12T10:00:00Z'),
    })
    for (let i = 0; i < policy.automation.duringSession.maxCheckpointsPerSession; i++) {
      state = markSessionCheckpoint({
        stateDir,
        sessionId: 'limit-test',
        path: `Knowledge/Checkpoints/${i}.md`,
        now: new Date(`2026-05-12T1${i}:00:00Z`),
      })
      state = recordSessionEvent({
        stateDir,
        sessionId: 'limit-test',
        commandDelta: policy.automation.duringSession.minCommandsBetweenCheckpoints,
        now: new Date(`2026-05-12T1${i}:30:00Z`),
      })
    }

    const decision = evaluateLongSessionCheckpoint(state, policy, new Date('2026-05-12T22:00:00Z'))
    assert.equal(decision.shouldCheckpoint, false)
    assert.ok(decision.reasons.some(reason => reason.includes('limit')))
  })
})
