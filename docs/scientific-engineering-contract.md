# Scientific Engineering Contract

This document defines how Obsidian Brain MCP may be made "more intelligent".

Session-level importance selection and non-verbatim capture behavior are specified in the
[Knowledge Distillation Contract](knowledge-distillation-contract.md).

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

### Calibration Labels And Small Samples

Calibration data must keep three targets separate:

- `useful`: whether the fact deserves attention or durable retention,
- `supported`: whether the available evidence supports the fact,
- `still_valid`: whether a time-sensitive fact remains applicable at review time.

Every label is stored with separate salience- and evidence-model versions plus a bounded
feature snapshot. Raw fact text and evidence excerpts do not belong in the calibration
dataset; free-form review reasons are excluded for the same reason. An accepted review
item is not automatically evidence that the underlying statement is true.

Stored integer scores must be reproducible from their complete factor/provenance snapshot.
The salience-model version must also name its coupled evidence-model version. Unknown
models and inconsistent snapshots are rejected instead of silently entering the
calibration dataset. When a model is superseded, its formula must remain in a supported
model registry before calibration files using that version can be read.

The knowledge harvester embeds each text-free numeric snapshot plus its SHA-256
fingerprint in the source capture. A separate bounded review payload binds the exact
statement and redacted evidence references, hashes, and excerpts to an opaque `R…`
reference. The complete deduplicated candidate universe, ordered numeric map, payloads,
fingerprints, random sample seed, randomized review map, review payloads, producer,
session, and model are covered by `calibration-capture-v3`. Legacy V2 captures remain
read-only parseable but are ineligible for sealed enrollment because they did not bind
the full sampling frame.

The parser requires an exact semantic bijection. Internal `F1..Fn` entries must be selected
facts with the matching one-based production rank. Internal `C1..Cm` entries must be
sampled non-selections with no production rank. All payloads must agree on generation
time, model versions, and candidate-population size; exactly `min(6, N)` entries must carry
the reproducible inclusion probability. V3 reconstructs the seeded uniform sample from
the complete UTF-8-bytewise-sorted universe and rejects missing, substituted, duplicated,
or inconsistently marked candidates. The review evidence classes must agree with the
numeric provenance classes.

`brain_calibration_review_batch` exposes only the attested `R…` reference, statement,
bounded evidence, missing human labels, an opaque `brt-…` record token, and unweighted
overall response progress. It returns no capture path, fact ID, weighted progress, or
production-stratum counts. Label recording resolves the token server-side, reloads the
registered payload, and verifies the whole bundle, review association, model formula, and
fingerprint. Callers cannot submit replacement weights, scores, provenance counts, sample
membership, or production rank. The attestation is tamper-evident rather than a keyed
proof; capture and executable code remain inside the same local trust boundary.

Reviewer identity is process-bound rather than caller-selectable. Every isolated
`calibration-review` server must start with one fixed registered
`BRAIN_CALIBRATION_REVIEWER_ID`; it injects that identity into both review operations and
binds `recordedAt` to the current server UTC time for each judgement. It rejects
caller-supplied alternatives. The public review schemas expose neither reviewer identity
nor recording time, while default MCP mode neither exposes nor permits the blind batch or
judgement writer.

The primary `useful` and `supported` judgements are one atomic append-only transaction per
observation and reviewer. A complete pair is its own freeze marker: an identical retry is
unchanged, a divergent retry fails closed, and a consistent legacy partial pair may only
be completed without replacing its existing value. The old single-label path rejects
all primary outcomes and remains available only for dated `still_valid` events.

This display is scientifically blind only under role separation. During judgement, the
reviewer must have access solely to the blind batch and token-based label writer—not to
production notes, vault or semantic search, note context, the calibration dataset, or the
evaluator. Selected facts legitimately remain present in normal production knowledge
surfaces, so a same-role reviewer could otherwise search the shown statement and infer
membership. The analyst may inspect weighted/stratified diagnostics only after the
reviewer phase is closed. A masked UI without that access separation is convenience, not
a defensible blind experiment.

A semantic `ks-…` fact may occur in several sessions. The dataset therefore keys reviews
by a derived observation ID over session, fact ID, and feature fingerprint. An identical
capture retry resolves to the same base observation; another session remains another
observation. Exact
harvester generation time is part of the fingerprinted snapshot. A pseudonymous project
group is derived server-side from the capture scope for stricter cross-project analysis.

`still_valid` labels additionally require the fact's observation timestamp and one
explicit change regime (`historical_event`, `durable_state`, `operational_state`, or
`ephemeral_state`). The base observation ID remains tied to the capture occurrence; each
temporal event ID is derived from that base ID, `observedAt`, and validity class.
`recordedAt` is review-version time, not event identity: a newer correction updates the
same event and an older retry is rejected. Separate observation times remain separate
events. This makes later survival analysis possible without activating an arbitrary decay
function today.

