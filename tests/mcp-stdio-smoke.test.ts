import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { cleanupVault, createTempVault, writeNote } from './helpers.ts'

const SERVER_PATH = fileURLToPath(new URL('../server.ts', import.meta.url))
const REQUEST_TIMEOUT_MS = 5_000
const SHUTDOWN_TIMEOUT_MS = 7_000

async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

test('server.ts serves ListTools and a read-only tool over MCP stdio', { timeout: 30_000 }, async (t) => {
  const vaultPath = createTempVault()
  const notePath = join(vaultPath, 'Smoke.md')
  writeNote(vaultPath, {
    path: 'Smoke.md',
    frontmatter: { status: 'aktiv', tags: ['smoke-test'] },
    title: 'MCP Stdio Smoke',
    body: 'This note must remain unchanged by the read-only smoke test.',
  })
  const originalNote = readFileSync(notePath, 'utf-8')

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: dirname(SERVER_PATH),
    env: { VAULT_PATH: vaultPath },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'obsidian-brain-stdio-smoke', version: '1.0.0' })
  const protocolErrors: Error[] = []
  client.onerror = error => protocolErrors.push(error)

  let resolveServerClosed: (() => void) | undefined
  const serverClosed = new Promise<void>(resolve => {
    resolveServerClosed = resolve
  })
  transport.onclose = () => resolveServerClosed?.()

  let serverPid: number | null = null
  let stopped = false
  t.after(async () => {
    if (!stopped) {
      const cleanupPid = serverPid ?? transport.pid
      try {
        await within(client.close(), SHUTDOWN_TIMEOUT_MS, 'MCP server cleanup')
        await within(serverClosed, SHUTDOWN_TIMEOUT_MS, 'MCP server process cleanup')
      } catch {
        if (cleanupPid !== null) {
          try {
            process.kill(cleanupPid, 'SIGKILL')
          } catch {
            // The process may already have exited between the timeout and cleanup.
          }
        }
      }
    }
    cleanupVault(vaultPath)
  })

  await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
  serverPid = transport.pid
  assert.ok(serverPid, 'stdio transport must spawn server.ts as a child process')
  assert.equal(client.getServerVersion()?.name, 'obsidian-brain')

  const listed = await client.listTools({}, { timeout: REQUEST_TIMEOUT_MS })
  const overviewTool = listed.tools.find(tool => tool.name === 'vault_overview')
  assert.ok(overviewTool, 'ListTools must expose vault_overview')
  assert.deepEqual(overviewTool.inputSchema.required ?? [], [])
  assert.equal(
    listed.tools.some(tool => tool.name === 'brain_calibration_review_batch'),
    false,
  )
  assert.equal(
    listed.tools.some(tool => tool.name === 'record_calibration_judgement'),
    false,
  )

  const overview = CallToolResultSchema.parse(
    await client.callTool(
      { name: 'vault_overview', arguments: {} },
      CallToolResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    ),
  )
  assert.notEqual(overview.isError, true)
  const overviewText = overview.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n')
  assert.match(overviewText, /# Vault-Übersicht/)
  assert.match(overviewText, /\*\*Notizen gesamt:\*\* 1/)
  assert.match(overviewText, /MCP Stdio Smoke/)

  const reviewerOnly = CallToolResultSchema.parse(
    await client.callTool(
      { name: 'brain_calibration_review_batch', arguments: {} },
      CallToolResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    ),
  )
  assert.equal(reviewerOnly.isError, true)
  assert.match(
    reviewerOnly.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n'),
    /MCP-Modus default nicht verfügbar/,
  )

  assert.equal(readFileSync(notePath, 'utf-8'), originalNote)
  assert.deepEqual(readdirSync(vaultPath).sort(), ['Smoke.md'])
  assert.deepEqual(protocolErrors, [])

  await within(client.close(), SHUTDOWN_TIMEOUT_MS, 'MCP client close')
  await within(serverClosed, SHUTDOWN_TIMEOUT_MS, 'MCP server process exit')
  stopped = true
  assert.equal(transport.pid, null)
})

