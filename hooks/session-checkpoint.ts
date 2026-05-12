#!/usr/bin/env node

// Session Checkpoint Hook - intended for long-running sessions.
// It can be wired to Claude Code PostToolUse/Notification-style events.
// The hook records lightweight session state and writes a checkpoint only
// when policy thresholds and debounce rules say the session is long enough.

import { appendFileSync, readFileSync } from 'node:fs'
import { loadClients } from '../config.ts'
import { evaluateLongSessionCheckpoint } from '../services/long-session-monitor.ts'
import { cleanupSessionStates, markSessionCheckpoint, recordSessionEvent } from '../services/session-state.ts'
import { loadBrainPolicy } from '../services/policy.ts'
import { Vault } from '../vault.ts'

if (!process.env.VAULT_PATH) {
  console.log(JSON.stringify({ result: 'continue' }))
  process.exit(0)
}

const VAULT_PATH = process.env.VAULT_PATH
const STATE_DIR = process.env.SESSION_CHECKPOINT_STATE_DIR || '/tmp/obsidian-brain-session-state'
const LOG_PATH = process.env.SESSION_CHECKPOINT_LOG || '/tmp/obsidian-brain-session-checkpoint.log'

interface TranscriptDigest {
  commandCount: number
  summary: string
}

function log(message: string): void {
  try { appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`) } catch {}
}

function detectClient(cwd: string): string | null {
  const cwdLower = cwd.toLowerCase()
  for (const [key, name] of Object.entries(loadClients())) {
    if (cwdLower.includes(key)) return name
  }
  return null
}

function digestTranscript(path?: string): TranscriptDigest {
  if (!path) return { commandCount: 0, summary: '' }
  const userTexts: string[] = []
  const assistantTexts: string[] = []
  let commandCount = 0
  try {
    const raw = readFileSync(path, 'utf-8')
    for (const line of raw.trim().split('\n')) {
      try {
        const obj = JSON.parse(line)
        const role = obj.role ?? obj.type ?? 'unknown'
        const content = obj.message?.content
        if (typeof content === 'string') {
          if (role === 'user') userTexts.push(content.trim())
          if (role === 'assistant') assistantTexts.push(content.trim())
          continue
        }
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'Bash') commandCount++
          if (block.type === 'text' && typeof block.text === 'string') {
            if (role === 'user') userTexts.push(block.text.trim())
            if (role === 'assistant') assistantTexts.push(block.text.trim())
          }
        }
      } catch {}
    }
  } catch {}

  const latestUser = userTexts.filter(text => text.length > 12).slice(-3)
  const latestAssistant = assistantTexts.filter(text => text.length > 50).slice(-2)
  const parts = [
    latestUser.length > 0 ? `## Letzte Anforderungen\n\n${latestUser.map(text => `- ${text.replace(/\s+/g, ' ').slice(0, 240)}`).join('\n')}` : '',
    latestAssistant.length > 0 ? `## Letzte Ergebnisse\n\n${latestAssistant.map(text => text.replace(/\s+/g, ' ').slice(0, 700)).join('\n\n---\n\n')}` : '',
  ].filter(Boolean)
  return {
    commandCount,
    summary: parts.join('\n\n') || 'Automatischer Langzeit-Checkpoint ohne auswertbares Transcript-Summary.',
  }
}

let input = ''
const timeout = setTimeout(() => process.exit(0), 12000)

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => input += chunk)
process.stdin.on('end', async () => {
  clearTimeout(timeout)

  try {
    const data = JSON.parse(input || process.env.SESSION_CHECKPOINT_INPUT_JSON || '{}')
    const sessionId = String(data.session_id ?? data.sessionId ?? '')
    if (!sessionId) {
      console.log(JSON.stringify({ result: 'continue' }))
      process.exit(0)
    }

    const policy = loadBrainPolicy()
    const cwd = String(data.cwd ?? '')
    const client = detectClient(cwd)
    const transcript = digestTranscript(typeof data.transcript_path === 'string' ? data.transcript_path : undefined)
    const toolName = String(data.tool_name ?? data.toolName ?? data.tool?.name ?? '')
    const commandDelta = transcript.commandCount > 0 ? undefined : toolName === 'Bash' ? 1 : 0
    const state = recordSessionEvent({
      stateDir: STATE_DIR,
      sessionId,
      cwd,
      client,
      commandCount: transcript.commandCount > 0 ? transcript.commandCount : undefined,
      commandDelta,
    })
    cleanupSessionStates(STATE_DIR)

    const decision = evaluateLongSessionCheckpoint(state, policy)
    if (!decision.shouldCheckpoint) {
      log(`skip ${sessionId.slice(0, 8)}: ${decision.reasons.join(', ')}`)
      console.log(JSON.stringify({ result: 'continue' }))
      process.exit(0)
    }

    const vault = new Vault(VAULT_PATH)
    try {
      await vault.init()
      const runAutoBuild = policy.automation.mode === 'auto_build' && policy.automation.duringSession.runAutoBuildOnCheckpoint
      const checkpoint = vault.brainCheckpoint({
        title: `Long Session Checkpoint ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
        summary: [
          transcript.summary,
          '',
          '## Checkpoint-Auslöser',
          decision.reasons.map(reason => `- ${reason}`).join('\n'),
          `- Commands gesamt: ${state.commandCount}`,
        ].join('\n'),
        client: client ?? undefined,
        runAutoBuild,
        dryRun: false,
      })
      markSessionCheckpoint({
        stateDir: STATE_DIR,
        sessionId,
        path: checkpoint.path,
        autoBuildRan: runAutoBuild,
      })
      log(`checkpoint ${sessionId.slice(0, 8)}: ${checkpoint.path}`)
      console.log(JSON.stringify({
        result: 'continue',
        message: `Long-Session Checkpoint geschrieben: ${checkpoint.path}${runAutoBuild ? ' (Auto-Build ausgeführt)' : ''}`,
      }))
    } finally {
      vault.shutdown()
    }
  } catch (err) {
    log(`error: ${err}`)
    console.log(JSON.stringify({ result: 'continue' }))
  }

  process.exit(0)
})
process.stdin.resume()
