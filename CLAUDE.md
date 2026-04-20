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

## Current Phase: 1 — Stabilize

Acceptance gate: `npm test` passes + server boots cleanly + config is single-sourced + write ops are observable.

### Task Status

| Task | Description | Status | Acceptance |
|------|-------------|--------|------------|
| 1.1 | fix-runtime | ✅ done | `npm test` green (78/78); `VAULT_PATH=... node server.ts` boots; versions synced at 0.2.0 |
| 1.2 | unify-config | ⏳ pending | single entrypoints for clients/categories/aliases; no hardcoded lists in vault.ts |
| 1.3 | extract-service-layer | ⏳ pending | analyzers live in `services/`; regression tests green |
| 1.4 | action-log | ⏳ pending | `services/action-log.ts`; every vault write emits one append-only entry |

### Known drift (from prompt)

- `package.json` version 0.2.0 ≠ `server.ts` version 0.1.0
- `vault.ts` holds `KNOWN_CLIENTS` and `TECH_TERMS` constants while hooks use JSON
- `server.ts` tool descriptions still say "Referenz/" when repo has evolved to `Technik/`
- `hooks/session-context.ts` re-implements auto-organize instead of calling `vault.ts#organizeReferenz`
- `npm test` and `node server.ts` may not run reliably against `.ts` in the current environment

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

## Phase 2 & 3 are deferred

See the source prompt for full spec. Do not start Phase 2 until every Phase 1 acceptance criterion is ticked in this file.
