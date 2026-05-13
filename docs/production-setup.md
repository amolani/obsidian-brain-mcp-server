# Production Setup

This guide is for running Obsidian Brain MCP unattended on a local machine.

## 1. Validate The Vault

```bash
export VAULT_PATH=/path/to/your/obsidian/vault
node cli.ts doctor --vault "$VAULT_PATH"
```

Fix `fail` results before enabling background runs. `warn` results are acceptable for a first setup if they are understood.

## 2. Install Or Repair Claude Code Hooks

Preview first:

```bash
node cli.ts install-hooks --vault "$VAULT_PATH"
node cli.ts repair-hooks --vault "$VAULT_PATH"
```

Apply only after reviewing the preview:

```bash
node cli.ts install-hooks --vault "$VAULT_PATH" --apply
node cli.ts repair-hooks --vault "$VAULT_PATH" --apply
```

Both commands preserve unrelated Claude settings and create backups before writing when a settings file already exists.

## 3. Run The Background Brain Once

Preview:

```bash
node cli.ts background --vault "$VAULT_PATH"
```

Apply the safe background job set:

```bash
node cli.ts background --vault "$VAULT_PATH" --apply
```

The background run writes:

- `Maintenance/Background Run Report.md`
- `.brain-background-last-run.json`
- generated dashboards/indexes/review surfaces
- an `.action-log.jsonl` entry

Risky maintenance remains preview-only inside the background run.

## 4. Schedule It

Cron example:

```cron
*/30 * * * * cd /absolute/path/to/obsidian-brain-mcp-server && node cli.ts background --vault /path/to/your/obsidian/vault --apply >> /tmp/obsidian-brain-background.log 2>&1
```

Systemd timer setups should run the same command from the repository directory.

## 5. Review The Results

Open these files in Obsidian:

- `Maintenance/Background Run Report.md`
- `Maintenance/Knowledge Inbox.md`
- `Maintenance/Change Ledger.md`
- `Knowledge/_brain.md`
- `Knowledge/evidence.md`

Use Inbox actions for claim confirmation/rejection and runbook previews. Already reviewed Inbox items are persisted in `.brain-knowledge-inbox-state.json` and do not keep reappearing unless their source changes.

## 6. Benchmark Before Large Production Use

```bash
node cli.ts benchmark --out /tmp/obsidian-brain-benchmark --notes 5000 --force
```

This creates a synthetic vault and writes `benchmark-report.md` plus `benchmark-report.json`.
