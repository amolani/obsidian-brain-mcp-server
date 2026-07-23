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
- Calibration review supports a blind, role-separated workflow: `brain_calibration_review_batch` returns opaque record tokens and no production path, fact ID, weighted progress, or production strata. `record_calibration_judgement` stores useful+supported atomically and freezes the pair. Hidden sample payloads do not enter normal search, semantic context, links, promotion, or action logs. Each isolated reviewer process must use `OBSIDIAN_BRAIN_MCP_MODE=calibration-review` plus its fixed registered `BRAIN_CALIBRATION_REVIEWER_ID`; the server injects that identity and the judgement UTC timestamp. Its public schemas expose neither selector, and conflicting caller values are rejected. Default mode hides and rejects both reviewer-only tools.
- Calibration Capture V3 binds the complete candidate-ID universe and reconstructs the seeded sample exactly; legacy V2 is read-only and cannot enter a sealed campaign.
- Exploratory calibration evaluation is read-only shadow analysis and can never change weights or authorize a release.
- Confirmatory campaigns are explicitly registered before review, closed after the fixed reviewer roster completes every enrolled observation, and consumed once with `brain_calibration_evaluate_sealed`. Registration apply requires the exact root and timestamp from the reviewed preview; closure commits its root externally before writing its recoverable local copy. Enrollment, closure, and result roots are written as create-only receipts outside the vault. Calling this irreversible requires independent append-only/WORM retention for that external directory; an ordinary writable directory is only tamper-evident. Reviewer IDs are process-bound pseudonyms rather than signatures, and source/runtime hashes still assume a trusted host.
- The global campaign lock pauses Harvester calibration writes, temporal labels, and exploratory diagnostics from registration through sealed evaluation. Capture resumes after the result receipt and does not alter the consumed frame.
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
brain_calibration_review_batch
brain_calibration_summary
brain_calibration_evaluate
brain_calibration_register_campaign
brain_calibration_close_campaign
brain_calibration_evaluate_sealed
```

## Scale Check

```bash
node cli.ts benchmark --out /tmp/obsidian-brain-benchmark --notes 5000 --force
```

The benchmark creates only synthetic Markdown and writes `benchmark-report.md` and `benchmark-report.json`.