test('calibration-review MCP mode hides and rejects production-vault tools', {
  timeout: 30_000,
}, async (t) => {
  const vaultPath = createTempVault()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: dirname(SERVER_PATH),
    env: {
      VAULT_PATH: vaultPath,
      OBSIDIAN_BRAIN_MCP_MODE: 'calibration-review',
      BRAIN_CALIBRATION_REVIEWER_ID: 'reviewer-smoke-01',
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'obsidian-brain-review-smoke', version: '1.0.0' })
  let resolveServerClosed: (() => void) | undefined
  const serverClosed = new Promise<void>(resolve => {
    resolveServerClosed = resolve
  })
  transport.onclose = () => resolveServerClosed?.()
  let stopped = false
  t.after(async () => {
    if (!stopped) {
      const cleanupPid = transport.pid
      try {
        await within(client.close(), SHUTDOWN_TIMEOUT_MS, 'review MCP cleanup')
        await within(serverClosed, SHUTDOWN_TIMEOUT_MS, 'review MCP process cleanup')
      } catch {
        if (cleanupPid !== null) {
          try {
            process.kill(cleanupPid, 'SIGKILL')
          } catch {
            // The process may already have exited.
          }
        }
      }
    }
    cleanupVault(vaultPath)
  })

  await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS })
  const listed = await client.listTools({}, { timeout: REQUEST_TIMEOUT_MS })
  assert.deepEqual(
    listed.tools.map(tool => tool.name),
    ['brain_calibration_review_batch', 'record_calibration_judgement'],
  )
  for (const tool of listed.tools) {
    assert.equal('reviewer' in (tool.inputSchema.properties ?? {}), false)
    assert.equal(tool.inputSchema.required?.includes('reviewer') ?? false, false)
  }
  const judgementTool = listed.tools.find(tool =>
    tool.name === 'record_calibration_judgement')
  assert.ok(judgementTool)
  assert.equal(
    'recorded_at' in (judgementTool.inputSchema.properties ?? {}),
    false,
  )
  assert.equal(
    judgementTool.inputSchema.required?.includes('recorded_at') ?? false,
    false,
  )

  const reviewBatch = CallToolResultSchema.parse(
    await client.callTool(
      { name: 'brain_calibration_review_batch', arguments: {} },
      CallToolResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    ),
  )
  assert.notEqual(reviewBatch.isError, true)
  assert.match(
    reviewBatch.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n'),
    /Reviewer: reviewer-smoke-01/,
  )

  const mismatchedReviewer = CallToolResultSchema.parse(
    await client.callTool(
      {
        name: 'brain_calibration_review_batch',
        arguments: { reviewer: 'reviewer-intruder' },
      },
      CallToolResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    ),
  )
  assert.equal(mismatchedReviewer.isError, true)
  assert.match(
    mismatchedReviewer.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n'),
    /servergebundenen Reviewer-ID/,
  )

  const boundJudgement = CallToolResultSchema.parse(
    await client.callTool(
      {
        name: 'record_calibration_judgement',
        arguments: {
          review_token: `brt-${'0'.repeat(32)}`,
          useful: true,
          supported: true,
        },
      },
      CallToolResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    ),
  )
  assert.equal(boundJudgement.isError, true)
  const boundJudgementText = boundJudgement.content
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n')
  assert.doesNotMatch(boundJudgementText, /reviewer.*erforderlich/i)
  assert.doesNotMatch(boundJudgementText, /reviewer.*gültige opake/i)
  assert.doesNotMatch(boundJudgementText, /recordedAt.*erforderlich/i)
  assert.doesNotMatch(boundJudgementText, /recordedAt.*UTC/i)

  const mismatchedJudgement = CallToolResultSchema.parse(
    await client.callTool(
      {
        name: 'record_calibration_judgement',
        arguments: {
          review_token: `brt-${'0'.repeat(32)}`,
          useful: true,
          supported: true,
          reviewer: 'reviewer-intruder',
        },
      },
      CallToolResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    ),
  )
  assert.equal(mismatchedJudgement.isError, true)
  assert.match(
    mismatchedJudgement.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n'),
    /servergebundenen Reviewer-ID/,
  )

  const callerTimestamp = CallToolResultSchema.parse(
    await client.callTool(
      {
        name: 'record_calibration_judgement',
        arguments: {
          review_token: `brt-${'0'.repeat(32)}`,
          useful: true,
          supported: true,
          recorded_at: '2020-01-01T00:00:00.000Z',
        },
      },
      CallToolResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    ),
  )
  assert.equal(callerTimestamp.isError, true)
  assert.match(
    callerTimestamp.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n'),
    /recorded_at ist nicht erlaubt/,
  )

  const forbidden = CallToolResultSchema.parse(
    await client.callTool(
      { name: 'vault_overview', arguments: {} },
      CallToolResultSchema,
      { timeout: REQUEST_TIMEOUT_MS },
    ),
  )
  assert.equal(forbidden.isError, true)
  assert.match(
    forbidden.content
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join('\n'),
    /calibration-review nicht verfügbar/,
  )

  await within(client.close(), SHUTDOWN_TIMEOUT_MS, 'review MCP client close')
  await within(serverClosed, SHUTDOWN_TIMEOUT_MS, 'review MCP server exit')
  stopped = true
})

test('calibration-review MCP mode fails closed without a bound reviewer id', {
  timeout: 15_000,
}, async (t) => {
  const vaultPath = createTempVault()
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: dirname(SERVER_PATH),
    env: {
      VAULT_PATH: vaultPath,
      OBSIDIAN_BRAIN_MCP_MODE: 'calibration-review',
    },
    stderr: 'pipe',
  })
  const stderrChunks: string[] = []
  const stderr = transport.stderr
  assert.ok(stderr)
  const stderrEnded = new Promise<void>(resolve => {
    stderr.on('end', resolve)
  })
  stderr.on('data', chunk => stderrChunks.push(String(chunk)))
  let resolveServerClosed: (() => void) | undefined
  const serverClosed = new Promise<void>(resolve => {
    resolveServerClosed = resolve
  })
  transport.onclose = () => resolveServerClosed?.()

  t.after(async () => {
    await transport.close()
    cleanupVault(vaultPath)
  })

  await transport.start()
  await within(serverClosed, SHUTDOWN_TIMEOUT_MS, 'review MCP fail-closed exit')
  await within(stderrEnded, SHUTDOWN_TIMEOUT_MS, 'review MCP fail-closed stderr')
  assert.equal(transport.pid, null)
  assert.match(
    stderrChunks.join(''),
    /BRAIN_CALIBRATION_REVIEWER_ID ist im MCP-Modus calibration-review erforderlich/,
  )
})
