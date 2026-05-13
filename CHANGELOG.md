# Changelog

## Unreleased

### Added

- Public Beta CLI with `doctor`, `install-hooks`, `init`, `demo`, and `release-check`.
- Dry-run-first Claude Code hook installer with settings preservation and backups on apply.
- Synthetic demo vault generator and sample transcript fixture.
- Capture Review surface at `Maintenance/Capture Review.md`.
- Evidence Dashboard surface at `Knowledge/evidence.md`.
- Claude Code plugin template scaffold under `plugins/claude-code/`.
- Source ingest profiles for markdown, tickets, incident logs, and web exports.
- GitHub Actions CI for release checks on supported Node versions.
- Secret redaction and capture-safety policy for automatic session captures.
- Capture scoring fields for value, runbook readiness, and review need.
- Knowledge Inbox actions for confirming/rejecting provisional claims and previewing runbooks.
- Persistent Knowledge Inbox item state so reviewed items stop reappearing until their source changes.
- `repair-hooks` CLI command for dry-run-first Claude Code hook repair.
- `background` CLI command and `brain_run_background` MCP tool for unattended safe refresh jobs with locking and Markdown/JSON reports.
- `benchmark` CLI command for synthetic large-vault performance checks.
- `brain-quality` CLI command for deterministic golden-fixture quality gates.
- Dry-run-first brain metadata migration for older captures and claims.
- Change Ledger surface built from `.action-log.jsonl`.
- Production setup and "what gets written" documentation.
- Additional anonymized Claude Code transcript fixtures for research and troubleshooting sessions.
- Brain Quality Contract defining measurable gates for capture, retrieval, promotion, review, safety, and background behavior.
- Brain Quality fixtures for late-session capture updates, misspelled customer routing, retrieval ranking, claim extraction quality, promotion faithfulness, Knowledge Inbox review behavior, background operations, generated-surface redaction, and policy safety.

### Changed

- `generate_runbook` now supports dry-run previews through the MCP tool surface.
- Brain Dashboard links to Capture Review and Evidence Dashboard.
- Health checks include hook `VAULT_PATH` and new Public Beta surface policies.
- Auto-captures now include intent, scoring, redaction, and review metadata.
- Knowledge Harvester now reprocesses a session when the transcript changes instead of treating the first Stop hook as final.
- Generated Hot Cache and customer snapshots now hide snippets from credential/access-notes while keeping links visible.
- Claim extraction now filters assistant command tips and transient operational instructions more aggressively.
