# Obsidian Brain MCP — Active Development Plan

Spec source: Claude Code Prompt `mcp-vault-brain-evolution` (v2.1).
Mode: orchestrator, local-only, phased refactor.

## Rules (hard constraints)

- Every vault-writing operation supports `dry_run` before apply.
- No breaking tool signatures without a migration note + wrapper period.
- All new tools register in `server.ts` tool registry.
- Phase 1 must be green before Phase 2 begins.
- One conventional commit per feature.
- Prefer incremental refactors over rewrites.

## Current Phase: 3 — Lifecycle, Intelligence & Quality Hardening ✅ **complete**

Acceptance gate: `npm test` passes + server boots cleanly + config is single-sourced + write ops are observable — **all four satisfied** (tests green, server boot clean, config via `config.ts`, writes logged to `.action-log.jsonl`).

### Task Status

| Task | Description | Status | Acceptance |
|------|-------------|--------|------------|
| 1.1 | fix-runtime | ✅ done | `npm test` green (78/78); `VAULT_PATH=... node server.ts` boots; versions synced at 0.2.0 |
| 1.2 | unify-config | ✅ done | `config.ts` exposes `loadClients/loadCategories/loadTagAliases/loadTechTerms` + `reloadConfig()`; `vault.ts` drops `KNOWN_CLIENTS`/`TECH_TERMS`; hooks + `suggestions.ts` + `technik-categories.ts` route through `config.ts`; `tech-terms.json` added; tests 78/78 green |
| 1.3 | extract-service-layer | ✅ done | analyzers live in `services/` (duplicate, broken-link, frontmatter, moc, review-queue); `vault.ts` is facade delegating to services; 78/78 tests green; vault.ts 2180 → 1307 lines |
| 1.4 | action-log | ✅ done | `services/action-log.ts` writes JSONL to `{vault}/.action-log.jsonl`; every vault-write (create_note, capture, daily_note, generate_runbook, organize_referenz, fix_broken_links, fix_frontmatter, generate_mocs, run_maintenance, auto_capture, create_daily_note) emits one entry; dry-runs do not log; tests green |

### Resolved drift (from prompt)

- ~~`package.json` version 0.2.0 ≠ `server.ts` version 0.1.0~~ — fixed in 1.1
- ~~`vault.ts` holds `KNOWN_CLIENTS` and `TECH_TERMS` constants while hooks use JSON~~ — fixed in 1.2 (now loaded via `config.ts` from `clients.json` / `tech-terms.json`)
- ~~`server.ts` tool descriptions still say "Referenz/" when repo has evolved to `Technik/`~~ — fixed: server instructions and tool examples distinguish `Technik/` from `Referenz/` staging
- ~~`hooks/session-context.ts` re-implements auto-organize instead of calling `vault.ts#organizeReferenz`~~ — fixed: hook delegates to `Vault.organizeReferenz(false)`
- ~~`npm test` and `node server.ts` may not run reliably against `.ts` in the current environment~~ — fixed in current Node runtime; tests and boot checks are stable

## Runtime

- Node 22+ is expected.
- `npm test` runs `node --test --test-reporter=spec tests/*.test.ts` — Node's native TS strip + built-in test runner.
- Server boot (local, for MCP registration): `node server.ts` with `VAULT_PATH` set.
- If Node native TS ever breaks here, fall back to `tsx` (one-line fix in `package.json` scripts).

## Service layer target (Task 1.3)

| Service | Source in vault.ts | New location |
|---------|-------------------|--------------|
| DuplicateAnalyzer | `findDuplicates()` | `services/duplicate-analyzer.ts` |
| BrokenLinkAnalyzer | `findBrokenLinks()` + `fixBrokenLinks()` | `services/broken-link-analyzer.ts` |
| FrontmatterLinter | `lintFrontmatter()` + `fixFrontmatter()` | `services/frontmatter-linter.ts` |
| MocGenerator | `generateMocs()` | `services/moc-generator.ts` |
| ReviewQueueBuilder | `runMaintenance()` + `formatReportMd()` | `services/review-queue-builder.ts` |

`vault.ts` stays as the facade — keeps the index, exposes public methods that delegate to services. No change to external API.

## Action log format (Task 1.4)

File: `{VAULT_PATH}/.action-log.jsonl` (JSON Lines, append-only).

