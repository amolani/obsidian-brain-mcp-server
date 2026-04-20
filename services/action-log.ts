// Append-only audit trail for every vault-write operation.
// File: {vaultPath}/.action-log.jsonl (one JSON object per line).
//
// Logging must never crash the caller — on any IO error we silently drop the
// entry. The vault scanner skips dotfiles, so the log is not re-indexed.

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ActionLogEntry {
  tool: string                        // e.g. "fix_broken_links", "capture"
  mode: 'apply' | 'dry-run'           // callers should only log on 'apply'
  targets: string[]                   // vault-relative paths touched
  summary: string
  before?: string
  after?: string
  meta?: Record<string, unknown>      // tool-specific extras
}

export const ACTION_LOG_FILE = '.action-log.jsonl'

export function appendActionLog(vaultPath: string, entry: ActionLogEntry): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
  })
  try {
    appendFileSync(join(vaultPath, ACTION_LOG_FILE), line + '\n', 'utf-8')
  } catch {
    // swallow — a vault op must not fail because logging failed
  }
}
