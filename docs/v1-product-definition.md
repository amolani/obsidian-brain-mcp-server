# V1 Product Definition

This document freezes what "production-ready and intelligent" means for Obsidian Brain MCP v1.0.

It is intentionally not a brainstorm. New ideas belong in a later version unless they close one of these acceptance criteria.

## Product Goal

Obsidian Brain MCP v1.0 is production-ready when a technical user can install it, run Claude Code normally, and trust that useful work becomes structured Obsidian knowledge without unsafe automatic vault refactors.

It feels intelligent when it can explain what it captured, why it classified something the way it did, what it promoted, what it skipped, and what needs human review.

## V1.0 Acceptance Criteria

### 1. Installation And Release

Status: mostly done

Must have:

- CLI doctor for a real vault and demo vault.
- Dry-run-first hook installer with backup on apply.
- GitHub CI running typecheck, tests, and release-check.
- Release checklist and changelog discipline.
- Clear install path for Claude Code.

Done when:

- A fresh user can run `npm install`, `doctor`, `install-hooks`, and `brain_health_check` without reading code.
- CI is green on every push and pull request.

### 2. Capture Safety

Status: mostly done

Must have:

- No risky refactors from automatic hooks.
- Secret-like values are redacted before auto-captures are written.
- Capture policy can exclude sensitive working directories.
- Capture output marks sensitive/redacted sessions.
- Action log records writes.

Done when:

- Hooks can write captures and generated surfaces, but never apply merge, rename, folder reorg, broken-link rewrite, or link-suggestion apply automatically.
- A session containing token/password-like values does not persist the original secret in the capture.

### 3. Session Understanding

Status: mostly done

Must have:

- Client/project resolver with exact, content, and fuzzy path matching.
- Session intent classification.
- Capture scoring:
  - `capture_value`
  - `runbook_readiness`
  - `review_need`
- Source stage metadata:
  - `checkpoint`
  - `stop_capture`
  - `manual`
  - `auto_build`

Done when:

- A misspelled project folder can still route to a known customer and be surfaced for review.
- A research-only session is not treated like an implemented runbook.

### 4. Promotion Pipeline

Status: mostly done

Must have:

- Captures remain source artifacts.
- Derived knowledge is typed and traceable.
- Claims from checkpoints/captures start provisional.
- Runbooks only auto-promote from implemented procedural sessions.
- Auto-build manifest prevents duplicate promotion.
- Feedback can make noisy categories stricter.

Done when:

- A user can inspect why each auto-build step applied or skipped.
- No final runbook is created from an interim checkpoint alone.

### 5. Review Workflow

Status: partly done

Must have:

- Knowledge Inbox for provisional claims, uncertain clients, runbook candidates, skips, and impact reports.
- Dry-run-first inbox actions:
  - confirm provisional claim
  - reject provisional claim
  - preview runbook generation
  - show alias-learning suggestion
- Brain Review remains the broader maintenance view.

Still needed:

- Better inbox item lifecycle: accepted/rejected/snoozed state should persist per item.
- Optional batch review command for safe low-risk inbox items.

Done when:

- A user can clear the review queue without manually searching for every generated note.

### 6. Trust Surfaces

Status: mostly done

Must have:

- Brain Dashboard.
- Capture Review.
- Evidence Dashboard.
- Session Impact Report.
- Knowledge Inbox.
- Change Ledger from action log.
- Customer timeline and snapshot.

Done when:

- A user can answer "what did the Brain do recently?" from Obsidian Markdown alone.

### 7. Migration And Repair

Status: partly done

Must have:

- Dry-run-first metadata migration for older captures and claims.
- Repair checks for hook config.
- Repair checks for generated surfaces.

Still needed:

- `repair-hooks` or `install-hooks --repair` command.
- `doctor --fix` should remain dry-run-first and explicit.

Done when:

- An older vault can be upgraded without moving or renaming notes.

### 8. Scale And Robustness

Status: partly done

Must have:

- Tests for real-ish transcripts.
- Tests for secret redaction.
- Tests for metadata migration.
- Tests for inbox actions and generated surfaces.
- Performance sanity check for larger vaults.

Still needed:

- Synthetic large-vault benchmark, e.g. 5k notes.
- More anonymized Claude Code transcript fixtures.

Done when:

- Release-check catches common regressions before publish.

### 9. Documentation And Demo

Status: partly done

Must have:

- GitHub README with clear value proposition.
- Public beta guide.
- Demo vault.
- Screenshots or GIFs showing before/after.
- Example flow: session capture -> impact report -> inbox -> runbook/claim review.

Still needed:

- Better visual demo assets from the current feature set.
- A short "what gets written to my vault?" page with examples.

Done when:

- A new user understands the product before installing it.

## V1.1 Or Later

These are useful but not required for v1.0:

- Optional LLM-assisted classifier with local/off switch.
- Rich web UI.
- Multi-vault sync.
- Obsidian plugin package with settings UI.
- Team/shared-vault collaboration model.
- External ticket-system integrations.

## Explicit Non-Goals For V1.0

- Automatic duplicate merge.
- Automatic note rename.
- Automatic folder reorganization.
- Automatic broken-link rewrite.
- Automatic link suggestion apply.
- Automatic working-memory injection.
- Uploading private vault content to a hosted service.

## Remaining V1.0 Work Queue

1. Persist Knowledge Inbox item state.
2. Add hook repair command.
3. Add large-vault benchmark.
4. Add more anonymized transcript fixtures.
5. Build visual demo assets/screenshots for README.
6. Add "what gets written" documentation page.
