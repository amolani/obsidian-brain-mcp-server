# Brain Quality Contract v1

This document defines measurable quality for Obsidian Brain MCP.

It complements `docs/v1-product-definition.md`.

- The product contract defines what the Brain must do.
- This quality contract defines how we measure whether it does those things well enough.

The goal is not to make the system look intelligent. The goal is to make failure visible before a real vault is damaged, polluted, or deprived of important session knowledge.

## Quality Philosophy

The Brain has two different quality targets.

Capture is recall-biased:

- Prefer keeping many useful observations.
- Allow some review noise.
- Do not lose late-session findings.
- Never leak secrets.
- Never create duplicates for the same unchanged transcript.

Promotion is precision-biased:

- Promote only traceable, grounded knowledge.
- Keep weak or ambiguous material provisional.
- Route uncertainty to review.
- Never convert an interim checkpoint into final knowledge without enough evidence.

This gives the core rule:

```text
Capture should maximize recall under safety constraints.
Promotion should maximize precision under traceability constraints.
```

## Evaluation Levels

The quality harness should evaluate the Brain at five levels.

### L0: Safety Gates

Deterministic checks that must always pass.

Examples:

- no secret leaks,
- no risky automatic vault refactors,
- no protected-path writes,
- no unsafe policy drift,
- no duplicate generated notes from repeated identical input.

L0 failures are release blockers. They are not averaged into a score.

### L1: Golden Transcript Fixtures

Replay anonymized Claude Code transcripts with known expected facts, noise, clients, and expected generated outputs.

These fixtures should include real failure modes:

- late findings after an early Stop hook,
- misspelled customer folders,
- command-heavy troubleshooting sessions,
- sensitive credential notes referenced during work,
- research sessions that must not become final runbooks,
- long terminal sessions with checkpoints.

### L2: Retrieval Benchmark

Run fixed queries against a fixture vault and measure whether the right notes appear in the top results.

This covers:

- `vault_search`,
- `semantic_search`,
- `get_note_context`,
- context packs,
- generated hot cache behavior.

### L3: Vault Simulation

Run safe background jobs against demo and synthetic vaults.

This covers:

- background locking,
- action logs,
- generated surfaces,
- review queue stability,
- large-vault performance,
- idempotent rebuilds.

### L4: Optional Judge-Based Review

LLM-as-judge can be used for exploratory scoring of faithfulness, relevance, and summarization quality.

It must not be the only guard for safety-critical behavior. Deterministic gates stay authoritative for secrets, risky actions, protected paths, idempotency, and policy compliance.

## Fixture Contract

Every golden fixture should have a machine-readable expectation file.

Recommended structure:

```json
{
  "id": "hug-vpn-nas-2026-05-13",
  "description": "VPN test followed by late NAS discovery",
  "transcript": "fixtures/transcripts/hug-vpn-nas.jsonl",
  "vault": "fixtures/vaults/hug",
  "expectedClient": "HUG",
  "expectedFacts": [
    {
      "id": "vpn-route",
      "text": "Route 192.168.1.0/24 via tun0",
      "requiredIn": ["capture", "review"]
    }
  ],
  "forbiddenClaims": [
    "sudo needs a password",
    "copy this command"
  ],
  "forbiddenSecrets": [
    "literal password values from credential notes"
  ],
  "expectedQueries": [
    {
      "query": "HUG VPN NAS Synology",
      "relevantNotes": ["Kunden/HUG/Captures/HUG - VPN Test.md"]
    }
  ]
}
```

The harness should treat expected facts as semantic facts, not exact text-only strings. A fact can pass if the generated note preserves the same key entities, relationship, and operational meaning.

## Core Metrics

### Capture Recall

Measures whether important session facts were captured.

```text
capture_recall = captured_expected_facts / total_expected_facts
```

Default threshold:

```text
capture_recall >= 0.85
```

For critical regression fixtures, such as late-session findings, specific expected facts can be marked `must_capture: true`. Missing any `must_capture` fact fails the fixture even if aggregate recall passes.

### Capture Precision

Measures how much captured content is useful instead of transient command chatter or assistant instructions.

```text
capture_precision = useful_captured_facts / all_captured_facts
```

Default threshold:

```text
capture_precision >= 0.65
```

Capture can tolerate some noise because review and promotion are stricter.

### Capture F2

Capture quality uses F2 because recall matters more than precision at this stage.

```text
F_beta = (1 + beta^2) * precision * recall / ((beta^2 * precision) + recall)
capture_f2 = F_beta with beta = 2
```

Default threshold:

```text
capture_f2 >= 0.80
```

### Temporal Completeness

Measures whether the final capture includes facts that appeared after an earlier partial hook run.

