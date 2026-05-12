# Public Beta Guide

Obsidian Brain MCP is beta-ready when a new user can validate safety, install hooks, and inspect useful demo output without touching a private vault.

## 5-Minute Trial

```bash
git clone https://github.com/amolani/obsidian-brain-mcp-server.git
cd obsidian-brain-mcp-server
npm install
node cli.ts demo --out /tmp/obsidian-brain-demo --force
node cli.ts doctor --vault /tmp/obsidian-brain-demo --skip-hooks
```

Open `/tmp/obsidian-brain-demo` in Obsidian and inspect:

- `Knowledge/_brain.md`
- `Knowledge/evidence.md` after running `build_evidence_dashboard`
- `Maintenance/Capture Review.md` after running `build_capture_review`
- `Knowledge/Runbooks/Runbook Firewall DHCP.md`

## Real Vault Setup

```bash
export VAULT_PATH=/path/to/your/obsidian/vault
node cli.ts doctor --vault "$VAULT_PATH"
node cli.ts install-hooks --vault "$VAULT_PATH"
node cli.ts install-hooks --vault "$VAULT_PATH" --apply
```

`install-hooks` is dry-run by default. With `--apply`, it creates a timestamped backup of `~/.claude/settings.json` before writing.

## Safety Defaults

- Working memory stays manual.
- Risky refactors stay out of automatic apply.
- Hook installation preserves unrelated Claude settings.
- Capture Review and Evidence Dashboard are dry-run-first surfaces.
- Runbook generation through the MCP tool previews by default.
- Checkpoint and capture-derived claims are marked provisional until reviewed.
- Fuzzy or content-based customer matches are surfaced in Capture Review.

## Good First Commands

```text
brain_health_check
brain_metrics
build_capture_review
build_evidence_dashboard
brain_review
```
