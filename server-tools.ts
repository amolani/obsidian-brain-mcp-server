export const TOOL_DEFINITIONS = [
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
            description: 'Filter by folder path (e.g. "Kunden", "Technik", "Referenz", "Kunden/Merian")',
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
        'Compatibility wrapper for quick knowledge capture. Uses the capture_v2 pipeline in fast/apply mode while keeping the old tool signature.',
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
      name: 'capture_v2',
      description:
        'Smart knowledge capture with unified classification. Routes technical notes into Technik/{Kategorie}/{Sub}, normalizes tags, supports fast/strict/review modes, and supports dry_run previews before writing.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: {
            type: 'string',
            description: 'The knowledge content to capture.',
          },
          category: {
            type: 'string',
            enum: ['kunde', 'referenz', 'technik', 'sicherheit', 'persönlich'],
            description: 'Optional category hint. "referenz"/"technik" still use Technik classification when confident.',
          },
          mode: {
            type: 'string',
            enum: ['fast', 'strict', 'review'],
            description: 'fast = route confidently with lower threshold; strict = avoid weak Technik routing; review = preview by default.',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true, only previews the target path/tags without writing. Default: false, except mode=review defaults to true.',
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
      name: 'semantic_search',
      description:
        'Local semantic-style search using weighted note vectors (title, tags, folder, headings, content) with query expansion from config aliases/categories. No remote embeddings; pure analyzer.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Conceptual search query.',
          },
          limit: {
            type: 'number',
            description: 'Maximum results. Default 10.',
          },
          folder: {
            type: 'string',
            description: 'Optional folder prefix filter, e.g. "Kunden/" or "Technik/".',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags filter. All tags must match.',
          },
          min_score: {
            type: 'number',
            description: 'Minimum score 0-100. Default 12.',
          },
          include_archived: {
            type: 'boolean',
            description: 'Include notes under Archiv/. Default false.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'semantic_index_status',
      description:
        'Inspect the local semantic index cache. Reports missing, stale, extra, and fresh note vectors. Pure analyzer — makes no changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'rebuild_semantic_index',
      description:
        'Rebuild the local semantic index cache in the vault root. Dry-run by default. This writes only .semantic-index.json and logs the action when applied.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          dry_run: {
            type: 'boolean',
            description: 'If true, preview only. Default true.',
          },
        },
      },
    },
    {
      name: 'build_context_pack',
      description:
        'Build a compact read-only working context for a query: semantic hits, linked notes, snippets, backlinks/outgoing links, open TODOs, citations, and suggested next actions.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Topic or question to gather context for.',
          },
          max_notes: {
            type: 'number',
            description: 'Maximum notes in the context pack. Default 5, max 12.',
          },
          include_linked: {
            type: 'boolean',
            description: 'Include directly linked/backlink notes in addition to semantic hits. Default true.',
          },
          folder: {
            type: 'string',
            description: 'Optional folder prefix filter for primary semantic hits.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tag filter for primary semantic hits. All tags must match.',
          },
        },
        required: ['query'],
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
      name: 'suggest_links_v2',
      description:
        'Find stronger unlinked-mention suggestions with confidence scores, snippets, alias/title matching, tag/folder proximity, and per-note caps. Pure analyzer — makes no changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          min_confidence: {
            type: 'number',
            description: 'Minimum confidence from 0.0 to 1.0. Default 0.55.',
          },
          max_per_note: {
            type: 'number',
            description: 'Maximum suggestions per source note. Default 5.',
          },
          max_total: {
            type: 'number',
            description: 'Maximum total suggestions returned. Default 100.',
          },
        },
      },
    },
    {
      name: 'apply_link_suggestions',
      description:
        'Apply high-confidence suggestions from suggest_links_v2 by replacing plain-text mentions with wiki-links. Dry-run by default. Skips code blocks, existing wiki-link lines, and ambiguous mentions.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          dry_run: {
            type: 'boolean',
            description: 'If true, preview only. Default true.',
          },
          min_confidence: {
            type: 'number',
            description: 'Minimum confidence required. Default 0.85.',
          },
          max_per_note: {
            type: 'number',
            description: 'Maximum suggestions per source note.',
          },
          max_total: {
            type: 'number',
            description: 'Maximum total suggestions to consider.',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional explicit source note paths to modify.',
          },
        },
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
      name: 'build_customer_context',
      description:
        'Build or preview a customer dashboard under Kunden/{Client}/_dashboard.md. Aggregates relevant notes, open TODOs, recent changes, runbooks, auto-captures, frequent tags, and known issues. Dry-run by default.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          client: {
            type: 'string',
            description: 'Canonical customer folder name under Kunden/ (e.g. "Merian").',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true, only previews the dashboard content without writing. Default true.',
          },
        },
        required: ['client'],
      },
    },
    {
      name: 'build_project_dashboard',
      description:
        'Alias for build_customer_context for project/customer folders. Builds or previews Kunden/{Project}/_dashboard.md. Dry-run by default.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project: {
            type: 'string',
            description: 'Project/customer folder name under Kunden/.',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true, only previews the dashboard content without writing. Default true.',
          },
        },
        required: ['project'],
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
      name: 'merge_duplicates',
      description:
        'Safely merge duplicate notes. Dry-run by default. Either pass explicit note_a/note_b or auto_high_confidence=true. Merges frontmatter/tags, appends source content with references, archives the duplicate under Archiv/Duplikate/{date}/, and logs the action.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          note_a: {
            type: 'string',
            description: 'First note path or title.',
          },
          note_b: {
            type: 'string',
            description: 'Second note path or title.',
          },
          auto_high_confidence: {
            type: 'boolean',
            description: 'If true, plan/apply all high-confidence duplicate pairs above min_score. Default false.',
          },
          min_score: {
            type: 'number',
            description: 'Minimum duplicate score for auto_high_confidence. Default 80.',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true, preview only. Default true.',
          },
          force: {
            type: 'boolean',
            description: 'Apply an explicit merge plan even when confidence/conflicts require manual override. Default false.',
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
        'Run ALL maintenance analyzers (duplicates, broken links, lint, missing MOCs, note quality, stale/orphan notes) and write a consolidated review-queue report as a Markdown note in Maintenance/{date}-review.md. Pure analyzer — no files modified except the report itself.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'run_safe_maintenance',
      description:
        'Run safe maintenance executors in a controlled batch. Dry-run by default. Can apply frontmatter fixes, broken-link fixes, high-confidence link suggestions, lifecycle status updates, MOCs, and semantic-index rebuild.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          dry_run: {
            type: 'boolean',
            description: 'If true, preview only. Default true.',
          },
          steps: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['frontmatter', 'broken_links', 'link_suggestions', 'lifecycle', 'mocs', 'semantic_index'],
            },
            description: 'Optional subset of steps to run.',
          },
          min_link_confidence: {
            type: 'number',
            description: 'Minimum confidence for apply_link_suggestions. Default 0.9.',
          },
          min_lifecycle_confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Minimum confidence for lifecycle updates. Default high.',
          },
          moc_min_notes: {
            type: 'number',
            description: 'Minimum notes per folder for MOC generation. Default 2.',
          },
        },
      },
    },
    {
      name: 'score_note_quality',
      description:
        'Score one note from 0-100 across title, frontmatter, tags, links, TODOs, structure, content density, and freshness. Pure analyzer — makes no changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'Relative path or note title to score.',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'list_low_quality_notes',
      description:
        'List notes at or below a quality score threshold, sorted worst first. Skips Daily, Maintenance, and generated MOC notes. Pure analyzer — makes no changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          max_score: {
            type: 'number',
            description: 'Maximum score to include. Default 69.',
          },
        },
      },
    },
    {
      name: 'suggest_lifecycle_updates',
      description:
        'Suggest safe lifecycle status changes for notes (e.g. missing status → aktiv, stale active notes → archiviert). Pure analyzer — makes no changes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          folder: {
            type: 'string',
            description: 'Optional folder prefix filter, e.g. "Kunden/" or "Technik/".',
          },
          max_results: {
            type: 'number',
            description: 'Maximum suggestions to return. Default 100.',
          },
          include_generated: {
            type: 'boolean',
            description: 'Include generated notes such as dashboards/MOCs. Default false.',
          },
        },
      },
    },
    {
      name: 'apply_lifecycle_updates',
      description:
        'Apply lifecycle status updates suggested by suggest_lifecycle_updates. Dry-run by default. Only edits frontmatter status/aktualisiert/lifecycle_reviewed; does not move or delete files.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          dry_run: {
            type: 'boolean',
            description: 'If true, preview only. Default true.',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional explicit note paths to update.',
          },
          folder: {
            type: 'string',
            description: 'Optional folder prefix filter.',
          },
          min_confidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description: 'Minimum confidence required for updates. Default high.',
          },
          recommended_status: {
            type: 'string',
            description: 'Optional target status filter, e.g. "archiviert" or "aktiv".',
          },
          max_results: {
            type: 'number',
            description: 'Maximum candidate suggestions to consider. Default 100.',
          },
        },
      },
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
] as const
