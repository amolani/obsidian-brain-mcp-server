#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createReadStream, createWriteStream, fstatSync } from 'node:fs'
import { Socket } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Vault } from './vault.ts'
import {
  isToolAllowedInMode,
  parseMcpToolMode,
  toolDefinitionsForMode,
} from './server-tools.ts'
import { createToolHandler } from './tool-handlers.ts'

// ── Config ─────────────────────────────────────────────────────────────

const VAULT_PATH = process.env.VAULT_PATH
if (!VAULT_PATH) {
  process.stderr.write('obsidian-brain: VAULT_PATH environment variable is required\n')
  process.exit(1)
}
let toolMode
try {
  toolMode = parseMcpToolMode(process.env.OBSIDIAN_BRAIN_MCP_MODE)
} catch (error) {
  process.stderr.write(
    `obsidian-brain: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exit(1)
}
const exposedToolDefinitions = toolDefinitionsForMode(toolMode)

// ── Vault Init ─────────────────────────────────────────────────────────

const vault = new Vault(VAULT_PATH)
await vault.init()

function isNodeSocket(stream: Readable | Writable): boolean {
  return stream instanceof Socket
}

function createMcpInput(): Readable {
  try {
    // Some Node/container combinations expose a spawned fd 0 as a socket but
    // initialize process.stdin as an already-ended dummy Readable. Reading the
    // descriptor directly preserves normal MCP stdio framing in that case.
    if (fstatSync(process.stdin.fd).isSocket() && !isNodeSocket(process.stdin)) {
      return createReadStream('', { fd: process.stdin.fd, autoClose: false })
    }
  } catch {
    // Keep Node's standard stdin behavior when the descriptor cannot be probed.
  }
  return process.stdin
}

const mcpInput = createMcpInput()

function createMcpOutput(): Writable {
  try {
    // Apply the same narrow fallback to fd 1. A correctly initialized Node
    // pipe/socket remains untouched; only the dummy Writable is replaced.
    if (fstatSync(process.stdout.fd).isSocket() && !isNodeSocket(process.stdout)) {
      return createWriteStream('', { fd: process.stdout.fd, autoClose: false })
    }
  } catch {
    // Keep Node's standard stdout behavior when the descriptor cannot be probed.
  }
  return process.stdout
}

const mcpOutput = createMcpOutput()

// ── MCP Server ─────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'obsidian-brain', version: '0.2.0' },
  {
    capabilities: { tools: {} },
    instructions: toolMode === 'calibration-review'
      ? [
        'Obsidian Brain - getrennte, verblindete Kalibrierungs-Review-Oberfläche.',
        'Nur brain_calibration_review_batch und record_calibration_judgement verwenden.',
        'Während der Bewertung keine Produktionsnotizen, Suche, Kontexte oder Auswertung öffnen.',
      ].join('\n')
      : [
        'Obsidian Brain - Second Brain MCP Server.',
        'Vault-Sprache ist Deutsch. Notizen haben YAML-Frontmatter mit: status, tags, projekt, datum.',
        'Ordnerstruktur: Kunden/ (Kunden-Projekte), Technik/ (technisches Wissen), Referenz/ (unsortierte Referenz/Staging), Sicherheit/ (Befunde), Persönlich/, Daily/, Inbox/',
        '',
        'Workflow:',
        '1. vault_search ZUERST nutzen bevor neue Notizen erstellt werden (Duplikate vermeiden)',
        '2. Bestehendes updaten bevorzugen statt Neues erstellen',
        '3. capture für schnelles Festhalten, create_note für strukturierte Dokumente',
        '4. vault_overview für Gesamtüberblick, todo_list für offene Aufgaben',
      ].join('\n'),
  },
)

// ── Tool Definitions ───────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: exposedToolDefinitions,
}))

// ── Tool Handlers ──────────────────────────────────────────────────────

const toolHandler = createToolHandler(vault)
mcp.setRequestHandler(CallToolRequestSchema, async request => {
  if (!isToolAllowedInMode(toolMode, request.params.name)) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text:
          `Tool ${request.params.name} ist im MCP-Modus calibration-review nicht verfügbar`,
      }],
    }
  }
  return toolHandler(request)
})

// ── Graceful Shutdown ──────────────────────────────────────────────────

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('obsidian-brain: shutting down\n')
  vault.shutdown()
  setTimeout(() => process.exit(0), 1000)
}

mcpInput.on('end', shutdown)
mcpInput.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('unhandledRejection', (err) => {
  process.stderr.write(`obsidian-brain: unhandled rejection: ${err}\n`)
})

// ── Start ──────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport(mcpInput, mcpOutput))
