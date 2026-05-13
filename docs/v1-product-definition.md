# V1.0 Product Contract

This document defines what "production-ready and intelligent" means for Obsidian Brain MCP v1.0.

It is the project contract. New ideas do not automatically become scope. They must either close a gap in this document or be explicitly moved to v1.1+.

## Why This Contract Exists

The project should not require repeated open-ended brainstorming about "what features are still needed." v1.0 must have a fixed target state:

- It runs reliably in the background.
- It captures useful Claude Code work.
- It builds durable Obsidian knowledge.
- It explains what it did.
- It queues uncertainty for review.
- It never performs risky vault refactors automatically.

The goal is not to make the system look busy. The goal is to make it trustworthy enough that it can run while the user is not sitting at the computer.

## Product Goal

Obsidian Brain MCP v1.0 is a local-first technical second brain for Claude Code and Obsidian.

It is production-ready when a technical user can install it, work normally, leave it running, and later inspect exactly:

- what was captured,
- what was promoted,
- what was skipped,
- what needs review,
- what evidence is weak or stale,
- what changed in the vault,
- and whether the system is healthy.

It feels intelligent when it behaves like a careful assistant with memory:

- it notices meaningful work,
- routes it to the right customer or topic,
- classifies intent,
- separates observations from confirmed knowledge,
- promotes only when evidence and structure are good enough,
- learns from rejected/noisy output,
- and exposes uncertainty instead of hiding it.

## Core Principle

The Brain may automatically create and refresh generated knowledge surfaces.

The Brain must not automatically perform destructive or identity-changing maintenance.

Allowed automatic writes:

- session captures,
- checkpoints,
- generated dashboards,
- generated indexes,
- generated review surfaces,
- provisional claims,
- evidence metadata on generated/captured notes,
- customer timelines and snapshots,
- action logs,
- change ledger,
- auto-build reports,
- session impact reports.

Never automatic:

- merge duplicate notes,
- rename notes,
- reorganize folders,
- rewrite broken links,
- apply link suggestions,
- resolve knowledge gaps,
- silently confirm claims,
- inject working memory into a session without explicit user action,
- upload private vault content to any hosted service.

## Operating Model

v1.0 has four operating modes.

### 1. Interactive Session Mode

Triggered by Claude Code hooks.

Responsibilities:

- SessionStart loads customer context and creates the daily note when policy allows it.
- PostToolUse tracks long terminal-heavy sessions and writes debounced checkpoints.
- Stop runs the Knowledge Harvester for substantial sessions.
- Auto-build processes fresh captures within policy limits.

Acceptance criteria:

- Hooks are installable and repairable.
- Hooks are idempotent.
- Hooks fail closed: if they cannot safely write, they log/skip instead of corrupting the vault.
- Hook output is concise and does not interrupt normal Claude Code work.

### 2. Background Brain Mode

Runs without the user present, ideally through a local scheduler such as cron, systemd timer, launchd, or a future `obsidian-brain daemon`.

Responsibilities:

- run health checks,
- refresh generated dashboards and indexes,
- rebuild Knowledge Inbox,
- rebuild Change Ledger,
- run evidence recheck scheduling,
- detect stale/generated surfaces,
- detect unreviewed provisional knowledge,
- optionally process queued safe auto-build work,
- never apply risky maintenance.

Acceptance criteria:

- A scheduled run can execute without interactive input.
- Every run has a lock to avoid concurrent writes.
- Every run has a time budget.
- Every run writes an action-log entry or no-op reason.
- Every run can be inspected later from Markdown.
- Failed jobs are visible in a health/schedule surface.

### 3. Review Mode

Used when the user comes back.

Responsibilities:

- show the Knowledge Inbox,
- show Session Impact Reports,
- show Brain Review,
- let the user confirm/reject provisional claims,
- preview runbooks,
- surface uncertain client matches,
- surface noisy auto-build output,
- record feedback.

Acceptance criteria:

- The user can clear review work without manually searching the vault.
- Every review item has an ID, status, target, reason, and recommended action.
- Every action is dry-run-first unless explicitly safe and already reviewed.

### 4. Recovery And Repair Mode

Used when config, hooks, metadata, or generated surfaces drift.

Responsibilities:

