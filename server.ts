import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Vault, type LintIssue } from './vault.ts'
import { listSuggestions, promoteTechnikSuggestion, promoteClientSuggestion } from './suggestions.ts'

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
      'Ordnerstruktur: Kunden/ (Kunden-Projekte), Referenz/ (Technisches Wissen), Sicherheit/ (Befunde), Persönlich/, Daily/, Inbox/',
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
  tools: [
    {
      name: 'vault_search',
      description:
        'Search the Obsidian vault with structured filters. Supports full-text search combined with tag, folder, and status filters. Returns matching notes sorted by relevance.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Full-text search query (searches title, tags, content)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by tags - note must have ALL specified tags',
          },
          folder: {
            type: 'string',
            description: 'Filter by folder path (e.g. "Kunden", "Referenz", "Kunden/Merian")',
          },
          status: {
            type: 'string',
            description: 'Filter by frontmatter status (e.g. "aktiv", "planung")',
          },
        },
      },
    },
    {
      name: 'get_note_context',
      description:
        'Get complete context for a note: content, frontmatter metadata, backlinks (who links here), outgoing links, and related notes by shared tags. Accepts relative path or note title.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description:
              'Relative path (e.g. "Kunden/Merian/Dokumentation.md") or note title (e.g. "Dokumentation")',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'create_note',
      description:
        'Create a new note from a template with auto-generated frontmatter. Templates: kunde (client project), referenz (technical reference), troubleshooting (problem/solution), learning (knowledge capture), daily (daily note).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: {
            type: 'string',
            description: 'Note title (also used as filename)',
          },
          template: {
            type: 'string',
            enum: ['kunde', 'referenz', 'troubleshooting', 'learning', 'daily'],
            description: 'Template type determining structure and auto-folder',
          },
          content: {
            type: 'string',
            description: 'Optional content to append after the template structure',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional tags (template-specific tags are added automatically)',
          },
          folder: {
            type: 'string',
            description: 'Override auto-folder placement (e.g. "Kunden/Merian")',
          },
        },
        required: ['title', 'template'],
      },
    },
    {
      name: 'capture',
      description:
        'Quick knowledge capture with auto-categorization. Automatically detects client names, tech terms, and security topics to place the note in the right folder with appropriate tags. Use this for "save this now, organize later" moments.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: {
            type: 'string',
            description: 'The knowledge content to capture',
          },
          category: {
            type: 'string',
            enum: ['kunde', 'referenz', 'sicherheit', 'persönlich'],
            description: 'Optional category hint to override auto-detection',
          },
        },
        required: ['content'],
      },
    },
    {
      name: 'vault_overview',
      description:
        'Get vault statistics: total notes, notes per folder, tag cloud with counts, recently modified notes, orphan notes (no incoming links), and open TODO count.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'todo_list',
      description:
        'Get all open TODO items (- [ ]) across the vault, grouped by file. Optionally filter by folder.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          folder: {
            type: 'string',
            description: 'Optional folder filter (e.g. "Kunden" to see only client TODOs)',
          },
        },
      },
    },
    {
      name: 'suggest_links',
      description:
        'Find unlinked mentions: notes that reference other note titles in their content but don\'t have a [[link]] to them. Helps improve vault connectivity.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'weekly_review',
      description:
        'Generate a weekly review: notes modified/created in the last 7 days, open vs completed TODOs, and active projects. Great for status updates and reflection.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'daily_note',
      description:
        'Get or create today\'s daily note. Optionally append content to it. Creates the note with a daily template if it doesn\'t exist yet.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          append: {
            type: 'string',
            description: 'Content to append to today\'s daily note',
          },
        },
      },
    },
    {
      name: 'generate_runbook',
      description:
        'Generate a clean, step-by-step Runbook from all auto-captured session notes for a topic/client. Combines procedures, workarounds, and summaries into a reusable guide. Saves it in the correct Kunden/ folder automatically.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          topic: {
            type: 'string',
            description: 'Topic or client name (e.g. "Neckartenzlingen", "linuxmuster")',
          },
          folder: {
            type: 'string',
            description: 'Optional override for output folder (auto-detected from topic if omitted)',
          },
        },
        required: ['topic'],
      },
    },
    {
      name: 'organize_referenz',
      description:
        'Organize the flat Referenz/ folder into structured Technik/ subcategories (Linuxmuster, Docker, Proxmox, Netzwerk, Windows, Ubuntu, Web, SSH, Git). Classifies notes by tags, filename, and content. Use dry_run=true first to preview changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          dry_run: {
            type: 'boolean',
            description: 'If true, only shows what would be moved without actually moving files (default: false)',
          },
        },
      },
    },
    {
      name: 'find_duplicates',
      description:
        'Find potentially duplicate notes via title/content/tag similarity. Returns candidates with confidence (high/medium/low) and suggestion (merge/review/link). Pure analyzer — makes no changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          min_score: {
            type: 'number',
            description: 'Minimum similarity score (0-100) to report. Default 40. Use 60+ for only strong matches.',
          },
        },
      },
    },
    {
      name: 'find_broken_links',
      description:
        'Scan vault for broken [[wiki-links]] that don\'t resolve to any note. Returns each broken link with auto-fix candidates (high/medium/low confidence). Pure analyzer — makes no changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'list_suggestions',
      description:
        'List pending suggestions from the harvester logs: new client candidates and new Technik subcategory candidates. Shows frequency and context for each. Use this before promote_suggestion to decide which to accept.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'promote_suggestion',
      description:
        'Promote a suggested client or Technik subcategory to the respective JSON config. Writes the entry and removes matching suggestions from the log. Subsequent captures will auto-categorize correctly.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          type: { type: 'string', enum: ['technik', 'client'], description: 'Which suggestion type to promote.' },
          candidate: { type: 'string', description: 'The candidate keyword as it appeared in the log (e.g. "edulution-satellite").' },
          parent: { type: 'string', description: 'For type=technik: parent category (e.g. "Docker", "Linuxmuster").' },
          canonical: { type: 'string', description: 'Canonical name for the folder (defaults to TitleCase of candidate).' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional keywords/aliases to match (candidate itself is always included).',
          },
        },
        required: ['type', 'candidate'],
      },
    },
    {
      name: 'run_vault_maintenance',
      description:
        'Run ALL maintenance analyzers (duplicates, broken links, lint, missing MOCs, stale/orphan notes) and write a consolidated review-queue report as a Markdown note in Maintenance/{date}-review.md. Pure analyzer — no files modified except the report itself.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'generate_mocs',
      description:
        'Generate Maps of Content (_MOC.md) for Kunden/ and Technik/ folders with >= 2 notes. Each MOC contains live Dataview queries for notes, todos, and recent changes. Overwrites only MOCs marked as auto-generated. Use dry_run=true to preview.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          dry_run: { type: 'boolean', description: 'Default false. If true, shows what would be created/updated without writing.' },
          min_notes: { type: 'number', description: 'Minimum notes per folder to generate MOC (default 2).' },
        },
      },
    },
    {
      name: 'lint_frontmatter',
      description:
        'Scan all notes for frontmatter issues: missing/invalid status, non-ISO dates, tag inconsistencies, typo field names. Returns issue list with severity (error/warning/info) and auto-fix suggestions. Pure analyzer.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'fix_frontmatter',
      description:
        'Apply safe auto-fixes to frontmatter: normalize tags (via aliases), dedupe, lowercase field names, add missing status. Use dry_run=true (default) first. Never changes note body.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          dry_run: { type: 'boolean', description: 'Default true. Set false to apply.' },
        },
      },
    },
    {
      name: 'fix_broken_links',
      description:
        'Auto-repair broken [[wiki-links]] that have exactly ONE high-confidence candidate. Use dry_run=true (default) first to preview. Ambiguous links are skipped for manual review.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          dry_run: {
            type: 'boolean',
            description: 'If true (default), only shows what would be fixed. Set false to apply changes.',
          },
        },
      },
    },
  ],
}))

