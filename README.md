# Obsidian Brain MCP Server

A Second Brain MCP server for Obsidian vaults. Works directly on the filesystem — no Obsidian process required. Built for technicians and sysadmins who want their knowledge to accumulate automatically as they work.

## Features

**Read & Navigate**
- `vault_search` — structured search (full-text + tags + folder + status)
- `semantic_search` — local semantic-style search with weighted note vectors, snippets, config aliases/categories, and filters
- `semantic_index_status` / `rebuild_semantic_index` — inspect and rebuild the local semantic vector cache
- `build_context_pack` — compact working context for a query with semantic hits, linked notes, TODOs, citations, and next actions
- `recall_context` — manual, read-only working-memory recall; nothing is stored or injected automatically
- `get_note_context` — full note context with backlinks & related notes
- `vault_overview` — stats, tags, recent changes, orphans, stale notes
- `todo_list` — aggregate open TODOs across the vault
- `suggest_links` — find unlinked mentions between notes
- `suggest_links_v2` — confidence-scored link suggestions with snippets, aliases, tag/folder proximity, and per-note caps
- `apply_link_suggestions` — dry-run-first executor for high-confidence unlinked mentions
- `weekly_review` — summary of the past 7 days
- `daily_note` — create/append today's daily note

**Create & Capture**
- `create_note` — structured notes from templates (kunde, referenz, troubleshooting, learning, daily)
- `capture` — compatibility wrapper for quick capture
- `capture_v2` — smart capture with unified client/Technik classification, tag normalization, dry-run previews, and `fast`/`strict`/`review` modes
- `generate_runbook` — clean step-by-step guide from auto-captured sessions
- `extract_troubleshooting_pattern` / `promote_capture_to_runbook` / `generate_postmortem` — dry-run-first incident extraction from captures and troubleshooting notes
- `build_customer_context` / `build_project_dashboard` — generate customer dashboards with notes, TODOs, recent changes, runbooks, captures, tags, and issues

**Maintenance (Analyzer → Recommender → Executor)**
- `find_duplicates` — fuzzy match on title, content, tags (with confidence scores)
- `merge_duplicates` — dry-run-first duplicate merge workflow with tag/frontmatter union, source references, archive move, and action logging
- `rename_note` — dry-run-first rename/move refactor that updates H1/title metadata, aliases, wikilinks, frontmatter path refs, and action log
- `triage_note` / `triage_inbox` — dry-run-first inbox triage with classification, tag normalization, target folders, duplicate review, and link suggestions
- `accept_review_item` / `reject_review_item` / `snooze_review_item` / `apply_all_safe_fixes` — review-queue workflow actions with dry-run-first safe executors
- `score_note_quality` / `list_low_quality_notes` — read-only quality scoring for title, metadata, tags, links, TODOs, structure, content density, and freshness
- `suggest_lifecycle_updates` / `apply_lifecycle_updates` — dry-run-first lifecycle automation for status transitions such as missing status → `aktiv` or stale notes → `archiviert`
- `find_broken_links` / `fix_broken_links` — detect and repair renamed-file links
- `lint_frontmatter` / `fix_frontmatter` — profile-aware schemas for Kunde, Referenz, Troubleshooting, Learning, Runbook, Daily, Maintenance, Auto-Capture, and MOC notes
- `generate_mocs` — Maps of Content with live Dataview queries per folder
- `run_safe_maintenance` — dry-run-first batch for safe executors: frontmatter, broken links, link suggestions, lifecycle, MOCs, semantic index
- `organize_referenz` — auto-sort flat `Referenz/` into `Technik/{category}/{sub}/`
- `list_suggestions` / `promote_suggestion` — review and accept auto-detected new clients & subcategories
- `run_vault_maintenance` — orchestrates all analyzers and writes a review queue

**Automated background workflow** (via Claude Code hooks)
- **SessionStart** — ensures daily note exists, detects client from CWD, auto-organizes
- **Stop** — Knowledge Harvester reads the session transcript, extracts procedures and error→fix cycles, writes a structured note automatically

## How it works

The server indexes your vault on start and keeps an in-memory index of:
- Notes (with parsed frontmatter, links, TODOs, tags)
- Tag index (tag → notes)
- Backlink index (note → notes that link to it)

