# Session Digest Contract

This contract defines the first measurable "intelligent summary" layer for generated
Claude/Codex session captures.

It extends the Scientific Engineering Contract and Brain Quality Contract. The goal is
not a nicer prose summary. The goal is a compact, evidence-backed digest that makes the
useful technical outcome of a session visible without promoting unsupported knowledge or
leaking sensitive material.

## Hypothesis

Generated stop captures become easier to review and reuse when they contain a structured
Session Digest with:

- problem,
- root cause,
- change made,
- verification,
- review signals,
- explicitly excluded unsafe material.

This should reduce cognitive load while keeping capture recall high and durable
promotion precision protected.

## Mechanism

Version 1 is deterministic and runs inside the existing knowledge-harvester Stop hook.

The harvester appends a `## Session Digest` section to generated stop-capture notes. It
does not create a separate note, does not confirm claims, does not move files, and does
not create or modify customer aliases.

The digest renderer may use only evidence already present in the parsed transcript or
generated capture inputs:

- user request text,
- assistant summary text,
- successful or failed command outcomes already accepted into the capture pipeline,
- capture metadata such as intent, client match method, and redaction count.

LLM-generated freeform inference is not part of V1.

## V1 Required Output

For troubleshooting and implementation captures, the digest should emit stable sections:

```text
## Session Digest

### Problem
...

### Root Cause
...

### Änderung / Fix
...

### Verifikation
...

### Review
...

### Nicht übernommen
...
```

Sections with no evidence must contain `- Keine belastbare Aussage erkannt` instead of
inventing content.

## SOLL-Zustände

- The digest is present in generated stop captures with enough substance.
- The digest summarizes the session outcome before raw command lists.
- Root cause and verification are copied only when evidence exists.
- Unknown customer/project candidates are surfaced as review signals, not auto-applied.
- Password changes, `.env` probes, auth files, tokens, literal passwords, and long
  shell/Samba/SSH command lists are not copied into the digest.
- Debug narration such as "Drei Hinweise sind wichtig" or "das ist der entscheidende
  Hinweis" is not treated as durable knowledge.
- Digest content remains provisional capture context, not a confirmed claim.
- Checkpoints may inform review, but the V1 digest is written only to stop captures.

## Non-Goals

- No LLM judge dependency for safety-critical behavior.
- No automatic client alias creation.
- No automatic runbook generation.
- No final claim confirmation.
- No risky vault reorganization.
- No separate generated dashboard surface in V1.

## Scientific / Mathematical Basis

The digest is evaluated as a classification and information extraction task:

- required fact recall for expected problem/root-cause/fix/verification facts,
- precision-biased noise rejection for forbidden debug narration and unsafe commands,
- hard safety gates for secret leakage.

This maps to the Brain Quality Contract defaults:

- capture remains recall-biased,
- digest and promotion-adjacent summaries are precision-biased,
- secret leakage is a hard fail.

## Metrics

Required V1 metrics:

```text
digest_required_fact_recall >= 0.85
digest_noise_count == 0
digest_secret_leak_count == 0
digest_command_leak_count == 0
unsupported_digest_fact_count == 0 for fixture-labeled facts
```

Current implementation maps these to deterministic Brain Quality fixture checks:

- expected digest facts must appear in the generated capture,
- forbidden patterns must not appear in generated capture content,
- secret and raw command hard gates remain zero-tolerance.

## Fixture Requirements

Every new digest behavior must have a fixture before or with implementation.

V1 fixture requirements:

- at least one troubleshooting session with problem, root cause, fix, and verification,
- at least one unknown customer/project candidate,
- at least one sensitive password or command-heavy step that must not appear,
- expected digest facts and forbidden noise patterns.

The initial V1 fixture is based on the Abt-Ulrich-Schule linuxmuster-webui/Ajenti
debugging session, but the fixture name and assertions must describe the generic
behavior, not a customer-specific exception.

## Safety

The following remain hard gates:

```text
secret_leak_count == 0
risky_auto_apply_violations == 0
protected_path_write_violations == 0
idempotency_violations == 0
archived_raw_capture_in_active_surface == 0
```

Digest-specific forbidden content:

- literal passwords,
- token/password assignment syntax,
- `--newpassword` values,
- `.env` file contents or probes,
- credential/auth file snippets,
- long SSH/Samba/shell command lists,
- internal task notifications and `toolu_` IDs.

## Acceptance

A digest behavior change is release-ready only after:

```bash
npm run brain-quality
npm run release-check
```

The final commit message must identify whether the change affects capture, digest,
promotion, or safety behavior.
