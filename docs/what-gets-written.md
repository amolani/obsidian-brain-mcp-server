# What Gets Written To Your Vault

Obsidian Brain MCP writes plain local files and runs no hosted Brain storage service. Claude interactions still follow the configured Claude/provider account. There is no hidden Brain database and no automatic vault refactor.

## Automatic Session Writes

Claude Code hooks may create:

- `Daily/YYYY-MM-DD.md`
- `Kunden/{Client}/*.md` for exact customer-path matches
- `Technik/**/*.md` or `Referenz/*.md` when customer routing abstains
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
- `.brain-calibration-campaign/registration.json` (create-only enrollment snapshot)
- `.brain-calibration-campaign/closure.json` (create-only frozen label snapshot)
- `.brain-calibration-campaign/result.json` (create-only aggregate result receipt)
- `.brain-calibration-campaign.lock` (only while capture, label, seal, or sealed evaluation state is being coordinated)
- `.brain-knowledge-inbox-state.json`
- `.brain-background-last-run.json`
- `.brain-background.lock` while a background run is active
- `.semantic-index.json` when the optional local semantic cache is explicitly rebuilt
- `.raw/.manifest.json` when source ingest is applied

These files are local operating state. They prevent repeated promotion, preserve feedback, hide already reviewed Inbox items, make unattended background runs inspectable, and avoid re-ingesting unchanged sources.

Current Harvester captures contain one attested `calibration-capture-v3` bundle:

- the complete deduplicated candidate universe as sorted semantic `ks-…` IDs,
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

The V3 parser reconstructs the seeded uniform sample from the complete candidate
universe and rejects any missing, substituted, duplicated, or inconsistently weighted
sample member. Legacy V2 bundles remain read-only parseable, but they did not bind their
full universe and therefore cannot be enrolled in a sealed campaign.

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
dated `still_valid` rechecks. Blind review additionally requires one isolated
`calibration-review` server/profile per registered reviewer, with a fixed opaque
`BRAIN_CALIBRATION_REVIEWER_ID`. The server injects it into the batch and judgement calls;
it also supplies the judgement's current UTC `recordedAt`. The public schemas expose
neither selector, conflicting caller values are rejected, and default mode hides and
rejects both reviewer-only tools. That reviewer role must not have access to production
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

The campaign files form a one-way local state machine. Registration happens before any
campaign judgement and freezes the complete attested frame, blind review material,
reviewer roster, a label-independent chronological cutoff, analysis configuration,
the complete full-frame leakage groups and per-observation train/test/embargo assignment,
model/runtime versions, and implementation hashes. A reviewer tie can abstain from a
model outcome but cannot rewire or move the preregistered partition. Closure is available only after every
registered reviewer has submitted one atomic `useful`+`supported` pair for every enrolled
observation; it freezes those exact events. `brain_calibration_evaluate_sealed` accepts no
analysis options, evaluates only the frozen artifacts, and persists the first aggregate
result before returning it. Exact retries return that same receipt. There is no MCP
operation to unseal, replace, or abandon a campaign, and campaign V1 permits one active
epoch.

Registration is not applied from a newly generated second preview: `dry_run=false`
requires the exact `registrationRoot` and `registeredAt` returned by the reviewed
dry-run. The server rebuilds with that bound timestamp and rejects intervening drift.
Closure uses the opposite crash-safe persistence order: its externally durable root is
created and fsynced first, then the local closure is written. Recovery may only recreate a
missing local closure that exactly reproduces that already anchored root. A local closure
without an external receipt is never anchored retroactively.

The registration also carries an explicit assurance profile. It records that the external
store—not file mode `0444`—must enforce append-only/WORM retention, that reviewer IDs are
process-bound pseudonyms rather than human digital signatures, and that whole-source-tree,
Node executable, loader-flag, and runtime hashes still assume a trusted host process.

While the campaign is registered or closed, the global campaign lock blocks new
Harvester calibration writes, temporal labels, exploratory summaries, and exploratory
evaluation. Automatic capture resumes after the result receipt exists; those later
captures are outside the consumed campaign.

Each of the three transitions also creates a content-addressed receipt under
`BRAIN_CALIBRATION_ANCHOR_DIR`, linked to the previous root and namespaced by the stable
`BRAIN_CALIBRATION_VAULT_ID`. That directory must be outside the vault. The server uses
exclusive create semantics and detects missing/rolled-back local campaign state, but
software running with permission to delete the external receipts cannot manufacture
physical immutability. Use independent append-only/WORM retention, immutable backups, or
an equivalent transparency store before describing the campaign as irreversible.

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