```text
temporal_completeness = final_captured_expected_facts / final_expected_facts
```

Default threshold:

```text
temporal_completeness == 1.00 for append/update fixtures
```

Required invariant:

```text
If transcript_hash changes, the session is eligible for reprocessing.
If transcript_hash is unchanged, no duplicate capture/update should be written.
```

### Idempotency

Repeated identical input must not create additional generated notes, duplicate Daily links, duplicate claims, or duplicate review items.

```text
idempotency_violations = duplicate_notes + duplicate_links + duplicate_claims + duplicate_review_items
```

Default threshold:

```text
idempotency_violations == 0
```

### Noise Rejection

Measures whether transient assistant instructions are kept out of durable claims.

```text
noise_rejection = rejected_noise_items / expected_noise_items
```

Default threshold:

```text
noise_rejection >= 0.90
```

Examples of noise:

- "copy this command",
- "sudo needs a password",
- "once started, I will check the log",
- plain shell command tips,
- temporary next-step narration without durable customer or technical meaning.

### Client Routing Accuracy

Measures whether the Brain routes a session to the correct customer or flags uncertainty.

```text
client_accuracy = correct_client_routes / evaluated_sessions
```

Default thresholds:

```text
client_accuracy >= 0.90
false_confident_client_routes <= 0.02
```

A misspelled folder can still pass if the Brain routes correctly and creates a review signal for alias/folder cleanup instead of silently reorganizing the vault.

## Promotion Metrics

### Promotion Precision

Measures whether promoted durable notes are actually durable knowledge.

```text
promotion_precision = valid_promoted_items / all_promoted_items
```

Default threshold:

```text
promotion_precision >= 0.90
```

### Promotion F0.5

Promotion quality uses F0.5 because precision matters more than recall at this stage.

```text
promotion_f0_5 = F_beta with beta = 0.5
```

Default threshold:

```text
promotion_f0_5 >= 0.85
```

### Faithfulness

Measures whether generated claims, runbooks, answers, and dashboards are supported by source material.

```text
faithfulness = source_supported_statements / generated_statements
```

Default threshold:

```text
faithfulness >= 0.90
```

For credential, security, or customer-critical outputs:

```text
faithfulness >= 0.95
```

### Evidence Coverage

Measures whether promoted claims have explicit provenance.

```text
evidence_coverage = promoted_items_with_source / promoted_items
```

Default threshold:

```text
evidence_coverage >= 0.85
```

Hard requirements:

```text
checkpoint_to_final_runbook_count == 0
untraced_promoted_claims == 0 for security/customer-critical claims
```

## Retrieval Metrics

Use standard information-retrieval metrics on a query set.

### Precision@k

```text
precision_at_k = relevant_results_in_top_k / k
```

Default threshold:

```text
precision_at_5 >= 0.60
```

### Recall@k

```text
recall_at_k = relevant_results_in_top_k / total_relevant_results
```

Default threshold:

```text
recall_at_5 >= 0.80
```

### MRR@k

Mean Reciprocal Rank rewards finding the first relevant result early.

```text
mrr = average(1 / rank_of_first_relevant_result)
```

Default threshold:

```text
mrr_at_5 >= 0.90
```

### nDCG@k

Normalized Discounted Cumulative Gain rewards relevant notes appearing higher in ranked results and supports graded relevance.

Default threshold:

```text
ndcg_at_5 >= 0.85
```

## Review Metrics

### Review Coverage

Measures whether uncertain or provisional items are visible to the user.

```text
review_coverage = expected_review_items_present / expected_review_items
```

Default threshold:

```text
review_coverage >= 0.90
```

### Review Item Stability

The same source and finding should produce the same review item ID until the source changes.

```text
review_item_stability = stable_item_ids / repeated_item_ids
```

Default threshold:

```text
review_item_stability == 1.00
```

### Reappearance Control

Accepted/rejected/snoozed items must not reappear unless their source hash or decision-relevant content changes.

```text
resolved_item_reappearance_count == 0
```

## Safety Metrics

Safety metrics are hard gates.

```text
secret_leak_count == 0
risky_auto_apply_violations == 0
protected_path_write_violations == 0
destructive_action_without_dry_run == 0
generated_surface_secret_snippet_count == 0
hosted_private_vault_upload_count == 0
```

Risky automatic actions remain forbidden:

- merge duplicate notes,
- rename notes,
- move/reorganize folders,
- rewrite broken links,
- apply link suggestions,
- resolve knowledge gaps,
- confirm weak claims,
- inject working memory automatically,
- upload private vault content.

## Background And Operations Metrics

### Background Report Completeness

Every unattended run must produce an inspectable result.

```text
background_report_completeness = reports_with_status_duration_jobs_skips_failures / background_runs
```

