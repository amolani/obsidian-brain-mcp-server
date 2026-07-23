import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from './atomic-file.ts'

export interface SessionState {
  version: 1
  sessionId: string
  cwd: string
  client: string | null
  startedAt: string
  updatedAt: string
  commandCount: number
  checkpointCount: number
  lastCheckpointAt: string | null
  lastCheckpointCommandCount: number
  lastCheckpointPath: string | null
  lastAutoBuildAt: string | null
}

export interface RecordSessionEventOptions {
  stateDir: string
  sessionId: string
  cwd?: string
  client?: string | null
  commandCount?: number
  commandDelta?: number
  now?: Date
}

export interface UpdateSessionCheckpointOptions {
  stateDir: string
  sessionId: string
  path: string
  autoBuildRan?: boolean
  now?: Date
}

function statePath(stateDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  return join(stateDir, `${safe}.json`)
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

function freshState(sessionId: string, now: Date, cwd = '', client: string | null = null): SessionState {
  return {
    version: 1,
    sessionId,
    cwd,
    client,
    startedAt: nowIso(now),
    updatedAt: nowIso(now),
    commandCount: 0,
    checkpointCount: 0,
    lastCheckpointAt: null,
    lastCheckpointCommandCount: 0,
    lastCheckpointPath: null,
    lastAutoBuildAt: null,
  }
}

export function readSessionState(stateDir: string, sessionId: string): SessionState | null {
  try {
    const path = statePath(stateDir, sessionId)
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SessionState>
    if (parsed.version !== 1 || parsed.sessionId !== sessionId) return null
    return {
      ...freshState(sessionId, new Date(parsed.startedAt ?? Date.now())),
      ...parsed,
      client: parsed.client ?? null,
      lastCheckpointAt: parsed.lastCheckpointAt ?? null,
      lastCheckpointPath: parsed.lastCheckpointPath ?? null,
      lastAutoBuildAt: parsed.lastAutoBuildAt ?? null,
      commandCount: typeof parsed.commandCount === 'number' ? Math.max(0, parsed.commandCount) : 0,
      checkpointCount: typeof parsed.checkpointCount === 'number' ? Math.max(0, parsed.checkpointCount) : 0,
      lastCheckpointCommandCount: typeof parsed.lastCheckpointCommandCount === 'number' ? Math.max(0, parsed.lastCheckpointCommandCount) : 0,
    }
  } catch {
    return null
  }
}

export function writeSessionState(stateDir: string, state: SessionState): void {
  mkdirSync(stateDir, { recursive: true })
  atomicWriteJsonSync(statePath(stateDir, state.sessionId), state)
}

export function recordSessionEvent(options: RecordSessionEventOptions): SessionState {
  const now = options.now ?? new Date()
  const previous = readSessionState(options.stateDir, options.sessionId) ?? freshState(options.sessionId, now, options.cwd, options.client ?? null)
  const commandCount = typeof options.commandCount === 'number'
    ? Math.max(previous.commandCount, options.commandCount)
    : previous.commandCount + Math.max(0, options.commandDelta ?? 0)
  const state: SessionState = {
    ...previous,
    cwd: options.cwd ?? previous.cwd,
    client: options.client ?? previous.client,
    commandCount,
    updatedAt: nowIso(now),
  }
  writeSessionState(options.stateDir, state)
  return state
}

export function markSessionCheckpoint(options: UpdateSessionCheckpointOptions): SessionState {
  const now = options.now ?? new Date()
  const state = readSessionState(options.stateDir, options.sessionId) ?? freshState(options.sessionId, now)
  const updated: SessionState = {
    ...state,
    updatedAt: nowIso(now),
    checkpointCount: state.checkpointCount + 1,
    lastCheckpointAt: nowIso(now),
    lastCheckpointCommandCount: state.commandCount,
    lastCheckpointPath: options.path,
    lastAutoBuildAt: options.autoBuildRan ? nowIso(now) : state.lastAutoBuildAt,
  }
  writeSessionState(options.stateDir, updated)
  return updated
}

export function cleanupSessionStates(stateDir: string, keep = 50): void {
  try {
    const files = readdirSync(stateDir)
      .filter(name => name.endsWith('.json'))
      .map(name => ({ name, mtime: statSync(join(stateDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const file of files.slice(keep)) unlinkSync(join(stateDir, file.name))
  } catch {}
}
