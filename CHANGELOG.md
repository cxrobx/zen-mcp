# Changelog

All notable changes to this project will be documented here. Versions track the
extension manifest and the AMO-signed XPI artifacts. Server, daemon, and shared
package versions move together with the extension.

## Unreleased — expected account per host

The route table decided the cookie jar and stopped there, but a jar is not an identity: Geek
holds four signed-in Google accounts, so `decodo.com` and `pocketbuddy.org` route to the same
container and sign in as different people. The account chooser is where that goes wrong, and
nothing in the transcript said which row was right.

A new top-level `accounts` section maps a host to the identity expected there, and a container
may declare a default `account` for the hosts that name none. The host's own entry wins.
`open_url`, `new_page_in_container` and `container_routes` print
`expected account: ... (verify it at the account chooser)`.

Both carriers are keys an older parser skips, deliberately: dozens of long-lived MCP processes
read this file and load their parser once, so a grammar only new code can read would disarm
routing in every running session until the last one cycled — the silent wrong jar the table
exists to prevent. An inline `{ host, account }` entry inside a pattern list was the obvious
shape and was rejected for exactly this reason; an `accounts` host that routes nowhere fails
the file loudly rather than sitting there doing nothing.

It is deliberately **advisory**, unlike `consoles`, which fails loudly. The table can see
which jar a URL lands in; it cannot see which row gets clicked on a provider's chooser, so
enforcement would be a promise the code cannot keep. A malformed `account` still fails the
whole file loudly, like any other bad rule.

## Unreleased — container routing for shared consoles (Google Search Console et al.)

Host → container routing answered "which cookie jar owns this domain?", which is the wrong
question for a **console**: one host serving every project's dashboard, where only a query
param says which property you are looking at. `search.google.com` could map to exactly one
container, so a Search Console URL for one project opened in another project's jar — or,
with no rule at all, in whichever jar the calling `zen-*` entry happened to default to.
That is the wrong-login failure the route table exists to prevent, and it looks like
success.

The config gains two sections, which compile into the same rule list as before:

```json
{
  "containers": {
    "Geek": ["pocketbuddy.org", "teacherhero.org"],
    "CXVentures": { "domains": ["cxventures.io"], "aliases": ["acct_1ABC99"] }
  },
  "consoles": ["search.google.com"]
}
```

A container declares its **identifying strings** — `domains` (a bare list is shorthand)
plus optional `aliases`, opaque strings for consoles whose URLs carry an account id rather
than a domain. A console routes to whichever container's string appears in the
percent-decoded **path, query, or fragment** — never the hostname or userinfo — matched on
token boundaries so `pocketbuddy.org` claims neither `notpocketbuddy.org` nor
`pocketbuddy.org.evil.com`. Every domain is also a plain host rule, so the simple case
needs no duplication, and several projects can share one container.

Restricting the search to path+query+fragment is load-bearing, not tidiness: scanning the
whole URL let a container owning `stripe.com` match every URL on a `dashboard.stripe.com`
console *inside the console's own hostname*, which silently disabled the claim and pulled
another account's page into the wrong jar. The flip side is inherent and worth knowing:
consoles put the property in the query, so **the URL's text decides the container** — pass
`container` explicitly for a console URL that came from a page or an email.

Cost scales as N+M, not N×M: **a new console is one string; a new project is one entry.**

**A console host is claimed.** A URL on it that mentions no configured string errors and
opens nothing, rather than falling back to the session default — the fallback jar is
exactly the accident being prevented. Two deliberate outs: pass `container` explicitly, or
add a plain `routes` rule for the console host as its default (it sits below the console
tier, so property URLs still route per-project). Corollary: **do not list a host under
`consoles` unless its URLs actually carry your domains or aliases** — Google Analytics keys
by numeric property id, so listing it without matching aliases makes every GA URL error.

The older `{ "routes": { "Container": ["host"] } }` shape is unchanged and still works,
alone or alongside the new sections. `container_routes` shows both views and reports a
claim; `get_firefox_info` counts console hosts.

## Unreleased — renamed `zen-extension-mcp` → `zen-mcp` (breaking for existing installs)

