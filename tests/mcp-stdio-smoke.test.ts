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

  assert.equal(readFileSync(notePath, 'utf-8'), originalNote)
  assert.deepEqual(readdirSync(vaultPath).sort(), ['Smoke.md'])
  assert.deepEqual(protocolErrors, [])

  await within(client.close(), SHUTDOWN_TIMEOUT_MS, 'MCP client close')
  await within(serverClosed, SHUTDOWN_TIMEOUT_MS, 'MCP server process exit')
  stopped = true
  assert.equal(transport.pid, null)
})