Default threshold:

```text
background_report_completeness == 1.00
```

### Action Log Completeness

Every write should be represented in the action log or a generated report.

```text
action_log_completeness = logged_writes / actual_writes
```

Default threshold:

```text
action_log_completeness >= 0.98
```

### Lock Correctness

Concurrent background runs must not write concurrently.

```text
concurrent_write_violations == 0
```

### Runtime Budget

Runtime should be evaluated against a checked-in baseline for the release machine or CI profile.

Default rule:

```text
runtime_regression <= 20 percent against baseline
```

For policy-limited hooks:

```text
hook_runtime_ms <= policy automation limit unless explicitly skipped with reason
```

## Overall Score

The overall Brain Quality Score is only computed if all hard safety gates pass.

```text
if any_hard_gate_fails:
  brain_quality_score = 0
else:
  brain_quality_score =
    0.25 * capture_score +
    0.20 * retrieval_score +
    0.20 * promotion_score +
    0.15 * review_score +
    0.10 * background_score +
    0.05 * performance_score +
    0.05 * maintainability_score
```

Release interpretation:

```text
90-100: pass for v1.0 production-ready release
80-89: warn; acceptable for beta, not for v1.0 tag
0-79: fail
```

## Maintainability Signals

These do not replace behavior tests, but they help prevent quality drift.

Required:

- `npm run typecheck` passes,
- `npm test` passes,
- `npm run release-check` passes,
- `git diff --check` passes before commit.

Recommended:

- property-based tests for parsers, redaction, path normalization, and idempotency,
- mutation testing for scoring and safety-sensitive branches,
- fixture minimization for every real bug that was fixed.

Mutation score is a useful test-suite quality signal, but it should start as `warn` until the project has a stable mutation-testing setup.

## Initial Required Fixtures

The first harness version should include these fixture classes:

1. Late-session update fixture based on the HUG VPN/NAS failure mode.
2. Misspelled customer path fixture based on the Duesseldorf spelling issue.
3. Credential-note reference fixture ensuring generated surfaces redact secrets.
4. Research-only fixture that produces captures/review but no final runbook.
5. Checkpoint fixture ensuring interim checkpoints do not become final durable knowledge by themselves.
6. Duplicate Stop fixture ensuring repeated unchanged transcripts are idempotent.
7. Retrieval fixture with customer, VPN, DNS, runbook, and credential-intent queries.
8. Background run fixture validating lock, report, action log, and safe-only job set.

## Current Harness Command

The first deterministic implementation runs with:

```bash
npm run brain-quality
```

or directly:

```bash
node cli.ts brain-quality --fixtures tests/fixtures/brain-quality
```

It currently evaluates checked-in fixture JSON files for:

- late-session Harvester updates,
- misspelled customer routing,
- retrieval ranking with Precision@k, Recall@k, MRR@k, and nDCG@k,
- promotion quality with Precision, Recall, F0.5, Faithfulness, and Evidence Coverage,
- Knowledge Inbox review coverage, stable item IDs, and resolved-item reappearance control,
- background report completeness, action-log coverage, lock correctness, and failed-job count,
- generated-surface redaction,
- policy safety gates.

`npm run release-check` runs the harness after typecheck and tests.

## References

The contract uses established evaluation concepts from:

- Information retrieval evaluation: precision, recall, F-measure, ranked retrieval, MAP/MRR/nDCG from Manning, Raghavan, and Schuetze, *Introduction to Information Retrieval*: https://nlp.stanford.edu/IR-book/html/htmledition/irbook.html
- Ranked retrieval evaluation: https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html
- TREC/trec_eval standard measures: https://deepwiki.com/usnistgov/trec_eval/4.1-standard-ir-measures
- BEIR benchmark metrics: https://github.com/beir-cellar/beir/wiki/Metrics-available
- RAGAS metrics for RAG evaluation: https://docs.ragas.io/en/v0.4.1/concepts/metrics/available_metrics/
- RAGAS paper: https://huggingface.co/papers/2309.15217
- ARES paper for RAG evaluation dimensions: https://huggingface.co/papers/2311.09476
- QuickCheck property-based testing: https://research.chalmers.se/en/publication/237427
- Hypothesis property-based testing: https://joss.theoj.org/papers/10.21105/joss.01891
- Mutation testing as a test-suite quality signal: https://link.springer.com/article/10.1007/s11219-020-09534-x

## Non-Goals

This contract does not require:

- hosted telemetry,
- hosted processing of private vault content,
- automatic vault reorganization,
- automatic claim confirmation,
- a single all-knowing LLM judge,
- perfect capture precision.

The system should remain local-first, inspectable, and conservative where user trust matters.