This project was named `zen-extension-mcp` to distinguish it from a Marionette/Selenium
sibling — a local fork of
[`firefox-devtools-mcp`](https://github.com/mozilla/firefox-devtools-mcp) — that owned the
name `zen-mcp`. That fork has been archived and removed: it required launching the browser
with `--marionette`, which defeats the entire point of driving the browser you already have
open, and it had never actually been registered as an MCP server. With one project left,
it takes the shorter name.

**If you are upgrading an existing install, these move:**

| Was | Now |
|---|---|
| `~/.config/zen-extension-mcp/` | `~/.config/zen-mcp/` (auth token, `containers.json`, nav-memory) |
| `~/Library/Logs/zen-extension-mcp/` | `~/Library/Logs/zen-mcp/` |
| `ZEN_EXT_MCP_*` env vars | `ZEN_MCP_*` (e.g. `ZEN_MCP_NAV_MEMORY`, `ZEN_MCP_ROUTES`) |
| launchd label `io.cxrobx.zen-extension-mcp.daemon` | `io.cxrobx.zen-mcp.daemon` |
| npm scope `@zen-ext-mcp/*` | `@zen-mcp/*` |

`mv` the two directories, re-point your MCP registrations at the new
`server/dist/index.js` path, and reload the launchd job. There is no compatibility shim —
a stale path fails as "no rules" or "no token" rather than loudly, so move them rather
than leaving both.

**The extension itself is unchanged.** Its gecko id stays `zen-ext-mcp@cxrobx` and its
version stays 0.0.17, so no re-sign and no reinstall — renaming the id would mean a new
AMO listing and would wipe `browser.storage.local` (daemon URL + token + host grant). The
display name follows on the next signed release.

**Capabilities that left with the fork,** and what to use instead: browser prefs
(`set_firefox_prefs`) → `user.js` / `about:config`; chrome-privileged JS → unavailable, a
hard WebExtension boundary; file upload by path → Playwright; full network response bodies
→ not yet built, but reachable in-extension via `webRequest.filterResponseData()`.

Adding a Marionette mode here was considered and rejected: the launch flag would make such
tools dark by default, and the privileged ones additionally need
`--remote-allow-system-access`, which exposes **unauthenticated** chrome-privileged
execution to any process that can reach `127.0.0.1:2828`.

Verified on Zen 1.21.9b / Firefox 153: 8 live probes, the container-routes and tab-target
suites, nav-memory, and the offline smoke test all pass after the move.

## Unreleased (container routing — server only, no extension change)

A URL's container was decided by *which MCP entry made the call*, not by the URL. So
`artistadvisory.io` opened in no container from `zen-ext` and in `Personal` from
`zen-personal`, splitting one project's session across cookie jars, and every call opened
another duplicate tab next to the one already showing that site.

- **Host → container route table** (`server/src/routes.ts`), loaded from
  `~/.config/zen-mcp/containers.json` (or `ZEN_MCP_ROUTES`). A rule matches its
  host and subdomains; `*.example.com` is subdomains-only; `localhost:3000` pins a port. Most
  specific match wins. Nothing personal ships in the repo — an absent file simply means no
  rules, while a malformed one reports its parse error instead of looking empty.
- **`open_url`** resolves the owning container, then goes to the tab already open on that host
  *in that container* — focusing it when it is already at that URL, otherwise navigating it —
  and opens a new tab only when there is none. `reuse: "host" | "exact" | "never"`, background
  unless `active: true`. Reuse never crosses a container boundary, and only sees the active Zen
  workspace.
- **Precedence, printed on every call:** explicit argument → host rule → session default
  (`--container` / `set_default_container`) → none. A route naming a container that does not
  exist **errors and opens nothing**; a silent fallback is how a login lands in the wrong jar.
- `new_page` follows the table too; `new_page_in_container` still wins but names the rule it
  overrode; `navigate_page` reports when it is loading a URL into a container that a rule maps
  elsewhere (a tab cannot change container). `list_pages` and `select_page` take a `container`
  filter — `list_pages` keeps positions and the `tabSet` fingerprint anchored to the full
  visible set. New `container_routes` tool (`url` to resolve one, `reload` after editing);
  `get_firefox_info` gains `mcp.containerRoutes`. `ZEN_MCP_CONTAINER_ROUTES=0` disables.
- **Mid-load reuse.** A new tab reports `about:blank` until its navigation commits, so a second
  `open_url` moments later used to open a duplicate (found by the live probe, not the stub).
  The session now remembers what it asked each tab to load for 30s and counts that as the
  tab's URL while it is blank; `new_page` and `open_url` also report the requested URL instead
  of the extension's `about:blank`.
- Coverage: `npm run test:container-routes` (17 tests, stub extension) and
  `node scripts/probe-routes.mjs` (live Zen; reads the real table read-only, exercises
  `open_url` against a throwaway one, verifies no pre-existing tab moved).

## Unreleased (nav-memory consolidation — daemon/server only, no extension change)

Nav memory captured and distilled reliably but never *consolidated*: after three days of
real use, all 46 notes sat at `reinforced: 1` and zero merges had ever fired. The distiller
couldn't see what it had already written, so every run re-invented the phrasing and missed
both the exact-id and normalized-text dedupe paths; the embedding merge threshold (`0.9`)
sat above the measured same-host similarity ceiling (0.888); and with `reinforced` pinned at
1, the `1 + log2(reinforced)` ranking multiplier was a store-wide constant, so
repeatedly-confirmed knowledge never outranked a one-off.

- **Consolidation-aware distiller.** Each ETL run is shown the host's top 20 notes as a
  numbered `KNOWN NOTES` list and can answer `"reinforces": <number>` instead of restating
  a fact. References are positional integers, not ids — unmangleable, unspoofable, and only
  `1..list.length` is honored. Redaction, prompt-like-text rejection, and the tool allowlist
  still run before any merge decision, and the distiller sandbox is untouched.
- **Hourly consolidation sweep** as the safety net for duplicates the distiller can't see
  (other hosts, other sessions). Pairwise cosine within each host; merges at or above the
  new shared `MERGE_SIMILARITY` (0.86). Keeps the higher-confidence note, sums `reinforced`,
  unions `tools`, keeps the earliest `createdAt` and latest `lastSeenAt`. A seed can be a
  merge target but never a deleted source. Every merge logs at `info` (host, kept, dropped,
  score) so it's auditable and recoverable via `nav_memory_forget`. The first sweep after
  upgrade is also the migration for the existing store — no separate script.
- **Insert-path threshold lowered** from `0.9` to the same `MERGE_SIMILARITY` (0.86),
  citing the measured distribution: real duplicates 0.864–0.888, distinct facts ≤ 0.843.
- **Session durability.** Events lived only in daemon RAM until WS disconnect, so a
  `kill -9` lost everything and an all-day session never flushed. Sessions now also
  checkpoint when idle for 10 minutes or when they reach 400 events (instead of
  shift-dropping at the 500 cap). Fragmented work files are harmless now that re-learned
  facts reinforce.
- **Consumed work is archived, not deleted.** `sessions/done/` keeps already-redacted work
  files as a durable usage history (300 files / 30 days, pruned like the other queues);
  `nav_memory_forget` with a host purges them too, and the count surfaces in stats.
- **Telemetry.** Successful ETL now logs `created`/`merged` (previously only failures
  logged). `nav_memory_stats` gained `done` and an `etl` block — `created`, `merged`,
  `consolidated`, `lastEtlAt`, `lastConsolidateAt` — making "is it learning?" one call.
  Meta fields are additive; no store schema bump.
- **Probe hygiene.** Every probe that drives live Zen now runs with
  `ZEN_MCP_NAV_MEMORY=0`, so probe traffic stops polluting the real store (16 of 40
  learned notes were `example.com` junk). `probe-navmem.mjs` keeps capture on by design.

## Unreleased (durable tab addressing — server only, no extension change)

Fixes a latent retargeting bug. Zen Workspaces scope `browser.tabs.query({})` to the
**active workspace**: tabs in other workspaces are absent from the WebExtension API
entirely, not hidden-but-listed. Because every tool addressed tabs by `pageIdx` — a
*position* in that visible list — switching workspaces mid-session silently re-pointed
every index at a different tab. Nothing errored; the operation just landed somewhere else.
Observed live as `get_firefox_info` reporting `tabs: 71` then `tabs: 25` over one
uninterrupted extension connection, with a client's Search Console property among the
newly-visible set.

- **Every per-tab tool now accepts `tabId` as well as `pageIdx`** (exactly one, never
  both). `tabId` resolves by identity against the visible set; if the tab is not there the
  call fails with `NOT_FOUND` — *"tabId N not found in the active workspace — it may be in
  another Zen workspace. Switch workspaces or re-resolve by URL."* — and no RPC is sent to
  the browser. Recovery stays manual on purpose: silently reaching into another workspace
  would be a variant of the same bug.
- `pageIdx` keeps working unchanged for backward compatibility, but its `.describe()` text
  and the out-of-range error now say it is positional and shifts on workspace switches.
  `select_page` gained `tabId` alongside its existing `url` / `title` matching.
- **`list_pages`** gained a header: visible tab count, a `tabSet=` fingerprint of the
  visible `(windowId, index, tabId)` set, and a note that `[n]` is a position while
  `tabId=` is the handle.
- **`expectTabSet`** (optional, on every per-tab tool): pass the fingerprint from
  `list_pages` and the call fails `STALE` without acting if the visible set changed.
- **`get_firefox_info`** now reports `tabs.visible` (labeled active-workspace-only),
  `tabs.fingerprint`, and `tabs.workspaceId: (not exposed by Zen to WebExtensions)` —
  stated explicitly rather than inventing an identifier Zen does not expose.
- `wait_for(condition=url)` errors if the tab leaves the visible set mid-wait instead of
  polling a vanished tab until timeout.
- Nav-memory attributes notes by `tabId` when given, so observations can't be filed
  against whatever page now occupies a stale index.
- **No extension change** — the wire protocol already carried `tabId` end to end;
  `pageIdx` only ever existed in the MCP tool surface. No manifest bump, no re-signing.
  Running Claude sessions hold the old `server/dist/index.js` in memory and must be
  restarted to pick this up.
- Verified: `node --test scripts/tab-target.test.mjs` (8 tests — drives the real MCP server
  against a stub extension whose visible tab set is swapped mid-session, asserting the
  tools error rather than act, and that no RPC reaches the browser); live
  `scripts/probe-tabid.mjs` against real Zen (25 visible tabs); `scripts/probe-pages.mjs`
  and `scripts/probe-dom.mjs` still pass on the `pageIdx` path; `scripts/smoke.mjs` and
  `npm run test:nav-memory` unchanged.

## 0.0.13 (non-disruptive automation: background tabs + focus-free screenshots)

- `new_page` / `new_page_in_container` now open tabs in the **background** by
  default instead of foregrounding them. Added an optional `active` param
  (default `false`) to both tools; pass `active: true` to bring the new tab to
  the front. Handler default is `params.active ?? false`, so even an older
  server that doesn't send the field gets background behavior.
- `screenshot_page` no longer activates the target tab and focuses its window
  before capturing. It now uses `tabs.captureTab(tabId)`, which captures a
  specific tab in place. This removes the only remaining focus-steal in the
  normal automation path.
- Net effect: an MCP entry can drive one container (e.g. `zen-cxv`) while you
  browse in another (e.g. `zen-personal`) without your active tab or window
  focus being disturbed. The only tools that surface a tab are now `select_page`
  and an explicit `new_page(..., active: true)`.
- Verified live (`scripts/probe-focus.mjs`): a default `new_page` opened in the
  background and left the originally-active tab active; `screenshot_page`
  returned a full ~162 KB image of that inactive background tab without changing
  focus; `active: true` still foregrounded. The probe restores the original
  active tab on exit.

## 0.0.9 (keepalive bug fix)

- `connect()` was bailing on a stale `this.ws` even when the socket was
  already CLOSED. The keepalive alarm checked the cached `state` field
  ("authenticated") rather than the actual `ws.readyState`, so after the
  daemon restarted the alarm thought everything was fine and never kicked
  a new connect. Fix: alarm calls a new `isHealthy()` (returns
  `ws.readyState === OPEN`) and triggers `forceReconnect()` if not. Connect
  now gates on `OPEN || CONNECTING`, treats CLOSED/CLOSING as null.
- Verified: killed the daemon process; launchd restarted it; extension
  reconnected within ~450ms via the keepalive alarm without any user
  action.

## 0.0.8 (keepalive)

- Add `browser.alarms` "zen-ext-keepalive" firing every 30 seconds. The alarm
  keeps the MV3 background alive across Firefox's idle suspension and re-kicks
  the WebSocket connect if the previous one was torn down. Without this, the
  extension's background suspends after ~80 seconds of "idle" (despite the
  active WebSocket), `setTimeout`-based reconnect timers die with it, and the
  extension stays disconnected until something else wakes it (e.g. opening
  the options page). Long-lived WebSockets do not, in practice, keep MV3
  backgrounds alive in Firefox 147.