It watches the vault directory for changes and incrementally updates the index.

Classification is rule-based (not LLM-based), using:
- `clients.json` — known clients and their keyword aliases
- `technik-categories.json` — tech categories with subcategories (Linuxmuster/Linbo, Docker/Traefik, etc.)
- `tag-aliases.json` — tag normalization map (lmn → linuxmuster, pve → proxmox, …)
- `tech-terms.json` — auto-tag vocabulary for captures

All four files are user-editable JSON.

## Requirements

- Node.js ≥ 22 (native TypeScript support) or Node ≥ 18 with `tsx`
- An Obsidian vault (structure doesn't matter — the server adapts)

## Installation

### 1. Clone and install

```bash
git clone https://github.com/amolani/obsidian-brain-mcp-server.git
cd obsidian-brain-mcp-server
npm install
```

### 2. Configure your vault path

Set via environment variable:

```bash
export VAULT_PATH=/path/to/your/obsidian/vault
```

### 3. Register the MCP server with Claude Code

Globally (available in every session):

```bash
claude mcp add-json -s user obsidian-brain '{
  "command": "node",
  "args": ["/absolute/path/to/obsidian-brain-mcp-server/server.ts"],
  "env": {
    "VAULT_PATH": "/path/to/your/obsidian/vault"
  }
}'
```

For Node < 22, use `tsx` instead:

```bash
npm install -g tsx
claude mcp add-json -s user obsidian-brain '{
  "command": "tsx",
  "args": ["/absolute/path/to/obsidian-brain-mcp-server/server.ts"],
  "env": {
    "VAULT_PATH": "/path/to/your/obsidian/vault"
  }
}'
```

Verify: `claude mcp list` should show `obsidian-brain: ✓ Connected`.

### 4. (Optional) Register hooks for automation

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/obsidian-brain-mcp-server/hooks/session-context.ts",
            "timeout": 8
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/obsidian-brain-mcp-server/hooks/knowledge-harvester.ts",
            "timeout": 15,
            "async": true
          }
        ]
      }
    ]
  }
}
```

Hook environment requires `VAULT_PATH` to be set (inherited from your shell or set via Claude Code env config).

### 5. (Optional) Add client instructions

Create `CLAUDE.md` in your vault or globally at `~/.claude/CLAUDE.md`:

```markdown
The obsidian-brain MCP server is available. Use it as the primary source of knowledge.
- Search knowledge → vault_search
- Get note context → get_note_context
- Capture new knowledge → capture
```

## Configuration files

### `clients.json`

```json
{
  "AKBD": ["AKBD", "albert-kleiner"],
  "Neckartenzlingen": ["naik"],
  "Merian": ["niarian"]
}
```

Keys = canonical client names. Values = keyword aliases matched against CWD and content.

### `technik-categories.json`

```json
{
  "Linuxmuster": {
    "keywords": ["linuxmuster", "sophomorix", "lmn"],
    "filenameHints": ["lmn", "linuxmuster"],
    "priority": 10,
    "subcategories": {
      "Linbo": {
        "keywords": ["linbo", "linbofs", "patchclass"],
        "filenameHints": ["linbo"]
      }
    }
  }
}
```

### `tag-aliases.json`

```json
{
  "lmn": "linuxmuster",
  "pve": "proxmox",
  "ad": "active-directory"
}
```

Left side = alternate spelling. Right side = canonical form.

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `VAULT_PATH` | **Required.** Path to your Obsidian vault root. | — |
| `CLIENTS_PATH` | Override path to `clients.json`. | `{project}/clients.json` |
| `TECHNIK_CATEGORIES_PATH` | Override path to `technik-categories.json`. | `{project}/technik-categories.json` |
| `TAG_ALIASES_PATH` | Override path to `tag-aliases.json`. | `{project}/tag-aliases.json` |
| `HARVESTER_LOG` | Knowledge Harvester log file. | `/tmp/knowledge-harvester.log` |
| `HARVESTER_STATE_DIR` | Per-session state dir (prevents re-processing). | `/tmp/knowledge-harvester-state` |
| `HARVESTER_SUGGESTIONS_LOG` | Log for client/subcategory suggestions. | `/tmp/knowledge-harvester-suggestions.log` |
| `TECHNIK_SUGGESTIONS_LOG` | Log for category suggestions. | `/tmp/technik-suggestions.log` |

## Usage

Once registered, just work normally in Claude Code. Ask things like:

- "What do we know about Neckartenzlingen?"
- "Show me all open TODOs."
- "Save this: The DHCP server needs to run on the firewall, not the LMN."
- "Generate a runbook for the linuxmuster installation."
- "Run vault maintenance."

The Knowledge Harvester runs automatically after each Claude response. If the session had substantial work (≥ 3 bash commands, ≥ 2 procedures with outcomes), it writes a capture note to the appropriate folder.

## Recommended Workflow

Use the vault as a dry-run-first operating loop:

1. Start work normally in Claude Code. The SessionStart hook creates today's Daily note, detects the client from your current folder when possible, and runs the same Referenz→Technik organization logic as the MCP tool.
2. Before creating new knowledge, search first with `vault_search` or `semantic_search`. Use `recall_context` when you explicitly want manual working-memory recall for a topic.
3. Capture rough knowledge with `capture_v2` in `review` or `dry_run` mode for important notes, then apply once the suggested folder/title/tags look right. Use old `capture` only as the quick compatibility path.
4. During work, use `daily_note` for lightweight chronological notes and TODOs. Use `todo_list` or `weekly_review` to pull open work back into focus.
5. After substantial terminal work, let the Stop hook harvest procedures automatically. For reusable operational docs, run `generate_runbook` against the topic/client after captures exist.
6. For maintenance, run `run_safe_maintenance` first as dry-run. Apply individual executors only after reviewing changes: lifecycle updates, link suggestions, frontmatter fixes, broken-link fixes, MOCs, and semantic-index rebuild.
7. Periodically run `organize_referenz` dry-run, then apply. Flat `Referenz/` is treated as staging; durable technical knowledge should end up in `Technik/{category}/{sub}/`.

## Folder conventions

The server assumes (but doesn't require) this structure:

```
YourVault/
├── Kunden/                # Client projects
│   └── {ClientName}/
├── Technik/               # Technical reference
│   ├── Linuxmuster/
│   │   ├── Linbo/
│   │   └── Sophomorix/
│   ├── Docker/
│   └── Proxmox/
├── Daily/                 # Daily notes (auto-created)
├── Maintenance/           # Review queues (auto-generated)
├── Inbox/                 # Unsorted captures
├── Referenz/              # Misc reference (organized into Technik/ automatically)
└── Persönlich/            # Private
```

## Development

### Run tests

```bash
npm test
```

70+ tests cover vault indexing, link resolution, search, templates, capture categorization, duplicate detection, broken links, frontmatter linting, MOC generation, and the Knowledge Harvester end-to-end.

### Project structure

```
obsidian-brain-mcp-server/
├── server.ts                      # MCP server entry point, tool registration
├── vault.ts                       # Core Vault class (indexing, search, maintenance)
├── technik-categories.ts          # Category classifier
├── clients.json                   # Client definitions (editable)
├── technik-categories.json        # Category rules (editable)
├── tag-aliases.json               # Tag normalization (editable)
├── hooks/
│   ├── session-context.ts         # SessionStart hook
│   ├── knowledge-harvester.ts     # Stop hook (captures knowledge)
│   └── daily-note-hook.ts         # Simple daily note creator
└── tests/
    ├── vault.test.ts
    ├── categories.test.ts
    ├── harvester.test.ts
    └── fixtures/
```

### Architecture

- **Analyzer layer**: `find_duplicates`, `find_broken_links`, `lint_frontmatter`, `generate_mocs` (dry-run), `getOverview` — pure read, no side effects.
- **Recommender layer**: `run_vault_maintenance` orchestrates analyzers and writes a review queue to `Maintenance/{date}-review.md`.
- **Executor layer**: `fix_broken_links`, `fix_frontmatter`, `organize_referenz`, `generate_mocs`, `apply_lifecycle_updates`, `apply_link_suggestions`, `run_safe_maintenance` — default to `dry_run=true` for safety.

All mutations respect the `quelle: moc-generator` / `quelle: knowledge-harvester` frontmatter marker so user-authored notes are never overwritten.

## License

MIT
