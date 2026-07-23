# Knowledge Distillation Contract

This contract defines when a work-session detail is worth keeping and how it may be
turned into durable knowledge. The target is not a shorter transcript. The target is a
small set of atomic, source-grounded facts that preserve decisions, causes, changes,
verified outcomes, constraints, and open questions without copying assistant narration.

It extends the [Scientific Engineering Contract](scientific-engineering-contract.md),
the [Session Digest Contract](session-digest-contract.md), and the
[Brain Quality Contract](brain-quality-contract.md).

## Hypothesis

A session capture is more useful in daily work when it:

1. retains critical decisions and verified outcomes even from short sessions,
2. rejects long but low-information command chatter,
3. ranks non-redundant atomic facts by task value,
4. keeps importance separate from evidential support,
5. paraphrases the selected fact while retaining a bounded source excerpt and provenance,
6. sends important but weakly supported facts to review instead of silently promoting them.

## Two Independent Axes

`salience_score` and `evidence_score` must never be collapsed into one confidence value.

- **Salience** answers: is the information useful for the task, a decision, a future
  action, or reusable understanding?
- **Evidence quality** answers: is the atomic statement traceable to concrete session
  evidence, with its entities, polarity, and modality preserved?

A fact may be highly salient and weakly supported. Such a fact belongs in Capture Review
or Knowledge Inbox, not in automatic durable promotion.

Initial labels remain `low`, `medium`, and `high`. They are not probabilities. A
probabilistic interpretation is allowed only after enough reviewed outcomes exist to
measure calibration, for example with the Brier score.

## Atomic Fact Types

The distiller may emit only these semantic units:

| Type | Meaning |
|---|---|
| `problem` | task, incident, or failed desired state |
| `cause` | supported causal explanation |
| `decision` | selected option or binding direction, not a suggestion |
| `change` | applied modification to an artifact or system |
| `verification` | observed post-change check or test result |
| `result` | durable finding that is not itself a change |
| `constraint` | invariant, risk, prerequisite, or limitation |
| `open_question` | unresolved issue that must not be stated as fact |

Hypotheses, rejected options, and stale intermediate states must retain their modality or
be excluded. An early failure state must not appear under final verification after a later
successful check supersedes it.

## Salience Model

The deterministic V1 engineering model uses five explicit factors in `[0, 1]`:

```text
base_salience =
  0.30 * task_relevance +
  0.25 * decision_or_outcome_utility +
  0.20 * session_novelty +
  0.15 * reusability +
  0.10 * specificity
```

These weights are versioned engineering defaults, not universal scientific constants.
They must later be calibrated against reviewed, anonymized real sessions.

Selection uses Maximal Marginal Relevance so repeated summaries do not crowd out a new
fact:

```text
selection_score(c) =
  lambda * base_salience(c)
  - (1 - lambda) * typed_max_similarity(c, already_selected)
  + interpreted_assertion_bonus(c)
  + uncovered_fact_type_bonus(c)

lambda = 0.75
same_type_similarity_factor = 1.00
cross_type_similarity_factor = 0.20
interpreted_assertion_bonus = 0.04
uncovered_fact_type_bonus = 0.04
```

Cause, change, and verification facts about the same technical subject are complementary,
not duplicates, so cross-type similarity receives only a bounded penalty. A small bonus
prefers an interpreted phase/summary assertion over a generated shell wrapper without
raising its evidence score. Another small bonus preserves fact-type diversity. If a user
explicitly requests a fixed set of atom types, the selector reserves one eligible slot per
requested type before filling remaining capacity with MMR.

Novelty combines bounded statement informativeness with dissimilarity to supplied durable
knowledge. When no comparison corpus is supplied, novelty is unknown and therefore neutral
(`0.50`), not maximal. Rare text alone is never proof of importance: a candidate must still
be task-relevant and pass noise and evidence checks. Loading a representative, bounded
vault corpus for this comparison remains a production-calibration task.

## Evidence Model And Provenance

Each selected atom must retain:

- stable fact ID,
- source session ID and transcript hash at capture level,
- source event reference,
- evidence fingerprint,
- evidence source kind (`user`, `assistant`, `command`, or `tool_result`),
- bounded, secret-redacted evidence excerpt,
- extractor/model version,
- evidence score and explanation.

The local V1 evidence score combines source strength, entity coverage, independent
support, and uncertainty preservation. Provenance proves origin, not truth.

Automatic durable promotion requires:

```text
provenance_complete == 1
salience_score >= 60
evidence_score >= 75
unsupported_entity_count == 0
fact_type not in {problem, open_question}
```

Generic `result` atoms require `salience_score >= 70` because isolated command
outputs are especially easy to overvalue. A runbook additionally requires at least
one qualifying `change` and one qualifying `verification` atom.

Explicit human review may accept a lower-evidence fact. The review decision must remain
in the action log and persistent Inbox state.

