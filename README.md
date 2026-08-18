# zen-mcp

WebExtension-backed MCP for Zen / Firefox. It lives as a permanently-installed signed extension in your daily browser — **no launch flags, no restarts**, container scoping per MCP entry.

That is the whole design premise. Marionette/WebDriver-based browser MCPs (including [`firefox-devtools-mcp`](https://github.com/mozilla/firefox-devtools-mcp), which this project once had a sibling fork of) reach further into the browser, but they require launching it with `--marionette`, so they can't drive the browser you already have open with all your sessions in it. This one trades that reach for actually being usable every day.

```
Claude Code  --stdio-->  MCP server (per session, --container-scoped)
                              |
                              | ws://127.0.0.1:8766
                              v
                         daemon (long-lived router)
                              ^
                              | ws (token auth, 30s heartbeat)
                              |
                         MV3 extension (signed, in daily Zen)
```

## What this is good for, and what it can't do

Use it when the automation has to happen **in your real browser** — authenticated dashboards, admin consoles, anything behind a login — or when you want several container-scoped MCP entries (`zen-cxv`, `zen-personal`, …) sharing one running browser that never gets interrupted.

The current surface is **41 tools** (38 browser tools plus 3 local navigation-memory tools).

What the MV3 sandbox puts out of reach, and what to use instead:

| Out of reach | Use instead |
|---|---|
| Browser prefs (`set_firefox_prefs`) | `user.js` or `about:config` |
| Chrome-privileged JS (driving the browser's own UI) | not available — this is a hard WebExtension boundary |
| File upload by path | Playwright, for anything that doesn't need your session |
| Full network response bodies | reachable but not yet built — `webRequest.filterResponseData()` (Firefox-only MV3 API; needs `webRequest` + `webRequestBlocking` + `webRequestFilterResponse`) |

A Marionette mode was considered and deliberately rejected: it would still need the launch flag (so it would be dark by default), and the privileged tools additionally need `--remote-allow-system-access`, which exposes **unauthenticated** chrome-privileged execution to anything that can open a socket to `127.0.0.1:2828`.

## Tool surface

Per-tab tools take `tabId` (durable) or `pageIdx` (positional) — see [Addressing tabs](#addressing-tabs-tabid-vs-pageidx) below before using `pageIdx`.

| Bucket | Tools |
|---|---|
| **Containers** | `list_containers`, `container_routes`, `set_default_container`, `new_page_in_container` |
| **Pages** | `open_url`, `list_pages`, `new_page`, `navigate_page`, `select_page`, `close_page`, `navigate_history`, `screenshot_page` |
| **DOM read** | `take_snapshot`, `clear_snapshot`, `resolve_uid_to_selector`, `evaluate_script`, `get_page_text`, `read_page`, `find_by_text`, `wait_for` |
| **DOM actions** | `click_by_uid`, `hover_by_uid`, `fill_by_uid`, `fill_form_by_uid`, `drag_by_uid_to_uid`, `click`, `hover`, `fill`, `fill_secret`, `type`, `drag`, `select_option`, `press_key`, `scroll` |
| **Cookies/storage** | `get_cookies`, `set_cookies`, `clear_cookies`, `get_storage`, `set_storage`, `clear_storage` |
| **Diagnostics** | `get_firefox_info` |
| **Navigation memory** | `get_domain_playbook`, `nav_memory_stats`, `nav_memory_forget` |

### Addressing tabs: `tabId` vs `pageIdx`

Every per-tab tool accepts **either** `tabId` (durable) or `pageIdx` (positional) — exactly one, never both. Both come from `list_pages`, which prints `tabId=NNN` on each line and a `tabSet=` fingerprint in its header.

**Prefer `tabId`.** `pageIdx` is a position in the currently visible tab list, so it is only valid for as long as that list is unchanged.

> ⚠️ **Zen Workspaces caveat.** Zen scopes `browser.tabs.query({})` to the **active workspace**. Tabs in other workspaces are *absent from the WebExtension API entirely* — not hidden-but-listed. So switching workspaces mid-session re-points every `pageIdx` at a different tab, and no error is raised: the operation just lands somewhere else. With `tabId` the same switch produces a loud `NOT_FOUND` ("tabId N not found in the active workspace — it may be in another Zen workspace") and nothing is sent to the browser.
>
> Recovery is deliberate, not automatic: switch back to the workspace holding the tab, or re-resolve it with `select_page({ url: "substring" })`. Nothing silently reaches across workspaces, because reaching into the wrong workspace is the bug itself.

Optional guard for `pageIdx` callers: pass `expectTabSet` with the fingerprint from the `list_pages` header. If the visible set changed at all (tab opened, closed, or workspace switched), the call fails with `STALE` **without acting**.

`get_firefox_info` reports `tabs.visible` and `tabs.fingerprint` for the active workspace. It reports no workspace id because **Zen exposes none to WebExtensions** — the fingerprint is the only available signal, and while it always changes on a workspace switch, it also changes on any ordinary tab open/close.

### Container routing: let the domain pick the container

Without a route table, a URL's container is decided by *which MCP entry issued the call* — so the same site lands in a different cookie jar depending on whether it was `zen-ext` or `zen-cxv`, and every call opens another duplicate tab. A **host → container table** makes the domain decide instead.

The table is a user config file, absent by default, read from `$XDG_CONFIG_HOME/zen-mcp/containers.json` (falling back to `~/.config/...`), or from `ZEN_MCP_ROUTES`:

```json
{
  "containers": {
    "Artist Advisory": ["artistadvisory.io"],
    "CXVentures": { "domains": ["cxventures.io"], "aliases": ["acct_1ABC99"] },
    "Buildersbuddy": ["buildersbuddy.org", "localhost:3200"]
  },
  "consoles": ["search.google.com"]
}
```

Each **container** declares its identifying strings: `domains` (a bare list is shorthand for domains-only) and optional `aliases` — opaque strings like a Stripe account id for consoles whose URLs carry no domain. Every domain is automatically a host rule too, so the simple case needs nothing else.

A **console** is a shared multi-project host — one login page, N projects' dashboards — like Google Search Console, where only the URL's `resource_id` says which property you're looking at. A console URL routes to whichever container's domain or alias appears in the **percent-decoded path, query, or fragment** — never the hostname or userinfo, so a container owning `stripe.com` cannot silently swallow every URL on a `dashboard.stripe.com` console — matched on token boundaries (so `pocketbuddy.org` claims neither `notpocketbuddy.org` nor `pocketbuddy.org.evil.com`). A `*.example.com` domain contributes the token `.example.com`, excluding the apex exactly as its host rule does.

Because the query is where consoles actually put the property, **the URL's own text decides the container** — appending `?x=someproject.org` steers routing. The claim catches accidents, not hostile URLs; pass `container` explicitly for a console URL you got from a page or an email. A console URL that mentions *no* configured string — the property picker, an unconfigured site — **fails loudly and opens nothing**, because falling back to the session default is precisely the wrong-cookie-jar accident the table exists to prevent. Two escape hatches: pass `container` explicitly (always wins), or add a plain `routes` rule for the console host to act as its deliberate default. **Only list a host under `consoles` if its URLs actually carry your domains or aliases** — Google Analytics, for instance, keys URLs by numeric property id, so listing it without matching aliases makes every GA URL error.

The older `{ "routes": { "Container": ["host", ...] } }` shape still works, alone or alongside the sections above.

Matching: a rule matches its host **and its subdomains** (`cxventures.io` covers `qes.cxventures.io`); `*.example.com` matches subdomains only; `localhost:3000` pins a port. The most specific matching rule wins — console rule (host + identifying string) over any host-only rule, exact host over parent domain, port-pinned over port-agnostic.

### fill_secret: Keychain secrets without transcript exposure

`fill`'s `value` parameter is the only door into a form field, and everything in a tool call is conversation transcript — so filling a credential meant either exposing it or giving up on the browser. `fill_secret` closes that gap: it takes a secret **NAME**, resolves the value from the macOS login Keychain (service `cx-secret`, the secrets-kit store) **inside the server process**, and hands it straight to the fill RPC. The value transits only process memory and the token-authenticated localhost WebSocket — never the transcript. The result reports the name and character count; every outgoing string (error paths included) is scrubbed of the value.

A secret may only be filled into a host it is **explicitly bound to**, in `$XDG_CONFIG_HOME/zen-mcp/secrets.json` (fallback `~/.config/...`, override `ZEN_MCP_SECRETS`):

```json
{
  "secrets": {
    "MILLIONVERIFIER_PASSWORD": ["app.millionverifier.com"]
  }
}
```

Host match is **exact** (binding `example.com` does not cover `login.example.com` — list both if both are real fill targets), and an unbound host is an **error, never a fallback**: the binding is what stops a misread page or a prompt-injected session from steering a credential into a lookalike form, the same way a password manager binds credentials to origins. A malformed config is a reported error, never treated as empty. First use per server binary may pop a macOS Keychain access dialog — approve it once; a `TIMEOUT` error from this tool usually means that dialog is waiting on screen.

Precedence, highest first: **explicit argument** (`new_page_in_container`, `open_url({ container })`) → **host rule** → **session default** (`--container` / `set_default_container`) → no container. A host rule outranking the session default is what makes a project's URL land in that project's jar from any `zen-*` entry. Every tab-opening call prints the decision and its source, so routing is never invisible:

```
new page tabId=1226 -> https://artistadvisory.io/artists (Artist Advisory)
container: Artist Advisory (firefox-container-8) via route "artistadvisory.io" in ~/.config/zen-mcp/containers.json
```

`open_url` is the tool that uses this end to end: it resolves the container, then **goes to the tab already open on that host in that container** — focusing it if it is already at that URL, otherwise navigating it — and opens a new tab only when there is none. Reuse is `reuse: "host"` by default; `"exact"` reuses only a tab already at that URL, `"never"` always opens. Like `new_page`, it stays in the background unless `active: true`.

Two limits worth knowing. Reuse only sees the **active Zen workspace**, so a matching tab in another workspace is invisible and a new tab is opened. And a tab **cannot change container** — `navigate_page` therefore says so when the URL you are loading is mapped elsewhere, rather than pretending it fixed it.

Failure modes are loud on purpose: a rule naming a container that does not exist **errors and opens nothing**, because a silent fallback is how a login ends up in the wrong jar. A missing file is simply "no rules"; a malformed one reports the parse error instead of looking empty. Inspect the live state with `container_routes` (add `url` to see how one URL resolves, `reload: true` after editing the file) or the `mcp.containerRoutes` line in `get_firefox_info`. Set `ZEN_MCP_CONTAINER_ROUTES=0` to switch routing off for an entry.

Tools the Marionette-based predecessor had that have **no WebExtension equivalent**, and so are absent here by design: `list_privileged_contexts` / `select_privileged_context` / `evaluate_privileged_script`, `set_firefox_prefs` / `get_firefox_prefs`, `restart_firefox`, `upload_file_by_uid`, `install_extension` / `list_extensions` / `uninstall_extension`.

Deferred to v2 (need degraded-fidelity content-script bridges): `list_console_messages`, `clear_console_messages`, `list_network_requests`, `get_network_request`, `accept_dialog`, `dismiss_dialog`, `screenshot_by_uid`, full-page screenshot.

Fidelity gaps to know:
- `screenshot_page` captures the target tab's visible viewport in place via `tabs.captureTab(tabId)` — it does **not** activate the tab or change window focus. It defaults to JPEG quality 80; pass `format: "png"` for lossless output.
- `evaluate_script` requires JSON-serializable results (the `scripting.executeScript` constraint). Returning DOM nodes or non-serializable objects fails. The function body is transpiled and interpreted without `eval()`/`Function()`, so page CSP does not block it.
- Large textual responses from `take_snapshot`, `evaluate_script`, `get_page_text`, `read_page`, `get_cookies`, and `get_storage` honor `maxBytes` + `cursor`.
- Locator actions (`click`, `hover`, `fill`, `type`, `drag`, `select_option`, `press_key`) auto-wait for matches with `timeoutMs` and scroll targets into view before acting.

Focus behavior: automation is non-disruptive by default. `new_page` / `new_page_in_container` open tabs in the **background** (pass `active: true` to foreground), `navigate_page` and the DOM tools act on a tab by id without activating it, and `screenshot_page` captures without focus. The only tools that surface a tab to the foreground are `select_page` and an explicit `new_page(..., active: true)`. This means an MCP entry can drive one container (e.g. `zen-cxv`) while you browse in another (e.g. `zen-personal`) without your focus being stolen.

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

When `--container` is set, it is the **fallback** for URLs no host rule claims — see [Container routing](#container-routing-let-the-domain-pick-the-container), which outranks it. `new_page_in_container` always takes an explicit name and wins over both. `set_default_container` updates the fallback at runtime for that MCP entry. Both new-tab tools open in the background by default; pass `active: true` to foreground the tab.

## Architecture

### Multi-entry pattern

Three Claude Code MCP entries (e.g. `zen-cxv`, `zen-personal`, `zen-buildersbuddy`) each spawn a fresh **MCP server process**. All three connect to the same **daemon** (single TCP port). The daemon routes each request to the single **extension** and routes the response back to the originating client. Order-preserving with a per-request id; no cross-talk.

Two MCP entries calling `new_page` simultaneously each open their own tab in their own container — the daemon doesn't serialize them.

### Auth + heartbeat

- **Token**: shared secret, 32 bytes random hex, stored at `~/.config/zen-mcp/auth.token` (0600). First message on every connection must be a `hello` with the token within 5s. Constant-time compared via `crypto.timingSafeEqual`.
- **Heartbeat**: daemon sends WebSocket pings every 30s. If no pong, the connection is terminated and (for clients) eligible for replacement.
- **Reconnect**: clients (server + extension) reconnect with exponential backoff capped at 10s. Resets to 0 on `welcome`.

### What the daemon owns

The daemon binds the WebSocket port. Exactly **one** extension connection at a time (a new hello with role=extension replaces the old one and fails its in-flight requests). Many clients. Extension-bound requests are routed by request id; a per-id timer fails the call after 30s.

### Navigation memory

The server records only bounded structural facts such as normalized URL shapes, sanitized locators, tool success, navigation, match counts, and stable error codes. It never records entered form values, cookie/storage values, page bodies, evaluated code, find queries, screenshots, or arbitrary error text. Events stream to the daemon during the session; disconnect atomically finalizes one pending work file per host.

The daemon stores notes in an atomic, versioned JSON document and ranks exact-host observations before public-suffix-aware related hosts. Path-scoped notes are injected only on matching paths. Injection is summary-only, capped at 1.5 KiB, framed as advisory data, and occurs once per host per MCP process. `get_domain_playbook` returns the complete reviewed context on demand.

Pending telemetry is distilled in an empty temporary directory by `claude -p --safe-mode --tools "" --no-session-persistence` with schema-constrained output. There is no agentic fallback. Ollama is optional: when unavailable, deterministic ranking and normalized-text deduplication remain active, and missing embeddings are backfilled later.

Notes consolidate instead of accumulating. Each distill run is shown the host's existing notes as a numbered list and answers with `reinforces: <number>` when an observation confirms one, so the note's `reinforced` count grows and it outranks one-offs. An hourly sweep is the safety net for duplicates that arrive by other routes: within each host it merges pairs whose embeddings are at least 0.86 similar, summing `reinforced`, keeping the higher-confidence note, and logging every merge. Seeds can be merge targets but are never deleted.

Sessions are checkpointed to disk when they go idle for 10 minutes or reach 400 events, so an abrupt daemon kill loses at most a few minutes of telemetry and long-running sessions flush continuously.

State directories are mode `0700` and files are `0600`. Pending work is capped at 200 files, failed at 50, and consumed work — archived to `sessions/done/` rather than deleted, as a durable redacted usage history — at 300; all expire after 30 days. `nav_memory_forget` deletes a note or an exact host, including its raw work by default. Forgetting a trusted seed creates a durable tombstone. Export is a copy of `notes.json`; for import, stop the daemon, replace that file with mode `0600`, and restart.

`nav_memory_stats` answers "is it learning?" in one call: the `etl` block reports `created` vs `merged` note mutations, `consolidated` sweep merges, and the `lastEtlAt` / `lastConsolidateAt` timestamps.

### Snapshot caching

`take_snapshot` injects `extension/dist/snapshot/inject.js` via `scripting.executeScript({ files, world: 'MAIN' })`, then calls `window.__zenExtMcpCreateSnapshot`. The returned `uidMap` is cached in the background script keyed by tabId and persisted in `browser.storage.session`, so UIDs survive routine MV3 background suspension. Subsequent `click_by_uid`/`fill_by_uid`/etc. resolve uid -> selector via the cache, then run an inline action `func` against `document.querySelector(selector)`. Traversal is bounded at 100 DOM levels and 5,000 captured nodes so deeply nested framework panels remain reachable without allowing unbounded snapshots.

The cache is dropped on full navigation, SPA history updates, hash changes, and `tabs.onRemoved`. Take a fresh snapshot after any meaningful route change.

## Development loop

For non-prod iteration, skip AMO signing — load the extension as a temporary add-on via `web-ext run`:

```sh
npm run extension:run
```

Navigation-memory verification is local and deterministic:

```sh
npm run test:nav-memory
node scripts/probe-navmem.mjs
node scripts/smoke.mjs
```

Container routing has an offline suite and a live probe. The probe reads your real table read-only, then exercises `open_url` against a throwaway table so reuse can only land on its own tab:

```sh
npm run test:container-routes
node scripts/probe-routes.mjs
```

This opens a fresh Firefox profile with `extension/dist/` loaded as a temporary extension, no signing required. The extension is gone after the dev profile closes — fine for development.

When iterating on extension code with the signed install in production: rebuild + re-sign + remove + reinstall. Use the `npm run extension:sign` script (requires `AMO_KEY` + `AMO_SECRET`).

## Troubleshooting

**`extension not connected` from a tool call**: the extension is between reconnect attempts. Check `about:addons` -> Preferences -> status pill. If it says `error`, look at the background console (`about:debugging` -> Inspect on this extension -> Console). Common: token mismatch, daemon not running, port wrong.

**`Missing host permission for the tab` on `screenshot_page`**: the host permission isn't granted. Toggle "Access your data for all websites" in the extension's Permissions tab.

**Storm of "replacing extension connection" in daemon log**: an old buggy version is still running alongside a new one (two background instances both reconnecting and replacing each other). Fully quit Zen and relaunch — should resolve. If it persists, uninstall and reinstall the extension.

**Port collision**: `--port 8766` (or any other free port) on the daemon, then update the extension's options URL.

**Token rotation**: `rm ~/.config/zen-mcp/auth.token` and restart the daemon. Paste the new value into the options page.

## Security model

- Daemon binds 127.0.0.1 only. No remote network exposure.
- Auth token is the only thing that gates the extension's tool surface from other processes on the same machine. Treat it like any other local credential.
- The signed extension has `<all_urls>` host permission (gated behind explicit user opt-in for site-data access). It can therefore script any page you visit. Don't grant it lightly.
- `evaluate_script` runs arbitrary user-provided JS in the page's MAIN world. The MCP token gates who can call it. There is no per-tool permission check beyond auth.
- Navigation memory is privacy-minimized advisory state, not a proof that arbitrary PII can never occur. Defense comes from structural allowlists, two-stage redaction, local-only permissions, bounded retention, explicit purge controls, and deterministic planted-secret tests.

## License

MIT OR Apache-2.0