- detect broken hook config,
- repair hook config with preview and backup,
- migrate old capture/claim metadata,
- rebuild generated surfaces,
- validate policy,
- report unsafe policy changes.

Acceptance criteria:

- A user can run one command to see what is broken.
- A user can run one dry-run repair command to preview fixes.
- Repair never moves/renames user notes.

## "Brain" Capabilities

The system should behave like a brain in the following concrete ways.

### Perception

It observes:

- current working directory,
- Claude transcript structure,
- Bash commands,
- command results,
- error/fix cycles,
- user requests,
- assistant summaries,
- existing vault context,
- clients and aliases.

Must have:

- robust transcript parsing,
- client resolver with exact, content, and fuzzy matching,
- sensitive content detection and redaction,
- minimum-substance gates to avoid capturing noise.

### Attention

It decides what deserves attention.

Must have:

- session intent classification,
- capture scoring,
- runbook readiness scoring,
- review need scoring,
- provisional-vs-confirmed lifecycle,
- stale evidence detection,
- open question/contradiction surfacing.

Acceptance criteria:

- Research, planning, implementation, troubleshooting, documentation, and meeting-like sessions do not follow the same promotion path.
- High review need gets routed to Knowledge Inbox.
- High runbook readiness gets a runbook preview candidate, not an unconditional final runbook.

### Memory Formation

It stores raw experience and then builds derived knowledge.

Must have:

- source capture remains intact,
- derived insight/answer/claim/runbook points back to source,
- source stage is recorded,
- claim status is recorded,
- confidence and evidence fields exist,
- auto-build manifest prevents repeated promotion of identical source content.

Acceptance criteria:

- A user can trace a claim/runbook back to the capture or source that produced it.
- A checkpoint can create provisional review candidates, but not final runbooks by itself.

### Consolidation

It periodically turns scattered work into useful surfaces.

Must have:

- Brain Dashboard,
- Knowledge Index,
- Hot Cache,
- Customer Timeline,
- Customer Snapshot,
- Capture Review,
- Evidence Dashboard,
- Knowledge Inbox,
- Session Impact Report,
- Change Ledger.

Acceptance criteria:

- After unattended background runs, the user can open Obsidian and understand the current state without asking the MCP server.

### Recall

It retrieves context when explicitly asked.

Must have:

- vault search,
- semantic search,
- note context,
- context packs,
- manual recall only by policy.

Acceptance criteria:

- The system can answer "what do we know about X?" from local vault files.
- It does not inject working memory automatically into sessions.

### Reflection

It evaluates its own behavior.

Must have:

- Brain Metrics,
- Brain Quality Contract,
- feedback summary,
- auto-build usefulness score,
- archived/noisy auto-build learning,
- action log,
- change ledger,
- health check.

Acceptance criteria:

- The user can tell whether auto-build is useful or noisy.
- The project has measurable gates for capture recall, promotion precision, retrieval quality, idempotency, and safety.
- Rejected categories become stricter.
- Recent writes are visible without inspecting `.action-log.jsonl`.

### Self-Repair

It detects and repairs its own operating surfaces.

Must have:

- hook install/repair preview,
- metadata migration,
- generated surface rebuild,
- policy validation,
- CI/release-check.

Acceptance criteria:

- An old vault can be brought forward without risky reorganization.
- Broken hooks can be repaired without overwriting unrelated Claude settings.

## V1.0 Required Features

### A. Installation And Release

Status: mostly done

Required:

- CLI doctor for real and demo vaults.
- Dry-run-first hook installer with backup on apply.
- Hook repair command.
- GitHub CI running typecheck, tests, and release-check.
- Release checklist.
- Changelog discipline.
- Clear Claude Code setup path.
- Demo vault.

Done when:

- A fresh user can run `npm install`, `doctor`, `install-hooks`, `brain_health_check`.
- CI is green on push/PR.
- Hook repair can fix missing SessionStart, Stop, and PostToolUse Bash checkpoint hooks.

### B. Capture Safety

Status: mostly done

Required:

- No risky refactors from hooks.
- Secret-like values redacted before capture write.
- Capture policy can exclude sensitive CWD patterns.
- Capture output marks sensitive/redacted sessions.
- Action log records every write.
- Change ledger renders recent writes.
- Protected paths enforced.

Done when:

- A transcript containing token/password-like content does not persist the original secret.
- The user can inspect recent writes from `Maintenance/Change Ledger.md`.