For `a` positive and `r` negative labels, the descriptive small-sample baseline uses a
Jeffreys prior:

```text
theta | labels ~ Beta(a + 0.5, r + 0.5)
posterior_mean = (a + 0.5) / (a + r + 1)
```

The posterior mean is a dataset diagnostic, not an automatic policy decision.

### Seeded Uniform Candidate Sampling

Evaluating only facts selected by the production model would create selection bias. Each
session therefore generates a cryptographically random seed, persists it across
incremental updates, and draws up to six candidates from the safe, deduplicated
pre-selection universe by sorting `SHA-256(seed, fact_id, sampler_version)`. Conditional
on the seed, the draw is reproducible; before the seed is generated, every candidate has
equal inclusion probability:

```text
k = min(6, N)
pi_i = k / N
w_i = 1 / pi_i
```

The capture persists:

- population size and inclusion probability,
- `selected` or `sampled_unselected`,
- production rank for selected facts,
- whether the occurrence belongs to the evaluation sample,
- the random seed and sampler/capture schema.

The internal F/C map is never returned by the blind surface. A second seeded ordering
assigns opaque `R1..Rn` review references, and each response gets an opaque record token.
Sampled non-selection statements do not appear in the Markdown body. Calibration
frontmatter and its review payloads are excluded from normal vault search, semantic
vectors and hashes, note context, link extraction, promotion, and action-log metadata.
Selected facts remain ordinary searchable production knowledge, which is why the
reviewer role must not access those surfaces. Scientific metrics use only
`evaluationSample=true`; selected facts outside the sample are ineligible. Missing human
labels remain missing instead of being inferred from selection.

### Shadow Evaluation

`brain_calibration_evaluate` evaluates `useful` and `supported` separately. Reviews are
aggregated per observation; a reviewer tie abstains. All fits and metrics use
inverse-inclusion-probability weights with Hájek normalization. The evaluator also scans
the complete currently indexed, attested capture frame, so unlabeled sample occurrences
remain in the response denominator. Coverage is reported raw and IPW-weighted overall and
by production stratum; score, session-size, and holdout-era diagnostics are used to expose
differential non-response.

A union-find leakage component joins observations sharing a semantic fact, session, or
source capture. Project mode additionally joins the pseudonymous project group. The split
chooses a time cutoff near the newest 20% target weight. A component completely before the
cutoff enters training, a component completely after it enters test, and any component
spanning the boundary is embargoed. The evaluator verifies
`max(train.generatedAt) < min(test.generatedAt)`.

Production scores are ordinal and must not be passed directly to probabilistic metrics.
The baseline first learns this train-only beta-style calibration:

```text
s = (ordinal_score + 0.5) / 101
p = sigmoid(c + a * log(s) + b * (-log(1 - s)))
a >= 0, b >= 0
```

The non-negative beta coefficients guarantee that the baseline probability cannot fall
when the ordinal production score rises. The fixed shadow candidates are IPW-weighted,
L2-regularized logistic models over the five salience factors (`useful`) or canonical
evidence features (`supported`). They emit explicit `probability_0_1` predictions only
after fitting on the training partition.

Primary and secondary holdout metrics are:

```text
Brier  = sum(w * (p - y)^2) / sum(w)
LogLoss = -sum(w * (y * log(p) + (1-y) * log(1-p))) / sum(w)
```

The report also includes mean bias, Brier skill against training prevalence, equal-count
reliability bins, calibration intercept/slope when identifiable, macro-group Brier,
promotion coverage, false discoveries among predictions above the label-specific
probability threshold, and classical false-positive rate. These are calibration
diagnostics, not the product's promotion rule. Uncertainty for model differences is a
paired cluster bootstrap over complete leakage groups. False-promotion and false-positive
intervals are unavailable—not treated as success—unless enough bootstrap replicates and
at least 30 promoted predictions per model exist. Negative loss delta means the shadow
candidate is better. The current bootstrap holds the training fit fixed; full refit or
nested-CV uncertainty remains future work and must be reported as a limitation.

The evaluator does not fit a candidate unless training contains at least 30 positive and
30 negative targets, 30 leakage groups, an IPW effective sample size of 60, and four
distinct ordinal scores. A `shadow_validation_eligible` result additionally requires a
strict holdout with at least 30 groups, 30 targets of each class, IPW effective sample
size 60, stable score support, no invalid capture bundle, no label outside the current
frame, at least 90% weighted response overall, and at least 80% in each populated
production stratum and the holdout era.

