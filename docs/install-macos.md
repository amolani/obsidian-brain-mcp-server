# Beginner installation on macOS

This guide installs Obsidian Brain MCP on a Mac from start to finish. It is written for people who have not used Node.js, Git, or MCP before.

The supported setup is:

- macOS 14 Sonoma or newer;
- Apple silicon (`arm64`) or Intel (`x86_64`);
- Node.js 24;
- Obsidian and Claude Code;
- the default macOS Zsh terminal.

Obsidian Brain itself is local software. It reads and writes ordinary Markdown files in the vault you choose. Obsidian does not need to remain open while Claude uses the MCP server.

> [!IMPORTANT]
> Start with a new test vault or make a backup of an existing vault. If macOS asks whether Terminal may access your Documents folder, allow it; otherwise Claude cannot read or write a vault stored there.

## Paths used in this guide

The commands below use these permanent locations:

```text
Program:        ~/.local/share/obsidian-brain-mcp-server
Vault:          ~/Documents/Obsidian/MyBrain
Customer aliases: ~/.config/obsidian-brain/clients.json
```

On macOS, `~` expands to `/Users/YOUR-NAME`. You may choose another vault folder. Always keep paths containing spaces inside quotes.

## 1. Open Terminal and check the Mac

Open **Finder → Applications → Utilities → Terminal** and run:

```bash
sw_vers -productVersion
uname -m
```

The macOS major version must be `14` or larger for this beginner Homebrew path. The architecture normally reports `arm64` on an Apple-silicon Mac or `x86_64` on an Intel Mac.

