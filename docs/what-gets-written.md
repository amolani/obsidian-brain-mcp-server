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
- `.brain-knowledge-inbox-state.json`
- `.brain-background-last-run.json`
- `.brain-background.lock` while a background run is active
- `.semantic-index.json` when the optional local semantic cache is explicitly rebuilt
- `.raw/.manifest.json` when source ingest is applied

These files are local operating state. They prevent repeated promotion, preserve feedback, hide already reviewed Inbox items, make unattended background runs inspectable, and avoid re-ingesting unchanged sources. JSON state writes use atomic replacement; a stale background lock is reported instead of silently ignored.

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
