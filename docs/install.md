# Install and run

The full setup reference. The [README quickstart](../README.md#quickstart) is the short path through it.

## Requirements

- Node 20+
- Zen browser (Firefox 115+ derivative) — works in stock Firefox too
- An [AMO](https://addons.mozilla.org) account (free) for signing the extension
- Optional: Claude Code CLI subscription auth for background navigation-note distillation
- Optional: Ollama with `nomic-embed-text` for semantic deduplication and playbook search

## Build

```sh
git clone https://github.com/cxrobx/zen-mcp.git
cd zen-mcp
npm install
npm run build
```

Produces:
- `daemon/dist/index.js` — router process
- `server/dist/index.js` — MCP stdio server
- `extension/dist/` — MV3 extension bundle (esbuild IIFE, no module imports at runtime)

## Sign + install (one-time)

### 1. Get AMO API credentials

1. Sign in at https://addons.mozilla.org with a Firefox Account.
2. Go to https://addons.mozilla.org/en-US/developers/addon/api/key/ — accept the developer agreement.
3. Click **Generate new credentials**. You get:
   - **JWT issuer** (looks like `user:1234567:42`)
   - **JWT secret** (64-hex string, shown once — save somewhere durable)

### 2. Sign

```sh
export AMO_KEY="user:1234567:42"
export AMO_SECRET="..."
npm run extension:sign
```

`web-ext sign --channel=unlisted` uploads the bundle and Mozilla's automated signer returns a signed `.xpi` in `extension/web-ext-artifacts/`. Usually <60s. The `gecko.id` in `extension/src/manifest.json` (`zen-ext-mcp@cxrobx`) is per-developer — change it if you fork this so you don't collide.

### 3. Install in Zen

```sh
open -a "/Applications/Zen.app" extension/web-ext-artifacts/d27cc...-X.Y.Z.xpi
```

Accept the install prompt. **Then grant the host permission**:

- `about:addons` -> Zen Extension MCP Bridge -> **Permissions and data** -> toggle **Access your data for all websites** ON.

This is required for `screenshot_page` (`tabs.captureTab` needs host access to the tab being captured). The other tools work without it.

> **Upgrade gotcha**: in-place upgrades (open a newer XPI while old is installed) sometimes silently no-op in Zen. If the version doesn't change in `about:addons`, **remove the old extension first**, then install the new one. Storage (URL + token settings) gets wiped on full removal.

### 4. Configure the extension

Find the auth token:

```sh
cat ~/.config/zen-mcp/auth.token
```

In Zen, open the extension's Preferences page (via `about:addons`'s `⋯` menu, or the toolbar puzzle-piece icon — varies by Zen UI version). Paste:

- **Daemon URL**: `ws://127.0.0.1:8766`
- **Auth token**: contents of `auth.token`

Click Save. The pill should flip to `authenticated` within 1-2 seconds (it can take up to ~10s if the extension was recently restarted because of reconnect backoff).

## Run

### Start the daemon

```sh
node daemon/dist/index.js --port 8766
```

The daemon writes a 32-byte random token to `~/.config/zen-mcp/auth.token` on first launch (mode 0600). All later launches reuse it.

Default port is 8766. If you collide, use `--port <free-port>` and update the extension's options page URL to match.

Navigation memory defaults to `~/.config/zen-mcp/nav-memory/`. Override it with `--nav-db <dir>` or `ZEN_MCP_NAV_DB`; override the distiller executable with `--claude-bin <path>` or `ZEN_MCP_CLAUDE_BIN`. Set `ZEN_MCP_NAV_MEMORY=0` on an MCP server process to disable new capture and automatic note injection while retaining the explicit playbook tools.

A simple launchd plist for keeping the daemon running:

```xml
<!-- ~/Library/LaunchAgents/io.cxrobx.zen-mcp.daemon.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.cxrobx.zen-mcp.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOU/Projects/zen-mcp/daemon/dist/index.js</string>
    <string>--port</string>
    <string>8766</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

Load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.cxrobx.zen-mcp.daemon.plist` (`bootout` to stop it; the older `load`/`unload` verbs are deprecated).

### Register MCP servers in Claude Code

Each entry is short-lived (one per Claude Code session) and connects to the daemon as a client.

Everything after `--` is the subprocess command, so the whole `node …` invocation goes there.

**Single, no scoping**:

```sh
claude mcp add zen-ext -s user -- node /abs/path/to/zen-mcp/server/dist/index.js --port 8766
```

**Container-scoped** (one per container — they all share the daemon and extension):

```sh
P=/abs/path/to/zen-mcp/server/dist/index.js
claude mcp add zen-cxv           -s user -- node "$P" --port 8766 --container CXVentures
claude mcp add zen-buildersbuddy -s user -- node "$P" --port 8766 --container Buildersbuddy
claude mcp add zen-personal      -s user -- node "$P" --port 8766 --container Personal
```

A container name containing a space must be quoted as one argument: `--container "Artist Advisory"`. Use `-s user` for entries you want in every session; the default scope is `local` (this project only). Confirm with `claude mcp list` — each entry should report `✔ Connected`, which also proves the daemon and extension are both up.

`--container <name>` resolves lazily on first new-tab use: 0 matches errors with the available list; >1 matches errors with the matching list.

When `--container` is set, it is the **fallback** for URLs no host rule claims, and for sessions outside every `projects` directory — see [Container routing](container-routing.md), which outranks it. With `projects` configured, one user-scope entry with `--container Personal` does what the per-container entries above used to, without registering every tool once per container. `new_page_in_container` always takes an explicit name and wins over both. `set_default_container` updates the fallback at runtime for that session and outranks the directory. Both new-tab tools open in the background by default; pass `active: true` to foreground the tab.
