# Public Beta Guide

Obsidian Brain MCP is beta-ready when a new user can validate safety, install hooks, and inspect useful demo output without touching a private vault.

Prerequisite: Node.js 22.18.0 or newer. The CLI, hooks, and MCP server execute TypeScript directly with `node`.

## 5-Minute Trial

```bash
git clone https://github.com/amolani/obsidian-brain-mcp-server.git
cd obsidian-brain-mcp-server
npm install
node cli.ts demo --out /tmp/obsidian-brain-demo --force
node cli.ts doctor --vault /tmp/obsidian-brain-demo --skip-hooks
```

Open `/tmp/obsidian-brain-demo` in Obsidian and inspect:

- `Knowledge/_brain.md`
- `Knowledge/evidence.md` after running `build_evidence_dashboard`
- `Maintenance/Capture Review.md` after running `build_capture_review`
- `Maintenance/Knowledge Inbox.md` after running `build_knowledge_inbox`
- `Maintenance/Change Ledger.md` after running `build_change_ledger`
- `Maintenance/Session Impact/` after a real auto-build run or `build_session_impact_report`
- `Knowledge/Runbooks/Runbook Firewall DHCP.md`

## Real Vault Setup

```bash
export VAULT_PATH=/path/to/your/obsidian/vault
node cli.ts doctor --vault "$VAULT_PATH"
node cli.ts install-hooks --vault "$VAULT_PATH"
node cli.ts install-hooks --vault "$VAULT_PATH" --apply
node cli.ts repair-hooks --vault "$VAULT_PATH"
```

`install-hooks` is dry-run by default. With `--apply`, it creates a timestamped backup of `~/.claude/settings.json` before writing.
`repair-hooks` uses the same dry-run-first planner and is intended for drifted or partially missing SessionStart, Stop, and PostToolUse hook registrations.

## Unattended Background Run

```bash
node cli.ts background --vault "$VAULT_PATH"
node cli.ts background --vault "$VAULT_PATH" --apply
```

The apply run writes `Maintenance/Background Run Report.md` and `.brain-background-last-run.json`. Risky maintenance stays preview-only inside the background runner.

For production scheduling, see [Production Setup](production-setup.md).

## Safety Defaults

- Working memory stays manual.
- Risky refactors stay out of automatic apply.
- Hook installation preserves unrelated Claude settings.
- Capture Review and Evidence Dashboard are dry-run-first surfaces.
- Session Impact Report and Knowledge Inbox are dry-run-first surfaces.
- Runbook generation through the MCP tool previews by default.
- Checkpoint and capture-derived claims are marked provisional until reviewed.
- Fuzzy or content-based customer matches are surfaced in Capture Review and Knowledge Inbox.
- Secret-like tokens are redacted before auto-captures are written.
- Legacy captures/claims can be backfilled with `migrate_brain_metadata` dry-run first.
- Background jobs use a lock and keep merge/rename/folder/link/gap actions out of automatic apply.
- Reviewed Knowledge Inbox items are persisted in `.brain-knowledge-inbox-state.json`.
- Legacy fixed surfaces can be adopted only through explicit `repair_generated_surfaces` apply with `adopt_legacy=true` and a strict multi-signal signature; manual files remain protected.

## Good First Commands

```text
brain_health_check
brain_metrics
brain_run_background
build_capture_review
build_knowledge_inbox
brain_review_inbox_items
build_change_ledger
build_evidence_dashboard
repair_generated_surfaces
migrate_brain_metadata
brain_review
```

## Scale Check

```bash
node cli.ts benchmark --out /tmp/obsidian-brain-benchmark --notes 5000 --force
```

The benchmark creates only synthetic Markdown and writes `benchmark-report.md` and `benchmark-report.json`.