### C. Session Understanding

Status: mostly done

Required:

- Client/project resolver:
  - exact CWD,
  - exact content,
  - fuzzy CWD,
  - alias suggestion.
- Intent classification:
  - implementation,
  - troubleshooting,
  - research,
  - planning,
  - documentation,
  - meeting,
  - unknown.
- Capture scores:
  - `capture_value`,
  - `runbook_readiness`,
  - `review_need`.
- Source stage:
  - `checkpoint`,
  - `stop_capture`,
  - `manual`,
  - `auto_build`.

Done when:

- A misspelled customer folder is routed but still surfaced for review.
- Research-only sessions do not become final runbooks.
- Captures explain why they were classified.

### D. Promotion Pipeline

Status: mostly done

Required:

- Captures remain source artifacts.
- Derived notes are traceable.
- Claims from checkpoints/captures start provisional.
- Runbooks only auto-promote from implemented procedural sessions.
- Manifest prevents duplicate promotion.
- Feedback can make noisy categories stricter.
- Auto-build report explains applied/skipped steps.
- Session Impact Report explains session-level effects.

Done when:

- A user can inspect why each auto-build step applied or skipped.
- No final runbook is created from an interim checkpoint alone.

### E. Review Workflow

Status: partly done

Required:

- Knowledge Inbox includes:
  - provisional claims,
  - uncertain client matches,
  - runbook candidates,
  - auto-build skips,
  - impact reports,
  - actionable item IDs.
- Inbox actions:
  - confirm claim,
  - reject claim,
  - preview runbook,
  - show alias suggestion.
- Persistent item state:
  - open,
  - accepted,
  - rejected,
  - snoozed,
  - superseded.
- Batch review for safe low-risk items.

Done when:

- A user can clear the review queue without searching manually.
- Cleared items do not keep reappearing unless their source changes.

### F. Background Scheduler

Status: not done

Required:

- `brain_run_background` or CLI equivalent.
- Local scheduler instructions for systemd/cron.
- Job lock file.
- Runtime budget.
- Per-job result report.
- Safe job set:
  - health check,
  - metrics,
  - brain dashboard,
  - capture review,
  - evidence dashboard,
  - knowledge inbox,
  - change ledger,
  - knowledge index,
  - customer snapshots/timelines,
  - schedule proposal.
- Optional job set:
  - auto-build queued captures,
  - metadata migration preview,
  - semantic index rebuild dry-run/preview.

Not allowed in background scheduler:

- merge duplicates,
- rename notes,
- organize folders,
- rewrite broken links,
- apply link suggestions,
- confirm claims.

Done when:

- The user can leave the machine running and later inspect a background run report.
- Background jobs are idempotent.
- Concurrent runs are prevented.

### G. Trust Surfaces

Status: mostly done

Required:

- Brain Dashboard.
- Capture Review.
- Evidence Dashboard.
- Session Impact Report.
- Knowledge Inbox.
- Change Ledger.
- Customer Timeline.
- Customer Snapshot.
- Background Run Report.

Done when:

- The user can answer "what did the Brain do recently?" from Obsidian Markdown alone.

### H. Migration And Repair

Status: partly done

Required:

- Dry-run metadata migration for older captures and claims.
- Hook repair.
- Generated-surface repair.
- Policy validation.
- Config diagnostics.

Done when:

- An older vault can be upgraded without moving or renaming notes.
- A broken hook setup can be repaired with preview and backup.

### I. Scale And Robustness

Status: partly done

Required:

- Real-ish transcript fixtures.
- Secret-redaction tests.
- Migration tests.
- Inbox action tests.
- Generated surface tests.
- Large vault benchmark:
  - 1k notes,
  - 5k notes,
  - optionally 20k notes.
- Runtime budget assertions for background jobs.

Done when:

- Release-check catches common regressions.
- Large-vault benchmark produces stable metrics.

### J. Documentation And Demo

Status: partly done

Required:

- README value proposition.
- Public beta guide.
- Demo vault.
- "What gets written to my vault?" page.
- Before/after session walkthrough.
- Screenshots or GIFs:
  - Session Impact,
  - Knowledge Inbox,
  - Change Ledger,
  - Evidence Dashboard.