Each line:
```json
{
  "ts": "2026-04-20T15:30:00.000Z",
  "tool": "fix_broken_links",
  "mode": "apply",
  "targets": ["Dashboard.md"],
  "summary": "Replaced 4 wiki-links pointing to moved files",
  "before": "[[Referenz/Docker Setup]]",
  "after": "[[Technik/Docker/Docker Setup]]"
}
```

## Phase 2 — Product Features

Phase 1 gate is green. Phase 2 is now active and should still be implemented one feature at a time with tests and dry-run coverage for write operations.

| Task | Description | Status | Acceptance |
|------|-------------|--------|------------|
| 2.1 | capture_v2 | ✅ done | `capture_v2` tool registered; unified Technik/client/security routing; tag aliases normalized on write; modes `fast`/`strict`/`review`; dry-run previews write nothing; old `capture` remains as compatibility wrapper; tests green |
| 2.2 | note_quality_report | ✅ done | `score_note_quality` + `list_low_quality_notes` tools registered; read-only scoring across title/frontmatter/tags/links/TODOs/structure/content/freshness; maintenance report includes quality summary; tests green |
| 2.3 | suggest_links_v2 | ✅ done | `suggest_links_v2` tool registered; confidence scores, snippets, alias/title matching, tag/folder proximity, per-note and total caps; read-only tests green |
| 2.4 | customer_dashboard | ✅ done | `build_customer_context` + `build_project_dashboard` tools registered; dry-run default; dashboard aggregates notes, TODOs, recent changes, runbooks, auto-captures, frequent tags, issues; apply writes `Kunden/{Client}/_dashboard.md` and logs action; tests green |
| 2.5 | merge_duplicates | ✅ done | `merge_duplicates` tool registered; dry-run default; explicit pair or high-confidence auto mode; merges tags/frontmatter/content with source references; archives duplicate under `Archiv/Duplikate/{date}/`; action-log coverage; tests green |

## Phase 3 — Lifecycle, Intelligence & Quality Hardening

Phase 2 is stable. Phase 3 starts with local-only lifecycle automation before any embedding dependency is introduced.

