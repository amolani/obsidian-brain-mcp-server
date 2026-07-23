# What Gets Written To Your Vault

Obsidian Brain MCP writes plain local files. There is no hosted processing, no hidden database, and no automatic vault refactor.

## Automatic Session Writes

Claude Code hooks may create:

- `Daily/YYYY-MM-DD.md`
- `Kunden/{Client}/Captures/*.md`
- `Knowledge/Checkpoints/*.md`
- `Maintenance/Auto-Build/*.md`
- `Maintenance/Session Impact/*.md`

Session captures contain a bounded set of typed, abstracted knowledge atoms plus score and provenance metadata. They do not contain complete assistant summaries, phase narration, or unbounded command logs. Important facts with weak evidence stay in the capture's Review section.

Only exact CWD-segment customer matches are written directly below `Kunden/{Client}`. Fuzzy, content-only, unknown, and ambiguous matches remain in a neutral `Technik/` or `Referenz/` path until reviewed.

## Generated Knowledge Surfaces

Safe generated surfaces include:

- `Knowledge/_brain.md`
- `Knowledge/index.md`
- `Knowledge/hot.md`
- `Knowledge/evidence.md`
- `Maintenance/Capture Review.md`
- `Maintenance/Knowledge Inbox.md`
- `Maintenance/Change Ledger.md`
- `Maintenance/Background Run Report.md`
- `Kunden/{Client}/_timeline.md`
- `Kunden/{Client}/_snapshot.md`

These files can be rebuilt. They should explain what the Brain sees, what changed, and what needs review.

## Durable Knowledge

Promotion can create:

- `Knowledge/Claims/*.md`
- `Knowledge/Runbooks/*.md`
- `Knowledge/Insights/*.md`
- `Knowledge/Answers/*.md`
- `Knowledge/Gaps/*.md`
- `Knowledge/Contradictions/*.md`

Checkpoint/capture-derived claims start provisional. Automatic promotion requires a typed atom with complete provenance and separate salience/evidence gates. Final confirmation remains a review action; automation never sets itself as `confirmed_by` or invents a `checked_at` date.

## Local State Files

The Brain keeps small local state files at vault root:

- `.action-log.jsonl`
- `.brain-auto-build-manifest.json`
- `.brain-feedback.json`
- `.brain-calibration.json`
- `.brain-calibration.lock` (only while one calibration writer is active)
- `.brain-knowledge-inbox-state.json`
- `.brain-background-last-run.json`
- `.brain-background.lock` while a background run is active
- `.semantic-index.json` when the optional local semantic cache is explicitly rebuilt
- `.raw/.manifest.json` when source ingest is applied

These files are local operating state. They prevent repeated promotion, preserve feedback, hide already reviewed Inbox items, make unattended background runs inspectable, and avoid re-ingesting unchanged sources.

Current Harvester captures contain one attested `calibration-capture-v2` bundle:

- selected digest references `F1..Fn`,
- sampled non-selection references `C1..Cm` used only inside the calibration pipeline,
- the exact `ks-…` map,
- machine-readable model/factor/provenance snapshots,
- one SHA-256 fingerprint per snapshot,
- a random per-session sample seed retained across incremental updates,
- a randomized, selection-blind `R1..Rn` review map,
- bounded review payloads containing the exact statement and redacted evidence
  references/hashes/excerpts,
- one integrity hash over the complete ordered bundle.

Numeric snapshot payloads contain no fact statement or evidence excerpt. Sampled
non-selection statements do not appear in the Markdown body. They exist only in the
attested review payload in frontmatter, which generic vault search, semantic indexing,
note context, link extraction, promotion, and action-log metadata exclude.
`brain_calibration_review_batch` is the intended read path: it reveals the R-reference,
statement, bounded evidence, and an opaque `brt-…` record token, but hides the production
path/fact ID, individual F/C status, production rank, scores, sampling probability,
weighted progress, and production-stratum counts. `record_calibration_judgement` resolves
the token, reloads the payload, and stores `useful` plus `supported` together in one atomic
write. The complete observation/reviewer pair is immutable; an identical replay is
unchanged and a divergent replay fails closed. `record_calibration_label` remains only for
dated `still_valid` rechecks. Blind review additionally requires a reviewer role without access to production
notes/search, note context, or the evaluator; selected production facts legitimately
remain searchable outside that role.

`.brain-calibration.json` schema V2 stores the verified immutable snapshot, a separate
base target ID and event observation ID, canonically deduplicated provenance
classes/counts, generation time, selection/sample metadata, pseudonymous project group,
and an explicit `useful`, `supported`, or `still_valid` label. The same semantic fact in
another session is another base observation. Each dated validity recheck has an event ID
derived from base ID, observation time, and change regime; `recordedAt` controls monotonic
corrections, so an older retry cannot roll back a newer review. The file does not store
fact text, evidence excerpts, free-form rationales, or shadow predictions. JSON state
writes use atomic replacement and a vault-local writer lock.

`brain_calibration_evaluate` writes nothing. Its fitted coefficients and probabilities
exist only in the aggregate response for that run. The response includes IPW-weighted
coverage and metrics, strict temporal split/embargo diagnostics, bootstrap intervals, and
conservative MNAR bounds. No shadow model can modify active selection, digests, promotion,
policy, or release state.

Generated surfaces carry an exact `quelle` ownership marker. Refresh and repair operations replace only files owned by the same generator; a manual or foreign file at a fixed target is preserved and the operation fails closed.
Pre-marker output from older Brain versions is never adopted implicitly. `repair_generated_surfaces` requires explicit `adopt_legacy=true` apply and matches the exact path, expected tag, heading, and a generator-specific body signature before replacement.

## Never Automatic

The Brain must not automatically:

- merge notes,
- rename notes,
- move folders,
- rewrite broken links,
- apply link suggestions,
- resolve gaps,
- confirm weak claims,
- inject working memory,
- upload private vault content.

Those actions stay explicit and dry-run-first.
