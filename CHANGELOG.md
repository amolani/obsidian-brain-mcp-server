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
- Dry-run-first brain metadata migration for older captures and claims.
- Change Ledger surface built from `.action-log.jsonl`.

### Changed

- `generate_runbook` now supports dry-run previews through the MCP tool surface.
- Brain Dashboard links to Capture Review and Evidence Dashboard.
- Health checks include hook `VAULT_PATH` and new Public Beta surface policies.
- Auto-captures now include intent, scoring, redaction, and review metadata.