Claude Code itself supports macOS 13 or newer, but [Homebrew currently treats macOS 13 Ventura as unsupported](https://docs.brew.sh/Installation#macos-requirements), and the [`node@24` formula](https://formulae.brew.sh/formula/node@24) has no Ventura bottle. Advanced users may install Node.js another way on Ventura, but that path is outside this repeatable beginner guide.

## 2. Install Homebrew and the required programs

First check whether [Homebrew](https://brew.sh/) is already installed:

```bash
brew --version
```

If that prints a version, continue with the package commands below. If it prints `command not found`, install Homebrew with its official installer:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

At the end, Homebrew may display **Next steps** for adding `brew` to your `PATH`. Copy and run the commands it shows, then open a new Terminal window and verify:

```bash
brew --version
```

Install Git, a small terminal editor, and Node.js 24:

```bash
brew install git nano node@24
```

Homebrew keeps versioned Node releases separate. Store Node.js 24's absolute path in the default Zsh profile without creating duplicate entries:

```bash
NODE24_BIN="$(brew --prefix node@24)/bin"
NODE24_PATH_LINE="export PATH=\"$NODE24_BIN:\$PATH\""
grep -qxF "$NODE24_PATH_LINE" "$HOME/.zprofile" 2>/dev/null || echo "$NODE24_PATH_LINE" >> "$HOME/.zprofile"
export PATH="$NODE24_BIN:$PATH"
```

Verify everything:

```bash
git --version
node --version
npm --version
```

Node must report `v22.18.0` or newer. A version beginning with `v24` is the recommended result for this guide.

Install Obsidian only if it is not already present:

```bash
if [ -d "/Applications/Obsidian.app" ] || [ -d "$HOME/Applications/Obsidian.app" ]; then
  echo "Obsidian is already installed"
else
  brew install --cask obsidian
fi
```

You can now start Obsidian from the Applications folder. If Homebrew cannot install the app, download the official **Universal** Mac build from the [Obsidian download page](https://obsidian.md/download).

## 3. Install and sign in to Claude Code

Use Anthropic's native installer for macOS:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Close Terminal, open it again, and run:

```bash
claude --version
claude doctor
claude auth login
claude auth status
```

The login command opens a browser. Follow the prompts for your Anthropic account. Claude Code requires a compatible Anthropic plan or API/Console access.

If `claude` is not found after opening a new Terminal window, see [Troubleshooting](#troubleshooting) below and Anthropic's official [Claude Code installation guide](https://code.claude.com/docs/en/installation).

## 4. Create or choose an Obsidian vault

Open Obsidian and select **Create new vault**, or choose an existing vault. For this guide, create a vault named `MyBrain` at:

```text
/Users/YOUR-NAME/Documents/Obsidian/MyBrain
```

Alternatively, create the folder in Terminal first:

```bash
mkdir -p "$HOME/Documents/Obsidian/MyBrain"
```

Then use **Open folder as vault** in Obsidian and select that folder.

An existing vault may use any folder structure. Generated Brain artifacts use folders such as `Daily/`, `Knowledge/`, and `Maintenance/`.

> [!TIP]
> For the first test, prefer a local folder over an iCloud-synced vault. If you later use iCloud or another sync service, keep backups and avoid running multiple Brain writers against the same synced vault at the same time.

## 5. Download Obsidian Brain MCP

Clone the repository into a location you will not move later:

```bash
mkdir -p "$HOME/.local/share"
export BRAIN_DIR="$HOME/.local/share/obsidian-brain-mcp-server"

git clone https://github.com/amolani/obsidian-brain-mcp-server.git "$BRAIN_DIR"
cd "$BRAIN_DIR"
npm ci
```

The hooks and MCP registration store absolute paths. If you move the repository later, you must repair the hooks and re-register the server.

## 6. Set and verify the two paths

Run these commands in the same Terminal window:

```bash
export BRAIN_DIR="$HOME/.local/share/obsidian-brain-mcp-server"
export VAULT_PATH="$HOME/Documents/Obsidian/MyBrain"

test -f "$BRAIN_DIR/server.ts" && echo "Brain server found"
test -d "$VAULT_PATH" && echo "Vault found"
```

Both confirmation lines must appear. Change `VAULT_PATH` if your vault is somewhere else.

These exports only prepare the current Terminal window. The following installation commands save the absolute paths in Claude's configuration. This project does not automatically load `.env` files.

## 7. Create private customer routing

Customer routing maps exact project-folder aliases to customer names. Do not put real customer names into the repository's tracked `clients.json`. Instead, create a private configuration outside the clone:

```bash
mkdir -p "$HOME/.config/obsidian-brain"
export CLIENTS_PATH="$HOME/.config/obsidian-brain/clients.json"
nano "$CLIENTS_PATH"
```

Paste this fictional starting point:

```json
{
  "_comment": "Canonical customer name -> exact folder aliases",
  "Example Co": ["example-co", "example"]
}
```

In Nano, press `Ctrl+O`, then `Enter` to save, and `Ctrl+X` to close. Replace the fictional values only in this private file. If no alias matches confidently, the Harvester deliberately writes to `Technik/...` or `Referenz/...` instead of guessing a customer.

Persist the private path for future Terminal sessions:

```bash
CLIENTS_PATH_LINE='export CLIENTS_PATH="$HOME/.config/obsidian-brain/clients.json"'
grep -qxF "$CLIENTS_PATH_LINE" "$HOME/.zprofile" 2>/dev/null || echo "$CLIENTS_PATH_LINE" >> "$HOME/.zprofile"
export CLIENTS_PATH="$HOME/.config/obsidian-brain/clients.json"

test -f "$CLIENTS_PATH" && echo "Private client config found"
```

The confirmation line must appear. Claude Code started from Terminal inherits this variable, so the automatic hooks use the same private configuration. The next step also stores the path explicitly in the MCP registration.

Never commit or push real customer names, confidential identifiers, or internal paths to the public repository.

## 8. Install the automatic Claude Code hooks

First preview the change:

```bash
cd "$BRAIN_DIR"
node cli.ts install-hooks --vault "$VAULT_PATH"
```

The preview does not write anything. If the paths look correct, apply it:

```bash
node cli.ts install-hooks --vault "$VAULT_PATH" --apply
```

The installer preserves unrelated Claude settings and creates a timestamped backup when it changes an existing `~/.claude/settings.json`.

The hooks provide session context, long-session checkpoints, and automatic capture. They are required for the automatic workflow described in the main README.

## 9. Register the MCP server

Register the server at user scope so Claude can use it in every project:

```bash
claude mcp add \
  --transport stdio \
  --scope user \
  --env "VAULT_PATH=$VAULT_PATH" \
  --env "CLIENTS_PATH=$CLIENTS_PATH" \
  obsidian-brain \
  -- node "$BRAIN_DIR/server.ts"
```

If Claude reports that `obsidian-brain` already exists, remove only that registration and then repeat the preceding command:

```bash
claude mcp remove --scope user obsidian-brain
```

## 10. Check the installation

Run the local setup check:

```bash
cd "$BRAIN_DIR"
node cli.ts doctor --vault "$VAULT_PATH"
```

Interpret the result as follows:

| Status | Meaning during initial setup |
|---|---|
| `fail` | Fix this before using the vault |
| `warn` | Often normal while generated views do not exist yet |
| `ok` | The check is fully satisfied |

The important first milestone is **0 failed checks**.

Now start a completely new Claude session:

```bash
mkdir -p "$HOME/obsidian-brain-test"
cd "$HOME/obsidian-brain-test"
claude
```

Inside Claude, enter `/mcp` and confirm that `obsidian-brain` is connected. Then send this prompt to Claude:

```text
Use the brain_health_check tool. Do not change anything yet.
Explain every warning in simple language.
```

If Claude can execute the tool and reports no failures, the essential installation works. Obsidian does not need to be open for this test.

Continue with **[Your first real session](../README.md#your-first-real-session)** to test automatic capture safely.

## Troubleshooting

### `brew: command not found`

Homebrew may not yet be in the Zsh path. This block detects the normal Apple-silicon or Intel location and adds it without duplicating the profile entry:

```bash
if [ -x /opt/homebrew/bin/brew ]; then
  BREW_EXE=/opt/homebrew/bin/brew
  BREW_PATH_LINE='eval "$(/opt/homebrew/bin/brew shellenv)"'
elif [ -x /usr/local/bin/brew ]; then
  BREW_EXE=/usr/local/bin/brew
  BREW_PATH_LINE='eval "$(/usr/local/bin/brew shellenv)"'
fi

if [ -n "${BREW_EXE:-}" ]; then
  grep -qxF "$BREW_PATH_LINE" "$HOME/.zprofile" 2>/dev/null || echo "$BREW_PATH_LINE" >> "$HOME/.zprofile"
  eval "$("$BREW_EXE" shellenv)"
else
  echo "Homebrew was not found; repeat step 2"
fi

brew --version
```

### `node: command not found` or Node is too old

Install or upgrade Node.js 24 and restore its path:

```bash
brew update
brew install node@24
brew upgrade node@24
NODE24_BIN="$(brew --prefix node@24)/bin"
NODE24_PATH_LINE="export PATH=\"$NODE24_BIN:\$PATH\""
grep -qxF "$NODE24_PATH_LINE" "$HOME/.zprofile" 2>/dev/null || echo "$NODE24_PATH_LINE" >> "$HOME/.zprofile"
export PATH="$NODE24_BIN:$PATH"
node --version
```

If `brew install` says the formula is already installed, continue with the remaining commands.

### `claude: command not found`

The native installer normally places Claude in `~/.local/bin`. Add that folder to Zsh and reopen Terminal:

```bash
CLAUDE_PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
grep -qxF "$CLAUDE_PATH_LINE" "$HOME/.zprofile" 2>/dev/null || echo "$CLAUDE_PATH_LINE" >> "$HOME/.zprofile"
export PATH="$HOME/.local/bin:$PATH"
claude --version
```

For other installer problems, use Anthropic's official [installation troubleshooting](https://code.claude.com/docs/en/troubleshoot-install).

### `Operation not permitted` or `EACCES` for the vault

Open **System Settings → Privacy & Security → Files and Folders**. Allow your terminal application to access the Documents folder, then close and reopen Terminal and Claude.

Do not grant Full Disk Access unless it is actually required. Access to the selected vault folder is sufficient.

### Claude cannot see `brain_health_check`

Close all Claude sessions and start a new one after registering the MCP server. Inside Claude, use `/mcp` to check the connection.

You can inspect the saved registration from a normal Terminal window:

```bash
claude mcp get obsidian-brain
claude mcp list
```

If the saved program or vault path is wrong, remove the registration and repeat [step 9](#9-register-the-mcp-server).

### Paths contain spaces

Keep every path and variable expansion in quotes:

```bash
node cli.ts doctor --vault "$VAULT_PATH"
```

Do not write `--vault $VAULT_PATH` without quotes.

## Updating later

Open Terminal and run:

```bash
export BRAIN_DIR="$HOME/.local/share/obsidian-brain-mcp-server"
export VAULT_PATH="$HOME/Documents/Obsidian/MyBrain"
export CLIENTS_PATH="$HOME/.config/obsidian-brain/clients.json"

cd "$BRAIN_DIR"
git pull --ff-only
npm ci
node cli.ts repair-hooks --vault "$VAULT_PATH"
node cli.ts repair-hooks --vault "$VAULT_PATH" --apply
npm run release-check
```

Restart Claude afterward. If your vault lives elsewhere, change `VAULT_PATH` before running these commands.

For removal instructions, safety information, and the everyday workflow, return to the **[main README](../README.md)**.
