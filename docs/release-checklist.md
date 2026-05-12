# Release Checklist

Use this before cutting a GitHub Release.

## Required Checks

```bash
npm run typecheck
npm test
npm run release-check
```

## Manual Review

- `README.md` quick start is current.
- `CHANGELOG.md` has an Unreleased entry ready to turn into a release version.
- `docs/public-beta.md` still matches CLI behavior.
- `brain-policy.json` keeps risky tools dry-run-first or blocked from auto-apply.
- `plugins/claude-code/` is clearly marked as a template, not the primary install path.
- Generated assets and demo data contain no private vault content.

## Suggested Release Notes

- Setup: CLI doctor, hook installer, demo vault, release check.
- Trust surfaces: Capture Review and Evidence Dashboard.
- Runbooks: dry-run-first generation with validation and rollback sections.
- Source ingest: markdown, ticket, incident log, and web export profiles.