- New manifest permission: `alarms`.

## 0.0.7 (Milestone 4)

- New tool: `get_firefox_info`. Returns MCP server identity (name, version,
  daemon URL, current container scope) plus extension-side runtime data
  (extension id/version, platform, userAgent, window/tab/container counts,
  protocol version). Replaces the Marionette fork's `get_firefox_output` semantics.
- README rewrite: full v1 tool list, AMO key creation, install gotchas
  (in-place upgrade flakiness, host-permission opt-in for screenshot),
  multi-MCP-entry pattern, troubleshooting.
- CHANGELOG added.
- No protocol changes from 0.0.6.

## 0.0.6 (Milestone 3 fix)

- `screenshot_page`: stop passing `windowId` to `tabs.captureVisibleTab` and
  instead activate the target tab + capture the focused window. Avoids a Zen
  quirk where the windowId form rejects with "Missing activeTab permission"
  even when `<all_urls>` is granted.

## 0.0.5 (Milestone 3)

- Ported the Marionette fork's `src/firefox/snapshot/injected/` to
  `extension/src/snapshot/`. Builds as a separate esbuild IIFE entry
  (`dist/snapshot/inject.js`) that exposes `window.__zenExtMcpCreateSnapshot`,
  lazy-injected via `scripting.executeScript({ files, world: 'MAIN' })`.
