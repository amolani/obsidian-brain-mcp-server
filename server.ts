import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Vault } from './vault.ts'
import { TOOL_DEFINITIONS } from './server-tools.ts'
import { createToolHandler } from './tool-handlers.ts'

// ── Config ─────────────────────────────────────────────────────────────

const VAULT_PATH = process.env.VAULT_PATH
if (!VAULT_PATH) {
  process.stderr.write('obsidian-brain: VAULT_PATH environment variable is required\n')
  process.exit(1)
}

// ── Vault Init ─────────────────────────────────────────────────────────

const vault = new Vault(VAULT_PATH)
await vault.init()

// ── MCP Server ─────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'obsidian-brain', version: '0.2.0' },
  {
    capabilities: { tools: {} },
    instructions: [
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
  tools: TOOL_DEFINITIONS,
}))

// ── Tool Handlers ──────────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, createToolHandler(vault))

// ── Graceful Shutdown ──────────────────────────────────────────────────

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('obsidian-brain: shutting down\n')
  vault.shutdown()
  setTimeout(() => process.exit(0), 1000)
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('unhandledRejection', (err) => {
  process.stderr.write(`obsidian-brain: unhandled rejection: ${err}\n`)
})

// ── Start ──────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
