# What Gets Written To Your Vault

Obsidian Brain MCP writes plain local files. There is no hosted processing, no hidden database, and no automatic vault refactor.

## Automatic Session Writes

Claude Code hooks may create:

- `Daily/YYYY-MM-DD.md`
- `Kunden/{Client}/Captures/*.md`
- `Knowledge/Checkpoints/*.md`
- `Maintenance/Auto-Build/*.md`
- `Maintenance/Session Impact/*.md`

These notes are source material and generated review surfaces. They should stay traceable and boring.

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

Checkpoint/capture-derived claims start provisional. Final confirmation remains a review action.

## Local State Files

The Brain keeps small local state files at vault root:

- `.action-log.jsonl`
- `.brain-auto-build-manifest.json`
- `.brain-feedback.json`
- `.brain-knowledge-inbox-state.json`
- `.brain-background-last-run.json`
- `.brain-background.lock` while a background run is active

These files are local operating state. They prevent repeated promotion, preserve feedback, hide already reviewed Inbox items, and make unattended background runs inspectable.

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
