# Scientific Engineering Contract

This document defines how Obsidian Brain MCP may be made "more intelligent".

The project does not accept intelligence-by-vibe. New brain behavior must be grounded in
a known method, translated into an explicit software mechanism, and measured with a
repeatable fixture.

## Prime Directive

```text
No new brain intelligence without:
1. a hypothesis,
2. a cited or well-established method,
3. a mathematical metric,
4. a regression fixture,
5. a release-check pass.
```

If a feature cannot be measured, it stays a design note.

## Evidence Hierarchy

Prefer methods in this order:

1. deterministic safety invariants,
2. established information-retrieval or classification metrics,
3. reproducible fixtures from real anonymized sessions,
4. well-supported cognitive science translated into concrete mechanisms,
5. exploratory LLM-judge review as secondary signal only.

LLM-judge output must never be the only guard for safety-critical behavior such as
secrets, risky writes, policy drift, idempotency, or protected paths.

## Required Development Template

Every new brain feature or behavioral change must answer:

```text
Hypothesis:
  What user-visible behavior should improve?

Mechanism:
  What exact code path changes?

Scientific / mathematical basis:
  Which established method or metric applies?

Metric:
  What number must improve or stay within bounds?

Fixture:
  Which test data proves the behavior?

Safety:
  What must never happen?

Acceptance:
  Which command proves this is release-ready?
```

## Core Metrics

### Classification And Capture

Use precision, recall, and F-beta.

```text
precision = true_positives / (true_positives + false_positives)
recall    = true_positives / (true_positives + false_negatives)

F_beta = (1 + beta^2) * precision * recall
         / ((beta^2 * precision) + recall)
```

Project defaults:

- Capture uses F2 because losing useful session knowledge is worse than reviewable noise.
- Claim extraction and promotion use F0.5 because false durable knowledge is worse than
  missing a weak claim.
- Safety gates are not averaged. A secret leak or risky auto-apply violation is a hard fail.

### Retrieval

Use ranked retrieval metrics for search, semantic search, context packs, hot cache, and
dashboard surfacing:

- Precision@k,
- Recall@k,
- Mean Reciprocal Rank (MRR@k),
- normalized Discounted Cumulative Gain (nDCG@k).

The expected note should appear near the top, not just somewhere in the vault.

### Knowledge Promotion

Promotion must measure:

- precision of promoted knowledge,
- recall of expected durable facts,
- faithfulness to source,
- evidence coverage,
- forbidden-noise count,
- forbidden-secret count.

Default rule:

```text
source capture can be recall-biased.
durable promoted knowledge must be precision-biased and source-grounded.
```

### Agreement For Human Labels

If fixtures depend on manually labeled expected facts, use reviewer agreement when labels
become disputed or ambiguous.

Preferred metric:

```text
Cohen's kappa for two annotators
```

Do not tune the system to one person's inconsistent labels without recording the decision.

## Cognitive And Neuroscience Translation Rules

The project may use brain-like language only when it maps to a concrete mechanism.

| Brain-like term | Allowed software meaning | Required measurement |
|---|---|---|
| Perception | transcript parsing, command/result extraction, client detection | capture recall, noise rejection |
| Attention | selecting what enters review, hot cache, dashboards | Precision@k, review coverage |
| Working memory | manual-only short-term context surface | no automatic injection, freshness |
| Consolidation | auto-build promotion from capture to durable notes | promotion precision, faithfulness |
| Retrieval | vault search, semantic search, context packs | MRR@k, nDCG@k, Recall@k |
| Forgetting | archiving, stale evidence, recheck dates | archive exclusion, stale surfacing |
| Error correction | feedback learning and regression fixtures | rejected-noise recurrence count |

Do not implement vague "neural" or "brain-like" features. Implement mechanisms.

## Cognitive Load Rules

Generated surfaces must reduce user effort, not increase it.

Rules:

- prefer summaries with links to raw evidence,
- keep raw transcripts and command chatter out of active dashboards,
- separate raw capture, curated note, review queue, and durable knowledge,
- make next actions visible,
- keep uncertainty explicit.

Measure with:

- surface noise count,
- forbidden raw-artifact matches,
- review item stability,
- actionability of generated next steps.

## Spaced Review And Evidence Decay

Memory gets stale. The system should use recheck and expiry metadata instead of pretending
old knowledge is permanently true.

Allowed mechanisms:

- `checked_at`,
- `recheck_at`,
- `expires_at`,
- confidence,
- evidence reports,
- schedule proposals.

Any automatic scheduling must remain inspectable and must not silently rewrite user notes.

## Safety Invariants

These are hard gates:

```text
secret_leak_count == 0
risky_auto_apply_violations == 0
protected_path_write_violations == 0
idempotency_violations == 0
archived_raw_capture_in_active_surface == 0
```

Hard gates block release regardless of aggregate score.

## Accepted Source Lines

The current contract is based on these stable method families:

- Information retrieval evaluation: precision, recall, F-measure, MRR, nDCG.
  Reference: Manning, Raghavan, Schuetze, *Introduction to Information Retrieval*,
  Cambridge University Press, 2008, chapter on evaluation.
  https://nlp.stanford.edu/IR-book/

- Distributed practice / spaced review.
  Reference: Cepeda, Pashler, Vul, Wixted, Rohrer, 2006, *Distributed Practice in
  Verbal Recall Tasks: A Review and Quantitative Synthesis*.
  https://pubmed.ncbi.nlm.nih.gov/16719566/

- Cognitive load theory.
  Reference: Sweller, 1988, *Cognitive Load During Problem Solving: Effects on Learning*.
  https://doi.org/10.1016/0364-0213(88)90023-7

- Inter-rater agreement for labels.
  Reference: Cohen, 1960, *A Coefficient of Agreement for Nominal Scales*.
  https://doi.org/10.1177/001316446002000104

## Change Control

When changing this contract:

1. update this document,
2. update affected Brain Quality fixtures,
3. run `npm run release-check`,
4. document the reason in the commit message.