- New tools: `take_snapshot`, `clear_snapshot`, `click_by_uid`, `hover_by_uid`,
  `fill_by_uid`, `fill_form_by_uid`, `drag_by_uid_to_uid`,
  `resolve_uid_to_selector`, `evaluate_script`, `screenshot_page`.
- Background caches `uidMap` per tabId; `webNavigation.onCommitted` and
  `tabs.onRemoved` clear it.
- Manifest gains `webNavigation` permission and `host_permissions: ["<all_urls>"]`.
- `fill_*` uses the `value` setter from the prototype to bypass React-style
  state shadowing, then dispatches `input` + `change`.

## 0.0.4 (Milestone 2)

- New tools: `list_pages`, `new_page`, `new_page_in_container`,
  `set_default_container`, `navigate_page`, `select_page`, `close_page`,
  `navigate_history`.
- `pageIdx` is sorted by `(windowId, tab.index)` for stability across
  `list_pages` calls within a single window/tab arrangement.
- `--container <name>` flag at server startup sets a mutable default scope
  for that MCP entry. `set_default_container` updates it at runtime.

## 0.0.3 (Milestone 1 fix + reconnect cleanup)

- Drop `upgrade-insecure-requests` from the default CSP via explicit
  `content_security_policy.extension_pages`. Without this Firefox MV3
  silently rewrites `ws://127.0.0.1` to `wss://127.0.0.1`, which the daemon
  doesn't speak and the connection hangs forever in CONNECTING.
- Make `connect()` idempotent (`if (this.ws) return;`) and gate the close
  handler on `wasCurrent` to avoid two parallel sockets fighting for the
  daemon's single extension slot.

## 0.0.2

- Lost release. The extension's settings persisted but a connect-storm bug
  shipped along with the CSP fix attempt.

## 0.0.1 (Milestone 1)

- Initial scaffold. Three workspaces (`shared`, `daemon`, `server`,
  `extension`), one tool: `list_containers`.
- Shared-secret auth with constant-time compare, 30s heartbeat, reconnect
  with exponential backoff capped at 10s.
- Daemon binds 127.0.0.1:8765 by default; `--port <n>` flag for collisions.
- MCP server `--container <name>` resolves at startup using the
  `resolveContainerByName` helper ported verbatim from the Marionette fork.
- Signed via AMO unlisted (`web-ext sign --channel=unlisted`); install once
  into daily Zen, persists across browser restarts.
