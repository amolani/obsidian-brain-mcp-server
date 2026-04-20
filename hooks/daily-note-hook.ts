#!/usr/bin/env node

// SessionStart hook: ensures today's daily note exists in the vault.
// Outputs a system reminder so Claude knows the daily note is ready.

import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const VAULT_PATH = process.env.VAULT_PATH
if (!VAULT_PATH) {
  console.log(JSON.stringify({ result: 'continue' }))
  process.exit(0)
}
const today = new Date().toISOString().split('T')[0]
const dailyDir = join(VAULT_PATH, 'Daily')
const dailyPath = join(dailyDir, `${today}.md`)

if (!existsSync(dailyPath)) {
  mkdirSync(dailyDir, { recursive: true })
  writeFileSync(dailyPath, `---
tags:
  - daily
datum: ${today}
---

# ${today}

## Aufgaben

- [ ]

## Notizen

## Gelernt
`, 'utf-8')

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
