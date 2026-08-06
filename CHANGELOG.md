# Changelog

## Unreleased

### Added

- Copy-paste Claude Code setup prompt with OS detection, approval gates, private customer configuration, hook previews, MCP registration, and explicit end-to-end verification.
- Standalone beginner installation guide for macOS 14 or newer, covering Apple silicon and Intel, Homebrew, Node.js 24, Obsidian, Claude Code, private customer routing, MCP registration, hooks, verification, and macOS-specific troubleshooting.
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
- `brain_review_inbox_items` for bounded safe batch review plus accepted, rejected, snoozed, and superseded item lifecycle state.
- `repair_generated_surfaces` for dry-run-first, ownership-guarded reconstruction of fixed Brain surfaces.
- Explicit multi-signal adoption for recognizable pre-marker generated surfaces while foreign/manual files remain blocked.
- Checked-in 5k-note benchmark baseline, deterministic work limits, and comparable-machine regression enforcement.
- Hard per-job background timeouts in isolated workers and richer unattended-run health signals.
- Attested calibration-capture V3 bundles with a complete candidate-ID universe, exactly reproducible seeded sampling, blinded R-reference/evidence payloads, stable base IDs, temporal recheck IDs, and stale-review protection. Legacy V2 stays read-only and cannot enter a sealed campaign.
- `brain_calibration_review_batch` for role-separated, selection-blind human labels with opaque record tokens and unweighted overall progress; weighted/stratified diagnostics remain exclusive to the later evaluator, while calibration payloads stay out of generic knowledge surfaces and action logs.
- `record_calibration_judgement` for one-lock, one-write useful/supported pairs that become immutable after submission; identical retries are idempotent and divergent retries fail closed.
- `brain_calibration_evaluate` for IPW-weighted, strictly chronological leakage-group shadow evaluation with boundary embargo, monotone train-only probability calibration, Brier/log-loss/reliability/FPR diagnostics, MNAR bounds, and paired cluster-bootstrap intervals. It can never authorize a release.
- Two-phase `brain_calibration_register_campaign` and `brain_calibration_close_campaign` seals that bind the complete response frame, reviewer roster, label-independent cutoff, full-frame leakage components and train/test/embargo assignments, analysis plan, whole source/runtime hashes, and atomic label events to create-only external receipts. Apply is bound to the exact reviewed registration preview, while closure commits externally before its recoverable local copy.
- `brain_calibration_evaluate_sealed` for a one-shot, option-free evaluation over only the frozen campaign snapshot; exact retries replay the persisted, externally anchored result and never authorize a release or change weights.
- A global campaign lock that freezes Harvester calibration writes, temporal labels, and exploratory diagnostics between registration and sealed evaluation; normal capture resumes after the persisted result receipt.

### Changed

- README onboarding is now a single beginner-first Manjaro workflow with a disposable demo, verified Claude/MCP setup, first-capture walkthrough, expected health states, troubleshooting, updates, and removal guidance; advanced calibration details are separated from daily use.
- Claude Stop-hook repair now enforces asynchronous capture with a 120-second budget, and health checks flag stale timeout/async settings before they can truncate auto-build.
- Campaign locks now record their host identity and safely reclaim only old locks whose local owner is provably dead; foreign, active, legacy, and malformed locks remain fail-closed.
- Large-vault link and duplicate analysis now uses deterministic candidate indexes, bounded dashboard result sets, and checked performance/stability gates instead of quadratic review scans.
- `generate_runbook` now supports dry-run previews through the MCP tool surface.
- Brain Dashboard links to Capture Review and Evidence Dashboard.
- Health checks include hook `VAULT_PATH` and new Public Beta surface policies.
- Auto-captures now include intent, scoring, redaction, and review metadata.
- Knowledge Harvester now reprocesses a session when the transcript changes instead of treating the first Stop hook as final.
- Generated Hot Cache and customer snapshots now hide snippets from credential/access-notes while keeping links visible.
- Claim extraction now filters assistant command tips and transient operational instructions more aggressively.
- Generated review, inbox, metrics, evidence, and customer surfaces ignore archived notes as active work, and customer snapshots avoid re-ingesting generated customer surfaces.
- Policy and configuration validation now fail closed for incomplete, malformed, or unsafe values; all exposed tools have explicit policy entries.
- Fixed generated outputs and demo/benchmark directories now require exact ownership before replacement, and persistent JSON state uses atomic replacement.
- Vault indexing and guarded writes reject path traversal and symlink escapes; internal directory symlinks are not traversed.
- Risky executors and generated builders consistently preview by default, including legacy wrapper call shapes.
- Calibration state now keeps occurrence identity separate from semantic fact identity, and schema V2 records immutable sampling/time metadata without fact prose.
- The legacy single-label writer now accepts only temporal `still_valid` rechecks; useful/supported cannot bypass the atomic frozen judgement path through direct selectors.
