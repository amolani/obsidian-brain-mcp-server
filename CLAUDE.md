# Obsidian Brain MCP - Agent Guide

This file is the operational guide for Claude Code / Codex work in this repository.
It is intentionally short. Historical feature status belongs in docs, tests, and Git history.

## Project Goal

Obsidian Brain MCP is a local-first MCP server that turns Claude Code work into durable
Obsidian knowledge:

- session captures,
- customer and project context,
- evidence-backed claims,
- runbooks and review candidates,
- dashboards, indexes, hot cache, and health surfaces.

The system should feel intelligent because it is measurable, conservative, inspectable,
and useful after real work sessions. It must not look intelligent by generating noise.

## Required Startup Checks

At the beginning of project work, run:

```bash
git status --short --branch
```

Then run `brain_health_check` through the MCP tool and interpret the result.

Also verify that `~/.claude/settings.json` contains a `PostToolUse` hook with matcher
`"Bash"` pointing to `hooks/session-checkpoint.ts`.

If any check fails, fix readiness before adding features.

## Core Contracts

Read these before changing brain behavior:

- [Scientific Engineering Contract](docs/scientific-engineering-contract.md)
- [Session Digest Contract](docs/session-digest-contract.md)
- [V1.0 Product Contract](docs/v1-product-definition.md)
- [Brain Quality Contract](docs/brain-quality-contract.md)
- [Production Setup](docs/production-setup.md)
- [What Gets Written](docs/what-gets-written.md)

The scientific contract is mandatory for new "intelligence" work: no new brain behavior
without a hypothesis, metric, fixture, and release check.

## Safety Rules

- No risky vault action without a dry-run first.
- Never auto-apply merge, rename, broken-link fixes, folder reorgs, link suggestions,
  or knowledge-gap resolution.
- Working memory stays manual-only and optional.
- Raw material may be archived, not silently deleted.
- Every vault write must be observable through `.action-log.jsonl` or a clear no-op reason.
- Secrets, credentials, auth files, `.env` values, tokens, and literal passwords must not
  appear in generated surfaces.
- `claude-obsidian-main.zip` and `schön1.png` are local references and must not be committed.

## Development Workflow

For behavior changes:

1. Reproduce the problem with a focused fixture or test.
2. Implement the smallest code change that matches existing service patterns.
3. Run targeted tests.
4. Run `npm run release-check` before committing.
5. Commit with a focused conventional message.
6. Push only after the worktree is clean and checks passed.

For documentation-only changes:

1. Keep docs aligned with actual code and tests.
2. Prefer stable contracts over roadmap tables.
3. Avoid claiming scientific or neuroscience grounding unless the mechanism and metric are explicit.

## Quality Gates

The normal release gate is:

```bash
npm run release-check
```

This includes:

- TypeScript typecheck,
- full test suite,
- Brain Quality Harness,
- demo-vault health.

The Brain Quality Harness is the authority for measurable behavior. Important examples:

- capture uses recall-biased metrics such as F2,
- promotions and claims use precision-biased metrics such as F0.5,
- retrieval uses Precision@k, Recall@k, MRR@k, and nDCG@k,
- safety gates require zero secret leaks and zero risky auto-apply violations.

## Current Baseline

As of commit `c39a6e4`, capture hygiene and customer surfaces are hardened:

- tool notifications are filtered from captures,
- verbose/sensitive command blocks are excluded,
- read-only sessions with concrete findings can still be captured,
- archived raw captures are excluded from active customer dashboards, snapshots, and timelines,
- release-check passed with Brain Quality Harness score 97.8.

Treat this as the minimum baseline. Do not regress it.
