#!/usr/bin/env node

// SessionStart hook: ensures today's daily note exists in the vault.
// Outputs a system reminder so Claude knows the daily note is ready.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { appendActionLog } from '../services/action-log.ts'
import { atomicWriteFileSync } from '../services/atomic-file.ts'
import { assertCanWriteTool, loadBrainPolicy } from '../services/policy.ts'
import { vaultJoin } from '../services/vault-paths.ts'

const VAULT_PATH = process.env.VAULT_PATH
if (!VAULT_PATH) {
  console.log(JSON.stringify({ result: 'continue' }))
  process.exit(0)
}
const today = new Date().toISOString().split('T')[0]
const dailyRelativePath = `Daily/${today}.md`
let dailyPath: string
try {
  dailyPath = vaultJoin(VAULT_PATH, dailyRelativePath)
} catch (error) {
  writeFileSync(2, `daily-note-hook: ${error instanceof Error ? error.message : String(error)}\n`)
  writeFileSync(1, `${JSON.stringify({ result: 'continue' })}\n`)
  process.exit(0)
}
const dailyDir = dirname(dailyPath)

if (!loadBrainPolicy().hooks.createDailyNote) {
  console.log(JSON.stringify({ result: 'continue' }))
} else if (!existsSync(dailyPath)) {
  assertCanWriteTool('create_daily_note', [dailyRelativePath])
  mkdirSync(dailyDir, { recursive: true })
  atomicWriteFileSync(dailyPath, `---
tags:
  - daily
datum: ${today}
---

# ${today}

## Aufgaben

- [ ]

## Notizen

## Gelernt
`)
  appendActionLog(VAULT_PATH, {
    tool: 'create_daily_note',
    mode: 'apply',
    targets: [dailyRelativePath],
    summary: `Daily Note ${today} erstellt`,
  })

  // Output for Claude to see
  console.log(JSON.stringify({
    result: 'continue',
    message: `Daily Note für ${today} erstellt: Daily/${today}.md`
  }))
} else {
  console.log(JSON.stringify({
    result: 'continue'
  }))
}