## Persisted Digest Integrity

Persisted Markdown is an untrusted interchange boundary. Automatic promotion may use a
fact only when the digest carries the current `session-digest-v1` integrity record and
the parser verifies all of the following locally:

- the exact allowed salience model and `knowledge-harvester` producer,
- canonical fact ID, type, statement, salience, evidence, and confidence,
- an allowed provenance reference (`phase`, `assistant_summary`, `error_fix`, or
  `bash_pair`) with a full SHA-256 fingerprint,
- an evidence score and confidence label reproducible from those provenance sources,
- the SHA-256 integrity digest over the complete canonical fact/provenance payload.

Missing, legacy, edited, or malformed attestations remain readable review material but
must not create claims, insights, answers, gaps, or runbook steps automatically.

This checksum is tamper-evident, not a cryptographic proof of authorship. A process that
can execute or replace project code can recompute it, and a valid digest can be replayed.
Protection against that stronger attacker requires a key held outside the Vault or an
append-only trusted transcript/sidecar registry.

## Abstraction And Evidence Separation

The active digest must contain canonical atomic statements, not raw assistant paragraphs.
Technical literals needed for correctness may remain unchanged. Short source excerpts are
allowed only in the evidence subsection and do not count as the distilled statement.

The generated capture must not contain:

- complete assistant summary blocks,
- phase-by-phase conversational narration,
- unbounded command lists,
- debug narration,
- unsupported combinations of facts from unrelated events.

Selected safe commands may be retained as bounded technical evidence for runbook review.
They are not themselves durable claims.

## Required Metrics

### Importance-Weighted Recall

Fixtures label expected facts as `critical=5`, `high=3`, or `medium=1`:

```text
importance_weighted_recall =
  captured_expected_weight / total_expected_weight
```

Default gate: `>= 0.90`. Missing a critical fact is a hard failure.

### Durable Atom Precision

Every emitted digest atom, claim, insight, or answer must map to an expected fact, an
allowed metadata atom, or an explicit review item:

```text
durable_atom_precision = supported_atoms / all_emitted_atoms
```

Default gate: `>= 0.90`. Debug narration promoted as knowledge is a hard failure.

### Section Accuracy

```text
section_accuracy = correctly_typed_atoms / all_typed_atoms
```

Default gate: `>= 0.90`. A stale failure state under `verification` fails the fixture.

### Anti-Verbatim Gate

After excluding frontmatter, technical literals, and explicitly marked evidence excerpts:

```text
longest_shared_word_run <= 12
copied_5gram_coverage <= 0.35
distilled_compression_ratio <= 0.30
```

These metrics do not prove faithfulness. They prove only that the active digest is not a
verbatim transcript copy. Evidence coverage and entity/polarity checks protect
faithfulness separately.

### Temporal And Routing Gates

```text
late_fact_recall == 1
stale_fact_count == 0
duplicate_durable_fact_count_after_update == 0
false_confident_route_count == 0
```

Routing fixtures must assert canonical client, match method, confidence, target path, and
abstention for ambiguous sessions.

## Required Fixtures

The executable quality suite must cover at least:

1. a short critical decision with no Bash commands,
2. a long debug session with no durable learning,
3. a late correction without a final assistant summary,
4. a verbatim-copy trap,
5. section classification for cause/change/verification,
6. ambiguous multi-client routing,
7. research-only behavior without runbook promotion,
8. repeated known facts plus one new fact.

Until a fixture exists, the corresponding behavior is not considered proven.

## Scientific Basis

- Carbonell and Goldstein, 1998, *The Use of MMR, Diversity-Based Reranking for
  Reordering Documents and Producing Summaries*:
  https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf
- Itti and Baldi, 2009, *Bayesian Surprise Attracts Human Attention*:
  https://pmc.ncbi.nlm.nih.gov/articles/PMC2782645/
- Wang et al., 2021, *Decision-Focused Summarization*:
  https://aclanthology.org/2021.emnlp-main.10/
- W3C, *PROV-DM: The PROV Data Model*:
  https://www.w3.org/TR/prov-dm/
- Maynez et al., 2020, *On Faithfulness and Factuality in Abstractive Summarization*:
  https://aclanthology.org/2020.acl-main.173/
- Scirè et al., 2024, *FENICE: Factuality Evaluation of Summarization Based on Natural
  Language Inference and Claim Extraction*:
  https://aclanthology.org/2024.findings-acl.841/

The papers motivate novelty, non-redundancy, decision preservation, provenance, and
faithfulness checks. They do not establish the project-specific weights. Those remain
explicit hypotheses to validate with human-reviewed data.

## Acceptance

A distillation change is release-ready only after:

```bash
npm run brain-quality
npm run release-check
```

The report must expose both salience and evidence results. A high aggregate score may not
hide a critical miss, unsupported durable atom, secret leak, or verbatim-copy violation.
