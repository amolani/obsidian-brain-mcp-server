# Release Checklist

Use this before cutting a GitHub Release.

## Required Checks

```bash
npm run typecheck
npm test
npm run release-check
```

CI runs the same release check on GitHub Actions for Node 22 and 24.

## Manual Review

- `README.md` quick start is current.
- `CHANGELOG.md` has an Unreleased entry ready to turn into a release version.
- `docs/public-beta.md` still matches CLI behavior.
- `docs/what-gets-written.md` explains all automatic writes and local state files.
- `docs/production-setup.md` covers unattended background runs and scheduling.
- `brain-policy.json` keeps risky tools dry-run-first or blocked from auto-apply.
- Capture safety is enabled: secret redaction on, risky auto-apply still blocked.
- `migrate_brain_metadata` preview has been reviewed for existing production vaults.
- `node cli.ts background --vault <demo-or-test-vault> --apply` writes a readable Background Run Report.
- `node cli.ts benchmark --out /tmp/obsidian-brain-benchmark --notes 5000 --force` completes on the release machine.
- `plugins/claude-code/` is clearly marked as a template, not the primary install path.
- Generated assets and demo data contain no private vault content.

## Suggested Release Notes

- Setup: CLI doctor, hook installer, hook repair, background runner, benchmark, demo vault, release check.
- Trust surfaces: Capture Review, Evidence Dashboard, Session Impact, Knowledge Inbox, Change Ledger, and Background Run Report.
- Safety: secret redaction, capture scoring, dry-run-first metadata migration.
- Review state: Knowledge Inbox item decisions persist locally and stop already reviewed items from reappearing.
- Runbooks: dry-run-first generation with validation and rollback sections.
- Source ingest: markdown, ticket, incident log, and web export profiles.