- Production setup guide:
  - install,
  - health check,
  - background scheduler,
  - backup expectations,
  - safe review workflow.

Done when:

- A new user understands the product before installing it.
- A user can run it unattended without reading source code.

## Background Brain Contract

The unattended background system is the main remaining leap from "good tool" to "brain running in the background."

### Background Run Input

The runner needs:

- vault path,
- policy,
- job list,
- max runtime,
- lock path,
- dry-run/apply mode,
- optional client scope,
- optional quiet mode.

### Background Run Output

Every run must produce:

- machine-readable result,
- Markdown report,
- action-log entry,
- job summaries,
- skipped reasons,
- duration,
- failures,
- next recommended actions.

### Default Background Jobs

Default safe apply jobs:

1. `brain_health_check`
2. `brain_metrics`
3. `build_brain_dashboard`
4. `build_capture_review`
5. `build_evidence_dashboard`
6. `build_knowledge_inbox`
7. `build_change_ledger`
8. `build_knowledge_index`
9. `brain_schedule`

Default dry-run jobs:

1. `migrate_brain_metadata`
2. safe maintenance preview
3. semantic index status/rebuild preview
4. hook repair preview

Optional apply jobs, policy gated:

1. customer timeline rebuild,
2. customer snapshot rebuild,
3. auto-build unprocessed captures.

### Background Safety Rules

- A lock prevents concurrent runs.
- Each job has a timeout.
- The full run has a timeout.
- A failed job does not prevent later safe jobs unless the vault is unreadable.
- The runner records partial success.
- No job may mutate protected paths.
- No job may apply risky maintenance.
- Dry-run jobs must remain dry-run unless explicitly configured.

### Background Health Levels

The background report should produce a status:

- `ok`: all required jobs passed.
- `warn`: non-critical job failed or review queue is growing.
- `fail`: vault unreadable, policy invalid, hook config broken, or protected write attempted.

### Background "Intelligence" Signals

The runner should track:

- new captures since last run,
- provisional claims count,
- stale evidence count,
- uncertain client matches,
- runbook candidates,
- noisy auto-build runs,
- review backlog age,
- generated surface freshness,
- action-log write count,
- failed job count.

## User Trust Contract

The user should be able to trust the system because:

- it writes normal Markdown,
- it keeps source captures,
- it marks uncertainty,
- it never silently confirms weak claims,
- it logs writes,
- it redacts secrets,
- it does not restructure the vault without approval,
- it can explain every automatic step,
- it can be disabled through policy.

## V1.0 Release Gate

v1.0 can be tagged only when all of these are true:

- `npm run release-check` passes.
- `docs/brain-quality-contract.md` is current and the implemented harness gates pass.
- GitHub CI is green.
- `brain_health_check` is green on demo vault.
- Hook repair has tests.
- Background runner has tests.
- Secret redaction has tests.
- Metadata migration has tests.
- Knowledge Inbox item state has tests.
- Large-vault benchmark exists and is documented.
- "What gets written to my vault?" doc exists.
- README includes screenshots or GIFs for the core flow.

## V1.0 Implementation Queue

This is the fixed implementation queue. Completed items stay here to prevent scope drift.

1. Done: Persist Knowledge Inbox item state.
2. Done: Add `repair-hooks` / hook repair command.
3. Done: Add background runner for unattended safe jobs.
4. Done: Add Background Run Report surface.
5. Done: Add large-vault benchmark.
6. Done: Add more anonymized Claude Code transcript fixtures.
7. Done: Add "What gets written to my vault?" documentation.
8. Done: Add production setup guide for unattended scheduler.
9. Done: Build README screenshots/GIFs from demo output.
10. Pending release decision: Final release pass and version tag.

## V1.1 Or Later

These are useful but not required for v1.0:

- Optional LLM-assisted classifier with local/off switch.
- Rich web UI.
- Multi-vault sync.
- Obsidian plugin package with settings UI.
- Team/shared-vault collaboration model.
- External ticket-system integrations.
- Mobile review app.

## Explicit Non-Goals For V1.0

- Automatic duplicate merge.
- Automatic note rename.
- Automatic folder reorganization.
- Automatic broken-link rewrite.
- Automatic link suggestion apply.
- Automatic claim confirmation.
- Automatic working-memory injection.
- Hosted processing of private vault content.
- Remote telemetry by default.