Because response may still be missing not at random, the evaluator widens the observed
paired Brier interval with a worst-case identification bound. If `r` is weighted response
coverage and an individual Brier-loss difference lies in `[-1, 1]`:

```text
MNAR_delta_Brier ∈ r * observed_CI + (1 - r) * [-1, 1]
```

`preregistered_validation_candidate` requires the upper observed and MNAR bounds to beat
the predeclared `0.005` improvement, log-loss/FPR/false-promotion non-inferiority,
non-degraded coverage, enough promoted predictions, and positive skill against
prevalence.

Every outcome remains shadow-only: the evaluator is read-only, exposes aggregate metrics
without paths/reviewer/client IDs, and cannot modify active weights, promotion gates, or
policy. `releaseDecisionAllowed` is always false. The inspectable holdout can at most
nominate a model specification for a later one-shot, preregistered future/external
validation bound to the implementation and data cutoff. Repeated inspection of the
current holdout is not a release test.

The exploratory shadow loop remains separate from confirmatory campaigns. A campaign
starts with `brain_calibration_register_campaign` before any enrolled judgement is
visible. Enrollment freezes the explicit observation set, complete attested capture
archive, reviewer roster, grouping, gates, model/runtime/implementation versions, and
bootstrap plan. Its chronological cutoff is derived from the complete response frame
without using labels and is then immutable. Registration also freezes every full-frame
leakage-component ID and each observation's `train`, `test`, or `embargoed` assignment.
Reviewer ties may remove an outcome from fitting, but they cannot reconnect the remaining
observations or move them across partitions. The evaluator must not optimize a new cutoff
or reconstruct groups from answered samples.

Registration apply is bound to the exact reviewed preview. The analyst must return both
its `registrationRoot` and `registeredAt`; apply rebuilds the enrollment using that same
timestamp and fails if any frame, source binding, cutoff, split, roster, or plan byte has
changed between preview and confirmation.

After every enrolled observation has one simultaneous `useful`+`supported` judgement
from every registered reviewer, `brain_calibration_close_campaign` freezes the exact
label events and links the closure root to enrollment. Partial pairs, labels predating
enrollment, unknown reviewers, duplicate observations, invalid captures, or missing
assignments fail closed. The protected campaign cannot be inspected through the
exploratory summary/evaluator while it is open.

A single campaign lock serializes registration, capture, primary-label writes, temporal
labels, closure, and sealed evaluation. The Harvester pauses calibration-capture writes
while the campaign is registered or closed, preventing a late session from silently
changing the enrolled frame. Capture and exploratory diagnostics resume only after the
result receipt has consumed the campaign; later captures remain outside that epoch.

`brain_calibration_evaluate_sealed` accepts no label, grouping, cutoff, gate, model, or
bootstrap override. It reads only the frozen frame and closure snapshot, persists the
first aggregate result, and links a result root to the two earlier roots. An exact retry
returns that persisted receipt rather than recomputing another analysis. Every outcome,
including an underpowered or negative one, consumes the V1 campaign; there is no unseal,
overwrite, or abandon transition. The result still has `releaseDecisionAllowed=false`
and cannot change active weights.

Enrollment, closure, and result roots are additionally written with exclusive-create
semantics to an anchor directory outside the vault. This detects deletion or rollback of
the local campaign files only while the external receipts have independent retention.
A normal user-writable directory is not physically irreversible: publishable claims
require append-only/WORM storage, immutable backups, or an equivalent external
transparency service. Campaign V1 deliberately supports one active epoch; later data
needs a separately designed, disjoint successor epoch.

The chain proves the frozen bytes and their order, not the legal identity of a human
reviewer. The fixed reviewer ID is bound to an isolated MCP process but is not a digital
signature. Regulated or externally published multi-reviewer work additionally requires
reviewer-specific credentials/signatures and an independently operated timestamp or
transparency service.

The registration binds every executable TypeScript file in the project source tree,
relevant root configuration/lock files, the Node executable hash, Node/V8/platform/arch,
`execArgv`, and `NODE_OPTIONS`. These are reproducibility and on-disk drift checks, not
remote runtime attestation. The host, Node process, installed dependency bytes, loader,
and executable memory remain trusted. Published claims should execute the bound revision
in a freshly started, isolated, externally attested build/container without custom
loaders.

These limits are also frozen inside the campaign's `assuranceProfile`: external storage
must enforce retention, reviewer identities are process-bound pseudonyms without digital
signatures, and source/runtime hashes assume a trusted host. The receipt must not be
presented as proving stronger guarantees.

`still_valid` remains descriptive. A false state discovered at review time gives an
interval-censored invalidation time, not an exact failure timestamp; survival/decay
weights stay disabled until that separate observation protocol exists.

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
