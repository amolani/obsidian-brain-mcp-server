# Production Setup

This guide is for running Obsidian Brain MCP unattended on a local machine.

## Prerequisites

- Node.js 22.18.0 or newer. The CLI, hooks, and MCP server execute TypeScript directly with `node`.
- An absolute path to this repository and to the Obsidian vault.
- A versioned backup destination outside the vault.

## 1. Validate The Vault

```bash
export VAULT_PATH=/path/to/your/obsidian/vault
node cli.ts doctor --vault "$VAULT_PATH"
```

Fix `fail` results before enabling background runs. `warn` results are acceptable for a first setup if they are understood.

Older Brain versions may have created `Knowledge/index.md` or `Knowledge/hot.md` before ownership markers existed. The doctor reports those as recognizable legacy surfaces, not as generic user files. Preview `repair_generated_surfaces` first; then set `dry_run=false` and `adopt_legacy=true` only after reviewing the exact paths. Adoption requires the fixed path, expected tag, heading, and generator-specific body signature. A foreign or manual file remains blocked.

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

## 4. Establish Backup And Restore Readiness

The background lock prevents overlapping Brain runs; it is not a rollback mechanism. Before enabling `--apply` on a schedule:

- Back up the complete vault, including hidden `.brain-*` files and `.action-log.jsonl`, to a destination outside the vault.
- Use an atomic filesystem snapshot or pause Brain hooks, background runs, Obsidian, and sync while a file-copy backup is taken.
- Keep more than one version according to the vault's change rate and recovery requirements.
- Back up `~/.claude/settings.json` separately. Hook installation backs up that file, but it is not part of the vault backup.
- Test restoration into a separate directory and run the doctor plus a background preview against the restored copy.
- Pause Obsidian sync or any other writer during a real restore, and stop the timer and active Claude Code sessions first.

One simple archive example is shown below. Replace every placeholder and keep the archive outside `YourVault/`:

```bash
mkdir -p /path/outside-the-vault/vault-backups
tar -C /path/to/your/obsidian -czf /path/outside-the-vault/vault-backups/YourVault-YYYY-MM-DDTHHMMSS.tar.gz YourVault
```

Validate a backup without overwriting the live vault:

```bash
mkdir -p /path/to/restore-test
tar -xzf /path/outside-the-vault/vault-backups/YourVault-YYYY-MM-DDTHHMMSS.tar.gz -C /path/to/restore-test
cd /absolute/path/to/obsidian-brain-mcp-server
node cli.ts doctor --vault /path/to/restore-test/YourVault --skip-hooks
node cli.ts background --vault /path/to/restore-test/YourVault
```

For an actual restore, stop the scheduler first, preserve a final copy of the current vault, restore with the selected backup tool, then run `doctor` and a dry-run background pass before re-enabling writes.

## 5. Schedule It

Use either cron or systemd, not both. The lock prevents concurrent writes, but duplicate schedulers still create avoidable skipped runs and noise.

### Cron

Cron example:

```cron
*/30 * * * * cd /absolute/path/to/obsidian-brain-mcp-server && node cli.ts background --vault /path/to/your/obsidian/vault --apply >> /tmp/obsidian-brain-background.log 2>&1
```

### systemd User Service And Timer

A user unit keeps the Brain running as the vault owner instead of as root. Confirm the Node path with `command -v node`, replace `/usr/bin/node` below if the command reports a different path, then create `~/.config/systemd/user/obsidian-brain.service`:

```ini
[Unit]
Description=Obsidian Brain background refresh

[Service]
Type=oneshot
WorkingDirectory=/absolute/path/to/obsidian-brain-mcp-server
Environment=VAULT_PATH=/path/to/your/obsidian/vault
ExecStart=/usr/bin/node /absolute/path/to/obsidian-brain-mcp-server/cli.ts background --vault ${VAULT_PATH} --apply
TimeoutStartSec=15min
Nice=10
NoNewPrivileges=true
PrivateTmp=true
```

Create `~/.config/systemd/user/obsidian-brain.timer`:

```ini
[Unit]
Description=Run Obsidian Brain every 30 minutes

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
RandomizedDelaySec=2min
Persistent=true
Unit=obsidian-brain.service

[Install]
WantedBy=timers.target
```

Reload the user manager, test one run, inspect its output, and only then enable the timer:

```bash
systemctl --user daemon-reload
systemctl --user start obsidian-brain.service
systemctl --user status obsidian-brain.service
journalctl --user -u obsidian-brain.service --since today
systemctl --user enable --now obsidian-brain.timer
systemctl --user list-timers obsidian-brain.timer
```

If the timer must keep running after logout, ask the machine administrator to enable lingering for the vault owner, for example `sudo loginctl enable-linger <user>`. This changes host-level session policy and is not required while the user manager remains active.

To pause scheduled writes before maintenance or restore work:

```bash
systemctl --user stop obsidian-brain.timer obsidian-brain.service
```

## 6. Review The Results

Open these files in Obsidian:

- `Maintenance/Background Run Report.md`
- `Maintenance/Knowledge Inbox.md`
- `Maintenance/Change Ledger.md`
- `Knowledge/_brain.md`
- `Knowledge/evidence.md`

Use Inbox actions for claim confirmation/rejection and runbook previews. Already reviewed Inbox items are persisted in `.brain-knowledge-inbox-state.json` and do not keep reappearing unless their source changes.

## 7. Benchmark Before Large Production Use

```bash
node cli.ts benchmark --out /tmp/obsidian-brain-benchmark --notes 5000 --force
```

This creates a synthetic vault and writes `benchmark-report.md` plus `benchmark-report.json`.
The report includes deterministic duplicate-work limits and a comparison with
`benchmarks/large-vault-baseline.json`. On a machine comparable to the named reference
profile, add `--enforce-baseline` to return a failing exit code for a runtime regression
above 20 percent. On different hardware, treat the runtime comparison as informational;
the deterministic work gate remains authoritative.