| Task | Description | Status | Acceptance |
|------|-------------|--------|------------|
| 3.1 | lifecycle_updates | ✅ done | `suggest_lifecycle_updates` + `apply_lifecycle_updates` tools registered; analyzer recommends safe status transitions; executor is dry-run by default and edits only frontmatter status/aktualisiert/lifecycle_reviewed; maintenance report includes lifecycle summary; tests green |
| 3.2 | semantic_search | ✅ done | `semantic_search` tool registered; local weighted vector provider over title/tags/folder/headings/content; query expansion via config aliases/categories; snippets and filters; no remote dependency; tests green |
| 3.3 | context_pack | ✅ done | `build_context_pack` tool registered; combines semantic hits, one-hop linkgraph context, snippets, open TODOs, citations, and suggested next actions; read-only tests green |
| 3.4 | semantic_index_cache | ✅ done | `semantic_index_status` + `rebuild_semantic_index` tools registered; persistent `.semantic-index.json` cache with content hashes, stale/missing/extra drift detection, dry-run-first rebuild, and action-log coverage; tests green |
| 3.5 | apply_link_suggestions | ✅ done | `apply_link_suggestions` tool registered; dry-run-first executor for high-confidence `suggest_links_v2` mentions; skips code blocks/existing wiki-link lines/ambiguous mentions; action-log coverage; tests green |
| 3.6 | safe_maintenance_batch | ✅ done | `run_safe_maintenance` tool registered; dry-run-first orchestrator for frontmatter, broken links, link suggestions, lifecycle, MOCs, and semantic-index rebuild; tests green |
| 3.7 | server_tool_registry_extract | ✅ done | MCP tool definitions extracted to `server-tools.ts`; `server.ts` keeps handlers and runtime wiring; tests and boot check green |
| 3.8 | server_handler_extract | ✅ done | MCP call handlers extracted to `tool-handlers.ts`; `server.ts` is now bootstrapping + registry wiring + shutdown; tests and boot check green |
| 3.9 | note_parser_extract | ✅ done | Markdown/YAML parsing extracted to `services/note-parser.ts`; `Vault.indexNote()` delegates entry parsing; parser has direct unit tests; tests and boot check green |
| 3.10 | link_index_extract | ✅ done | Link resolution and backlink-index construction extracted to `services/link-index.ts`; `Vault` delegates compatibility methods; direct unit tests added; tests and boot check green |
| 3.11 | vault_search_extract | ✅ done | Structured search and relevance scoring extracted to `services/vault-search.ts`; `Vault.search()` delegates to the service; direct unit tests added; tests and boot check green |
| 3.12 | note_creator_extract | ✅ done | Template-based note creation extracted to `services/note-creator.ts`; `Vault.createNote()` delegates to the service; direct unit tests added; tests and boot check green |
| 3.13 | vault_overview_extract | ✅ done | Vault statistics and stale/orphan overview logic extracted to `services/vault-overview.ts`; `Vault.getOverview()` delegates to the service; deterministic unit tests added; tests and boot check green |
| 3.14 | analysis_facade_extract | ✅ done | Note context, TODO aggregation, weekly review, and legacy link suggestions extracted to dedicated read-only services; `Vault` delegates and re-exports compatibility types; direct unit tests added; tests and boot check green |
| 3.15 | hook_auto_organize_delegate | ✅ done | `hooks/session-context.ts` no longer duplicates Referenz→Technik organization; it delegates to `Vault.organizeReferenz(false)` and uses the same action-log path as the MCP tool |
| 3.16 | embedding_provider_boundary | ✅ done | `VectorProvider` abstraction, provider name/version cache validation, rebuild/status drift detection, and local provider are implemented; optional external embedding providers are future feature work, not an open quality blocker |
| 3.17 | write_workflow_extract | ✅ done | Daily note, runbook generation, and Referenz→Technik organization extracted to `services/daily-note.ts`, `services/runbook-generator.ts`, and `services/referenz-organizer.ts`; `Vault` is now a thin index/facade layer; direct unit tests added; tests and boot check green |
| 3.18 | rename_note_refactor | ✅ done | `rename_note` tool registered; dry-run by default; optional move folder; updates note H1/title metadata and aliases; rewrites wikilinks plus frontmatter path references; action-log coverage; direct tests green |
| 3.19 | inbox_triage | ✅ done | `triage_note` + `triage_inbox` tools registered; dry-run by default; classifies notes, normalizes tags, suggests/applies safe target folders, reports duplicates and link suggestions; high-duplicate and low-confidence cases stay in review; tests green |
| 3.20 | review_queue_actions | ✅ done | `accept_review_item`, `reject_review_item`, `snooze_review_item`, and `apply_all_safe_fixes` tools registered; Maintenance reports include stable item IDs; review state is stored in `.review-queue-actions.json`; safe fixes delegate to dry-run-first maintenance pipeline; tests green |
| 3.21 | frontmatter_schema_profiles | ✅ done | `lint_frontmatter` + `fix_frontmatter` are profile-aware; profiles are inferred conservatively or can be overridden; supported profiles: Kunde, Referenz, Troubleshooting, Learning, Runbook, Daily, Maintenance-Report, Auto-Capture, MOC; safe defaults add missing status/tags/date/source/customer where inferable; tests green |
| 3.22 | incident_extractor | ✅ done | `extract_troubleshooting_pattern`, `promote_capture_to_runbook`, and `generate_postmortem` tools registered; pattern extraction is read-only; promotion/postmortem generation are dry-run by default and action-logged on apply; tests green |
| 3.23 | manual_recall_context | ✅ done | `recall_context` tool registered as manual read-only working-memory recall; delegates to context-pack semantics but stores nothing and injects nothing automatically; tests green |
| 3.24 | policy_layer_hook_safety | ✅ done | `brain-policy.json` + `services/policy.ts` define manual-only working memory, hook permissions, protected paths, and tool risk/write policy; hooks respect auto-capture/daily-note/auto-organize settings; guarded writers reject protected paths; tests green |
| 3.25 | source_ingest_manifest | ✅ done | `ingest_source` tool registered; immutable sources under `.raw/`; `.raw/.manifest.json` tracks source hashes and output notes; unchanged sources are skipped unless `force=true`; output source notes land in `Referenz/Quellen/`; dry-run default; tests green |
| 3.26 | manual_memory_saves | ✅ done | `save_insight`, `save_decision`, and `save_answer` tools registered; durable manual memory lands under `Knowledge/`; dry-run default; action-log coverage; tests green |
| 3.27 | hot_cache_and_index | ✅ done | `update_hot_cache`, `read_hot_cache`, and `build_knowledge_index` tools registered; hot cache is manual-only and never auto-injected; index summarizes vault areas/tags/recent notes/open gaps; dry-run default for writers; tests green |
| 3.28 | gap_contradiction_tracking | ✅ done | `flag_knowledge_gap`, `flag_contradiction`, `list_open_questions`, and `resolve_gap` tools registered; unresolved questions and contradictory claims live under `Knowledge/`; resolver marks notes resolved and logs changes; tests green |
| 3.29 | research_plan | ✅ done | `create_research_plan` tool registered; builds a local-context research checklist under `Knowledge/Research/`; dry-run default; action-log coverage; tests green |
| 3.30 | brain_review_orchestrator | ✅ done | `brain_review` + `brain_apply_review_item` tools registered; review aggregates duplicates, broken links, frontmatter fixes, lifecycle, link suggestions, quality, open questions, contradictions, semantic index drift, Knowledge index, and Hot Cache; executor delegates one action-backed item at a time and remains dry-run by default; tests green |
| 3.31 | evidence_confidence_layer | ✅ done | `update_evidence` + `evidence_report` tools registered; durable knowledge supports confidence, source, checked/recheck/expiry dates, confirmed_by, and contradicted_by metadata; save_insight/save_decision/save_answer accept evidence fields; tests green |
| 3.32 | source_claim_extraction | ✅ done | `extract_claims` tool registered; source notes/raw files can produce `Knowledge/Claims/` notes with source/confidence/contradiction candidates; dry-run default; action-log coverage; tests green |
| 3.33 | brain_dashboard_feedback_schedule | ✅ done | `build_brain_dashboard`, `record_brain_feedback`, `brain_feedback_summary`, and `brain_schedule` tools registered; dashboard writes `Knowledge/_brain.md`; feedback state records accepted/rejected/snoozed suggestions; scheduler is propose-only; tests green |
| 3.34 | customer_memory_timeline | ✅ done | `build_memory_timeline` tool registered; builds `Kunden/{Client}/_timeline.md` from customer notes, decisions, captures, runbooks, claims, incidents, and TODO-bearing notes; dry-run default; action-log coverage; tests green |
| 3.35 | policy_controlled_auto_build | ✅ done | `automation` policy added with `auto_build/review_only/off`; `brain_auto_build` tool registered; Stop hook runs auto-build after successful captures; safe derived writes include capture promotion, claims, evidence, dashboard, index, hot cache, and timeline; risky refactors remain in `neverAutoApply`; tests green |
| 3.36 | auto_build_quality_manifest | ✅ done | Auto-build now creates a promotion plan, runs a quality/dedup gate, records processed source hashes in `.brain-auto-build-manifest.json`, and skips already-promoted captures; tests green |
| 3.37 | long_session_checkpoint | ✅ done | `brain_checkpoint` tool registered; writes `Knowledge/Checkpoints/` notes and can run `brain_auto_build` during long sessions; dry-run default; action-log coverage; tests green |
| 3.38 | customer_snapshot_metrics | ✅ done | `build_customer_snapshot` + `brain_metrics` tools registered; customer snapshot writes `Kunden/{Client}/_snapshot.md`; metrics report auto-captures, promotions, claims, evidence issues, questions, feedback, and auto-build manifest state; tests green |
| 3.39 | auto_build_reports_runbooks_limits | ✅ done | Auto-build policy limits added for max new notes, claims, and runtime; each apply writes `Maintenance/Auto-Build/` report notes; runbook auto-promotion runs only when captures have enough procedural signals; tests green |
| 3.40 | auto_build_archive_safety | ✅ done | Auto-build manifest now records generated artifacts and reports; `archive_auto_build_run` can dry-run or move one source run's generated artifacts to `Archiv/Auto-Build/` without touching the source capture; action-log coverage; tests green |
| 3.41 | long_session_auto_checkpoint | ✅ done | `session-state` + `long-session-monitor` services added; `hooks/session-checkpoint.ts` can run during PostToolUse-style events, writes debounced `Knowledge/Checkpoints/` notes, optionally triggers incremental auto-build, and respects policy thresholds/limits; tests green |
| 3.42 | auto_build_feedback_learning | ✅ done | Archived auto-build artifacts record negative category feedback; `brain_auto_build` reads feedback learning and tightens/blocks noisy gates for insights, answers, gaps, claims, and runbooks; `brain_metrics` exposes archived sources, usefulness score, and learned categories; tests green |
| 3.43 | brain_health_check | ✅ done | `brain_health_check` tool registered; read-only readiness check covers vault path, policy, required brain tools, generated surfaces, auto-build manifest, action log, and optional Claude hook registration; tests green |
