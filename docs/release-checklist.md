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
- `brain-policy.json` keeps risky tools dry-run-first or blocked from auto-apply.
- Capture safety is enabled: secret redaction on, risky auto-apply still blocked.
- `migrate_brain_metadata` preview has been reviewed for existing production vaults.
- `plugins/claude-code/` is clearly marked as a template, not the primary install path.
- Generated assets and demo data contain no private vault content.

## Suggested Release Notes

- Setup: CLI doctor, hook installer, demo vault, release check.
- Trust surfaces: Capture Review, Evidence Dashboard, Session Impact, Knowledge Inbox, and Change Ledger.
- Safety: secret redaction, capture scoring, dry-run-first metadata migration.
- Runbooks: dry-run-first generation with validation and rollback sections.
- Source ingest: markdown, ticket, incident log, and web export profiles.