// ── Tool Handlers ──────────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'vault_search': {
        const results = vault.search({
          query: args.query as string | undefined,
          tags: args.tags as string[] | undefined,
          folder: args.folder as string | undefined,
          status: args.status as string | undefined,
        })

        if (results.length === 0) {
          return { content: [{ type: 'text', text: 'Keine Treffer gefunden.' }] }
        }

        const text = results
          .map((r) => {
            const meta = [
              r.status ? `status: ${r.status}` : null,
              r.projekt ? `projekt: ${r.projekt}` : null,
              r.datum ? `datum: ${r.datum}` : null,
              r.tags.length > 0 ? `tags: ${r.tags.join(', ')}` : null,
              r.matchCount > 0 ? `relevanz: ${r.matchCount}` : null,
            ]
              .filter(Boolean)
              .join(' | ')
            return `**${r.title}** (${r.path})\n  ${meta}`
          })
          .join('\n\n')

        return {
          content: [{ type: 'text', text: `${results.length} Treffer:\n\n${text}` }],
        }
      }

      case 'get_note_context': {
        const path = args.path as string
        const ctx = vault.getNoteContext(path)

        if (!ctx) {
          return {
            content: [{ type: 'text', text: `Note nicht gefunden: ${path}` }],
            isError: true,
          }
        }

        const sections = [
          `## Frontmatter\n${JSON.stringify(ctx.frontmatter, null, 2)}`,
          `## Content\n${ctx.content}`,
          ctx.backlinks.length > 0
            ? `## Backlinks (${ctx.backlinks.length})\n${ctx.backlinks.map((l) => `- [[${l.path}]] — ${l.title}`).join('\n')}`
            : '## Backlinks\nKeine.',
          ctx.outgoingLinks.length > 0
            ? `## Ausgehende Links (${ctx.outgoingLinks.length})\n${ctx.outgoingLinks.map((l) => `- [[${l.path}]] — ${l.title}`).join('\n')}`
            : '## Ausgehende Links\nKeine.',
          ctx.relatedByTags.length > 0
            ? `## Verwandte Notizen (${ctx.relatedByTags.length})\n${ctx.relatedByTags.map((l) => `- [[${l.path}]] — ${l.title}`).join('\n')}`
            : '## Verwandte Notizen\nKeine.',
        ]

        return { content: [{ type: 'text', text: sections.join('\n\n') }] }
      }

      case 'create_note': {
        const result = vault.createNote(
          args.title as string,
          args.template as string,
          args.content as string | undefined,
          args.tags as string[] | undefined,
          args.folder as string | undefined,
        )

        return {
          content: [
            {
              type: 'text',
              text: `Note erstellt: ${result.path}`,
            },
          ],
        }
      }

      case 'capture': {
        const result = vault.capture(
          args.content as string,
          args.category as string | undefined,
        )

        return {
          content: [
            {
              type: 'text',
              text: [
                `Erfasst: **${result.title}**`,
                `Pfad: ${result.path}`,
                `Ordner: ${result.folder}`,
                `Tags: ${result.tags.join(', ')}`,
              ].join('\n'),
            },
          ],
        }
      }

      case 'vault_overview': {
        const stats = vault.getOverview()

        const folderList = Object.entries(stats.notesByFolder)
          .sort((a, b) => b[1] - a[1])
          .map(([f, c]) => `  ${f}: ${c}`)
          .join('\n')

        const tagList = Object.entries(stats.allTags)
          .sort((a, b) => b[1] - a[1])
          .map(([t, c]) => `  #${t}: ${c}`)
          .join('\n')

        const recentList = stats.recentlyModified
          .map((r) => `  ${r.date} — ${r.title} (${r.path})`)
          .join('\n')

        const orphanList = stats.orphanNotes
          .map((o) => `  - ${o.title} (${o.path})`)
          .join('\n')

        const text = [
          `# Vault-Übersicht`,
          ``,
          `**Notizen gesamt:** ${stats.totalNotes}`,
          `**Offene TODOs:** ${stats.openTodoCount}`,
          ``,
          `## Nach Ordner`,
          folderList,
          ``,
          `## Tags`,
          tagList,
          ``,
          `## Zuletzt bearbeitet`,
          recentList,
          ``,
          `## Verwaiste Notizen (keine eingehenden Links)`,
          orphanList || '  Keine.',
          ``,
          `## Stale Notizen (status: aktiv, > 180 Tage nicht bearbeitet)`,
          stats.staleNotes.length > 0
            ? stats.staleNotes.map(s => `  - ${s.title} (${s.path}) — ${s.daysAgo} Tage alt`).join('\n')
            : '  Keine.',
        ].join('\n')

        return { content: [{ type: 'text', text }] }
      }

      case 'todo_list': {
        const items = vault.getTodoList(args.folder as string | undefined)

        if (items.length === 0) {
          return { content: [{ type: 'text', text: 'Keine offenen TODOs gefunden.' }] }
        }

        const text = items
          .map((item) => {
            const todos = item.todos
              .map((t) => `  - [ ] ${t.text} (Zeile ${t.line})`)
              .join('\n')
            return `**${item.title}** (${item.file})\n${todos}`
          })
          .join('\n\n')

        const totalCount = items.reduce((sum, i) => sum + i.todos.length, 0)
        return {
          content: [
            {
              type: 'text',
              text: `${totalCount} offene TODOs in ${items.length} Dateien:\n\n${text}`,
            },
          ],
        }
      }

      case 'suggest_links': {
        const suggestions = vault.suggestLinks()

        if (suggestions.length === 0) {
          return { content: [{ type: 'text', text: 'Keine unverlinkten Erwähnungen gefunden.' }] }
        }

        const text = suggestions
          .slice(0, 30) // Limit output
          .map((s) => `**${s.source}** erwähnt "${s.mention}" → könnte auf [[${s.target}]] (${s.targetTitle}) verlinken`)
          .join('\n')

        return {
          content: [
            { type: 'text', text: `${suggestions.length} unverlinkte Erwähnungen:\n\n${text}` },
          ],
        }
      }

      case 'weekly_review': {
        const review = vault.weeklyReview()

        const modified = review.modifiedNotes
          .map((n) => `  ${n.date} — ${n.title} (${n.path})`)
          .join('\n')

        const newNotes = review.newNotes
          .map((n) => `  ${n.date} — ${n.title} (${n.path})`)
          .join('\n')

        const projects = review.activeProjects
          .map((p) => `  ${p.projekt}: ${p.noteCount} Notizen`)
          .join('\n')

        const text = [
          `# Wochenrückblick (${review.period})`,
          ``,
          `## Bearbeitete Notizen (${review.modifiedNotes.length})`,
          modified || '  Keine.',
          ``,
          `## Neue Notizen (${review.newNotes.length})`,
          newNotes || '  Keine.',
          ``,
          `## TODOs`,
          `  Offen: ${review.openTodos}`,
          `  Erledigt: ${review.completedTodos}`,
          ``,
          `## Aktive Projekte`,
          projects || '  Keine.',
        ].join('\n')

        return { content: [{ type: 'text', text }] }
      }

      case 'daily_note': {
        const result = vault.dailyNote(args.append as string | undefined)

        const action = result.created ? 'Erstellt' : args.append ? 'Ergänzt' : 'Geladen'
        return {
          content: [
            {
              type: 'text',
              text: `Daily Note ${action}: ${result.path}\n\n${result.content}`,
            },
          ],
        }
      }

      case 'generate_runbook': {
        const result = vault.generateRunbook(
          args.topic as string,
          args.folder as string | undefined,
        )

        return {
          content: [
            {
              type: 'text',
              text: [
                `Runbook erstellt: **${result.path}**`,
                `Quellen: ${result.sourceCount} Notizen`,
                `Schritte: ${result.stepCount}`,
                `Bekannte Probleme: ${result.fixCount}`,
              ].join('\n'),
            },
          ],
        }
      }

      case 'organize_referenz': {
        const dryRun = args.dry_run === true
        const result = vault.organizeReferenz(dryRun)

        const movedText = result.moved.length > 0
          ? result.moved.map(m => `- \`${m.from}\` → \`${m.to}\` [${m.category}] (${m.reason})`).join('\n')
          : '  (keine)'

        const skippedText = result.skipped.length > 0
          ? result.skipped.map(s => `- \`${s.path}\`: ${s.reason}`).join('\n')
          : '  (keine)'

        const header = dryRun
          ? `## Vorschau (Dry Run — noch nichts verschoben)\n`
          : `## Verschoben\n`

        return {
          content: [{
            type: 'text',
            text: [
              header,
              `**${result.moved.length}** Notizen ${dryRun ? 'würden verschoben' : 'verschoben'}:`,
              movedText,
              ``,
              `**${result.skipped.length}** übersprungen:`,
              skippedText,
            ].join('\n'),
          }],
        }
      }

      case 'list_suggestions': {
        const all = listSuggestions()
        if (all.technik.length === 0 && all.clients.length === 0) {
          return { content: [{ type: 'text', text: 'Keine Vorschläge. Der Harvester hat noch keine Kandidaten geloggt.' }] }
        }

        const sections: string[] = ['# Pending Suggestions']
        if (all.clients.length > 0) {
          const lines = all.clients.map(s =>
            `- **${s.candidate}** (${s.count}× gesehen, zuletzt ${s.lastSeen.slice(0, 10)})\n` +
            `  Pfade: ${s.contexts.slice(0, 3).join(', ')}`,
          ).join('\n\n')
          sections.push(`\n## Kunden (${all.clients.length})\n\n${lines}`)
        }
        if (all.technik.length > 0) {
          const lines = all.technik.map(s =>
            `- **${s.candidate}** unter _${s.parent}_ (${s.count}× gesehen, zuletzt ${s.lastSeen.slice(0, 10)})\n` +
            `  Kontext: ${s.contexts.slice(0, 3).join(' | ')}`,
          ).join('\n\n')
          sections.push(`\n## Technik-Unterkategorien (${all.technik.length})\n\n${lines}`)
        }
        sections.push(`\n---\n**Übernehmen mit:** \`promote_suggestion\` — type, candidate (+ parent für technik).`)

        return { content: [{ type: 'text', text: sections.join('\n') }] }
      }

      case 'promote_suggestion': {
        const type = args.type as string
        const candidate = args.candidate as string
        const canonical = args.canonical as string | undefined
        const keywords = (args.keywords as string[] | undefined) ?? []

        if (type === 'technik') {
          const parent = args.parent as string
          if (!parent) {
            return { content: [{ type: 'text', text: 'Fehler: parent muss angegeben sein für type=technik' }], isError: true }
          }
          const result = promoteTechnikSuggestion(parent, candidate, canonical, keywords)
          const existedNote = result.existed ? ' (Keywords ergänzt)' : ' (neu angelegt)'
          return {
            content: [{
              type: 'text',
              text: `Technik-Unterkategorie **${result.category}/${result.subcategory}** übernommen${existedNote}.\n\nKonfiguration: ${result.path}\n\nTipp: Lauf \`organize_referenz\` um bestehende Notes jetzt sofort in die neue Unterkategorie zu sortieren.`,
            }],
          }
        } else if (type === 'client') {
          const result = promoteClientSuggestion(candidate, canonical, keywords)
          const existedNote = result.existed ? ' (Keywords ergänzt)' : ' (neu angelegt)'
          return {
            content: [{
              type: 'text',
              text: `Kunde **${result.name}** übernommen${existedNote}.\n\nKonfiguration: ${result.path}\n\nAb der nächsten Session werden Captures mit diesem Namen nach \`Kunden/${result.name}/\` einsortiert.`,
            }],
          }
        } else {
          return { content: [{ type: 'text', text: `Unbekannter type: ${type}. Erlaubt: technik, client` }], isError: true }
        }
      }

      case 'run_vault_maintenance': {
        const report = vault.runMaintenance()
        const text = [
          `# Vault-Maintenance durchgelaufen`,
          ``,
          `Report: **${report.reportPath}**`,
          ``,
          `| Bereich | Anzahl | Auto-fixbar |`,
          `|---------|--------|-------------|`,
          `| Duplikate (high / med / low) | ${report.duplicates.high} / ${report.duplicates.medium} / ${report.duplicates.low} | — |`,
          `| Kaputte Links | ${report.brokenLinks.total} | ${report.brokenLinks.autoFixable} |`,
          `| Frontmatter-Issues | ${report.lintIssues.total} | ${report.lintIssues.autoFixable} |`,
          `| Fehlende MOCs | ${report.mocs.missing} | alle |`,
          `| Stale Notes | ${report.staleNotes} | — |`,
          `| Verwaiste Notes | ${report.orphanNotes} | — |`,
          ``,
          `Details: siehe ${report.reportPath} in Obsidian.`,
        ].join('\n')
        return { content: [{ type: 'text', text }] }
      }

      case 'generate_mocs': {
        const dryRun = args.dry_run === true
        const minNotes = typeof args.min_notes === 'number' ? args.min_notes : 2
        const results = vault.generateMocs(dryRun, minNotes)

        const byAction = {
          created: results.filter(r => r.action === 'created'),
          updated: results.filter(r => r.action === 'updated'),
          skipped: results.filter(r => r.action === 'skipped'),
        }

        const renderGroup = (label: string, items: typeof results) => {
          if (items.length === 0) return ''
          const lines = items.map(r => {
            const reason = r.reason ? ` — ${r.reason}` : ''
            return `- \`${r.path}\` (${r.noteCount} Notiz${r.noteCount !== 1 ? 'en' : ''}${r.subfolders.length ? `, ${r.subfolders.length} Unterkategorien` : ''})${reason}`
          })
          return `### ${label} (${items.length})\n${lines.join('\n')}`
        }

        const header = dryRun
          ? `## Vorschau (Dry Run — nichts geschrieben)`
          : `## MOCs generiert`

        return {
          content: [{
            type: 'text',
            text: [
              header,
              ``,
              renderGroup('Erstellt', byAction.created),
              renderGroup('Aktualisiert', byAction.updated),
              renderGroup('Übersprungen', byAction.skipped),
            ].filter(Boolean).join('\n\n'),
          }],
        }
      }

      case 'lint_frontmatter': {
        const issues = vault.lintFrontmatter()
        if (issues.length === 0) {
          return { content: [{ type: 'text', text: 'Frontmatter ist sauber. ✓' }] }
        }

        const bySeverity = {
          error: issues.filter(i => i.severity === 'error'),
          warning: issues.filter(i => i.severity === 'warning'),
          info: issues.filter(i => i.severity === 'info'),
        }

        const renderGroup = (label: string, icon: string, items: LintIssue[]) => {
          if (items.length === 0) return ''
          const lines = items.slice(0, 30).map(i =>
            `- **${i.path}** [${i.field}]: ${i.issue}\n  → ${i.suggestion}${i.autoFixable ? ' *(auto-fixbar)*' : ''}`,
          )
          const extra = items.length > 30 ? `\n*...und ${items.length - 30} weitere*` : ''
          return `## ${icon} ${label} (${items.length})\n\n${lines.join('\n\n')}${extra}`
        }

        const autoFixCount = issues.filter(i => i.autoFixable).length
        const sections = [
          `# Frontmatter-Lint`,
          `${issues.length} Issues gefunden, ${autoFixCount} davon auto-fixbar.`,
          renderGroup('Errors', '🔴', bySeverity.error),
          renderGroup('Warnings', '🟡', bySeverity.warning),
          renderGroup('Info', '🔵', bySeverity.info),
        ].filter(Boolean).join('\n\n')

        return { content: [{ type: 'text', text: sections }] }
      }

      case 'fix_frontmatter': {
        const dryRun = args.dry_run !== false
        const result = vault.fixFrontmatter(dryRun)

        const fixedText = result.fixed.length > 0
          ? result.fixed.map(f => `- **${f.path}**\n  ${f.changes.join('\n  ')}`).join('\n\n')
          : '  (nichts zu tun)'

        const header = dryRun
          ? `## Vorschau (Dry Run)\n\n**Nichts geändert.**`
          : `## Angewendet\n\n**${result.fixed.length}** Notizen korrigiert.`

        return {
          content: [{
            type: 'text',
            text: [header, ``, `### Fixes (${result.fixed.length})`, fixedText].join('\n'),
          }],
        }
      }

      case 'find_broken_links': {
        const broken = vault.findBrokenLinks()
        if (broken.length === 0) {
          return { content: [{ type: 'text', text: 'Keine kaputten Links gefunden. ✓' }] }
        }

        const lines = broken.slice(0, 50).map(b => {
          const candidatesText = b.candidates.length === 0
            ? '  (keine Kandidaten)'
            : b.candidates.map(c => `  - [${c.confidence}] ${c.path} — ${c.reason}`).join('\n')
          return `- **${b.source}** → \`[[${b.target}]]\` (nicht gefunden)\n${candidatesText}`
        }).join('\n\n')

        const summary = `# Kaputte Links\n\n${broken.length} kaputte Links gefunden.\n\n${lines}`
        return { content: [{ type: 'text', text: summary }] }
      }

      case 'fix_broken_links': {
        const dryRun = args.dry_run !== false // default true
        const result = vault.fixBrokenLinks(dryRun)

        const fixedText = result.fixed.length > 0
          ? result.fixed.map(f => `- \`${f.source}\`: ${f.oldLink} → ${f.newLink}`).join('\n')
          : '  (keine)'
        const skippedText = result.skipped.length > 0
          ? result.skipped.map(s => `- \`${s.source}\`: ${s.oldLink} — ${s.reason}`).join('\n')
          : '  (keine)'

        const header = dryRun
          ? `## Vorschau (Dry Run)\n\n**Nichts geändert.**`
          : `## Angewendet\n\n**${result.fixed.length}** Links repariert.`

        return {
          content: [{
            type: 'text',
            text: [
              header,
              ``,
              `### Auto-Fix (${result.fixed.length})`,
              fixedText,
              ``,
              `### Übersprungen (${result.skipped.length})`,
              skippedText,
            ].join('\n'),
          }],
        }
      }

      case 'find_duplicates': {
        const minScore = typeof args.min_score === 'number' ? args.min_score : 40
        const candidates = vault.findDuplicates(minScore)

        if (candidates.length === 0) {
          return { content: [{ type: 'text', text: `Keine Duplikate gefunden (min_score=${minScore}).` }] }
        }

        const byConfidence = {
          high: candidates.filter(c => c.confidence === 'high'),
          medium: candidates.filter(c => c.confidence === 'medium'),
          low: candidates.filter(c => c.confidence === 'low'),
        }

        const renderGroup = (label: string, icon: string, items: typeof candidates) => {
          if (items.length === 0) return ''
          const lines = items.map(c =>
            `- **${c.titleA}** vs **${c.titleB}** (Score ${c.score}, ${c.suggestion})\n` +
            `  \`${c.noteA}\` ↔ \`${c.noteB}\`\n` +
            `  Gründe: ${c.reasons.join(', ')}`
          )
          return `## ${icon} ${label} (${items.length})\n\n${lines.join('\n\n')}`
        }

        const sections = [
          `# Duplikat-Analyse`,
          ``,
          `${candidates.length} Kandidaten gefunden. **Nichts wurde geändert** — nur Vorschläge.`,
          renderGroup('Hohe Confidence — merge empfohlen', '🔴', byConfidence.high),
          renderGroup('Mittlere Confidence — manuell prüfen', '🟡', byConfidence.medium),
          renderGroup('Niedrige Confidence — evtl. verlinken', '🟢', byConfidence.low),
        ].filter(Boolean).join('\n\n')

        return { content: [{ type: 'text', text: sections }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `Unbekanntes Tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text', text: `${req.params.name} fehlgeschlagen: ${msg}` }],
      isError: true,
    }
  }
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

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('unhandledRejection', (err) => {
  process.stderr.write(`obsidian-brain: unhandled rejection: ${err}\n`)
})

// ── Start ──────────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
