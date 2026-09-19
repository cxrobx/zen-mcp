# zen-mcp — agent guide

WebExtension-backed MCP for Zen (Firefox). User docs in `README.md`; this file is for an agent working on the codebase.

## This is the only Zen MCP — there is no escape hatch

All seven `zen-*` entries in `claude mcp list` point at **this** repo, and nothing else drives Zen. Renamed from `zen-extension-mcp` on 2026-07-29, taking the name from a Marionette/Selenium fork of [`firefox-devtools-mcp`](https://github.com/mozilla/firefox-devtools-mcp) that was **archived and deleted** the same day (bundle: `~/Archives/zen-mcp-marionette-30d675c.bundle`). That fork had never been registered in any MCP scope, so it was unreachable from every session.

**Do not go looking for a privileged fallback, and do not propose adding a Marionette mode here.** It was measured and rejected: Marionette needs the `--marionette` launch flag (the `marionette.enabled` pref alone does not open port 2828 — verified), so such tools would be dark by default and would demand quitting the user's real browser. The privileged ones additionally need `--remote-allow-system-access`, which exposes **unauthenticated** chrome-privileged JS to any local process, in a browser holding banking and client sessions. Full rationale: the `project_zen_mcp_consolidation` memory.

Before doing anything: `claude mcp list | grep zen` to confirm what's wired up.

## Three processes, one bridge

```
Claude Code  --stdio-->  MCP server (per session, --container-scoped)
                             |
                             | ws://127.0.0.1:8766
                             v
                         daemon (launchd, persistent)
                             ^
                             | ws (token auth, 30s heartbeat)
                             |
                         MV3 extension (signed, in daily Zen)
```

- **daemon/** — Node WS router plus persistent nav-memory store/ETL. Single extension, N clients. Auth + ping.
- **server/** — MCP stdio (`McpServer` from `@modelcontextprotocol/sdk`). Connects to daemon as a client, captures structural nav events, and injects advisory summaries once per host. `--container <name>` resolves lazily on first new-tab use, mutable via `set_default_container`.
- **extension/** — MV3 background + options page + lazy-injected snapshot bundle.
- **shared/** — Wire types, method-name constants, error codes. Single source of truth.

## Daily-driver state (already set up)

- Daemon: launchd `~/Library/LaunchAgents/io.cxrobx.zen-mcp.daemon.plist` → `/usr/local/bin/node` runs `daemon/dist/index.js --port 8766`. Logs at `~/Library/Logs/zen-mcp/daemon.{out,err}.log`.
- Extension: signed via AMO unlisted, gecko id `zen-ext-mcp@cxrobx` (**deliberately NOT renamed** — a new id means a new AMO listing and a reinstall that wipes `browser.storage.local`), currently 0.0.18 (installed and live-verified 2026-09-07). Settings (URL + token) live in `browser.storage.local`; snapshot UID maps live in `browser.storage.session`.
- Auth token: `~/.config/zen-mcp/auth.token` (mode 0600, 32-byte hex). Daemon generates on first launch.
- AMO signing creds: `~/.config/zen-mcp/.env` (mode 0600, `AMO_KEY` + `AMO_SECRET`). Sourced by `extension/scripts/sign.sh`; `npm run extension:sign` works with no inline env. Get fresh keys at https://addons.mozilla.org/developers/addon/api/key/.
- 7 MCP entries at user scope (`~/.claude.json`): `zen-ext`, `zen-cxv`, `zen-personal`, `zen-geek`, `zen-music`, `zen-buildersbuddy`, `zen-artist`.

## Iteration loop (it's slow — minimize cycles)

For extension changes:
1. Edit `extension/src/...`
2. **Check AMO for the highest published version before bumping**:
   ```sh
   curl -s https://addons.mozilla.org/api/v5/addons/addon/zen-ext-mcp@cxrobx/versions/ \
     | jq -r '.results[].version' | head -5
   ```
   Pick `max + 0.0.1` and write that into `extension/src/manifest.json`. AMO rejects re-uploads of any previously-signed version, even ones that were deleted locally — the manifest in the repo can lag behind AMO.
3. `npm run build:extension`
4. `npm run extension:sign` — uploads to AMO; signing takes 30-90s. Creds come from `~/.config/zen-mcp/.env`; override inline with `AMO_KEY=... AMO_SECRET=... npm run extension:sign` if needed.
5. **Open the signed XPI in Zen.** Almost always:
   ```sh
   open -a "/Applications/Zen.app" extension/web-ext-artifacts/<file>.xpi
   ```
   This shows the install banner at the top of the active tab. Click Allow → Add/Update. This is what works in practice.
6. Confirm the new version in `about:addons` — **in-place upgrades occasionally no-op silently**, especially across larger version jumps. If the version didn't change: `⋯ → Remove` the old version, then re-run the `open -a` command. **Removal wipes `browser.storage.local`**; user has to re-paste daemon URL + token (`cat ~/.config/zen-mcp/auth.token`) and re-toggle "Access your data for all websites" in the Permissions tab.
7. **Fallback if `open -a` itself silently fails** (rare): serve the XPI over localhost with the right MIME and navigate Zen to it.
   ```sh
   cd extension/web-ext-artifacts && \
     python3 -c "import http.server,socketserver; \
       h=http.server.SimpleHTTPRequestHandler; \
       h.extensions_map['.xpi']='application/x-xpinstall'; \
       socketserver.TCPServer(('127.0.0.1',8772),h).serve_forever()" &
   ```
   Then point Zen at `http://127.0.0.1:8772/<file>.xpi`. Don't reach for this first.

For daemon/server/shared changes only: `npm run build` is enough; no extension reinstall needed. Daemon comes back automatically (launchd KeepAlive).

For dev iteration **without** AMO signing: `npm run extension:run` opens a fresh Firefox profile with `extension/dist/` loaded as a temporary add-on. Gone after profile close.

## Don't talk yourself out of the easy path

The AMO signing pipeline is fully wired up and runnable from the CLI. If you find yourself drafting a paragraph for the user about "AMO signing needs API credentials that only you can create" — stop. The credentials already exist at `~/.config/zen-mcp/.env`, `extension/scripts/sign.sh` sources them, and `npm run extension:sign` just works. The previous session burned ~10 minutes lecturing the user before the user told it to actually look. Run the command first; lecture later only if it fails.

For installation specifically: `open -a "/Applications/Zen.app" <xpi>` triggers the Zen install banner reliably across versions, ports, and fresh-install vs upgrade. Try that first. Only fall back to the localhost-MIME server flow if `open -a` produces nothing — and remember that "nothing" often means the upgrade silently no-op'd, not that `open` failed; check `about:addons` for the active version before changing approach.

## Probes (must validate against live Zen)

| Script | Tests |
|---|---|
| `scripts/smoke.mjs` | Daemon + mock extension + MCP server. Useful for protocol-level changes without a browser. |
| `scripts/probe.mjs` | `list_containers` against real Zen. |
| `scripts/probe-pages.mjs` | M2: new_page, navigate, select, set_default_container, close. Creates + cleans up. |
| `scripts/probe-dom.mjs` | M3 read-side: snapshot, evaluate_script, resolve_uid, screenshot. Targets example.com. |
| `scripts/probe-interact.mjs` | M3 write-side: click, hover, fill, fill_form, rich editor input, pointer sequence, auto-scroll, auto-wait against a self-served localhost fixture. |
| `scripts/probe-info.mjs` | get_firefox_info with and without `--container` scope. |
| `scripts/probe-tabid.mjs` | Durable tab addressing against live Zen: `tabId` round-trip, absent-tabId error, stale `expectTabSet`, mutual exclusion. Creates + closes its own tab. |
| `scripts/probe-hidden.mjs` | Tabs in NON-ACTIVE Zen workspaces against live Zen (T164): `list_pages includeHidden` enumerates them, `get_page_text` reads one in place by `tabId`, `open_url reuse=exact` lands on it instead of opening a tab, and the visible set + active tab are untouched afterwards. Read-only, never switches your workspace. Needs extension ≥ 0.0.18. |
| `scripts/tab-target.test.mjs` | `node --test` regression for the workspace retargeting bug — swaps the stub extension's visible tab set mid-session and asserts a `tabId` is reached by identity (via `pages.get`), a closed tab errors without acting, an old extension keeps the loud failure, `pageIdx` stays guarded, and `list_pages includeHidden` / `select_page` reach the other workspace. `npm run test:tab-target`. |
| `scripts/probe-navmem.mjs` | Scratch-store M0–M4: seeds, host isolation, injection, redaction, ETL, embeddings, stats, and forget. No live browser required. |
| `scripts/container-routes.test.mjs` | `node --test` suite for host→container routing: matcher specificity, precedence, `open_url` reuse, loud failure on a missing container. Stub extension, no browser. `npm run test:container-routes`. |
| `scripts/fill-secret.test.mjs` | `node --test` suite for `fill_secret`: value reaches the fill RPC but never the transcript (hostile echo scrubbed), unbound host / unknown name / Keychain miss all error without attempting a fill, malformed config fails loud. Stub extension + fake `security` binary, no browser, no real Keychain. `npm run test:fill-secret`. |
| `scripts/interactive-goal.test.mjs` + `scripts/navigate-goal.test.mjs` | `npm run test:jev`. Unit: the element collector (labels from descendants, row context, values never shown, off-host/selected flags, the 254 cap) and every `runGoal` stop rule with injected fakes. End-to-end through daemon + server with a stub extension, a fake TypeSafe HTTP server and a logging fake `security`: unlisted host / absent / malformed allowlist send nothing and never read the key, typed values and emails never reach TypeSafe, a persistent 429 fails loud without clicking, an echoed key is scrubbed. No browser, no network. |
| `scripts/probe-goal.mjs` | Live `navigate_goal` against real Zen and the REAL TypeSafe API (metered, sends that page's labels). Opens its own background tab in `--container`, runs `--goal` on `--url`, prints the trace, closes the tab unless `--keep`. The host must be in `~/.config/zen-mcp/jev.json`. Nav memory off. |
| `scripts/probe-transition.mjs` | Live timeline of what a page does after a click: opens `--url` in `--container`, clicks the control whose text is `--text`, and samples readyState / control count / title / text length / path every ~100ms for `--for` ms. This is how the SPA title-swap finding in `docs/jev.md` was measured; run it before tuning any wait constant. Read-only apart from the one click. |
| `scripts/probe-routes.mjs` | Live routing probe. Phase A resolves the REAL table read-only; phase B drives `open_url` against a throwaway `example.com` table and asserts every pre-existing tab is untouched. |
| `scripts/check-space-sync.mjs` | Guards the space-placement conclusion below: asserts BOTH Zen placement mechanisms are off, and that every container still has exactly one space bound to it. `npm run check:spaces`. Read-only against the live Zen profile; readers + the mozlz4 decoder are in `scripts/lib/zen-profile.mjs`. No browser or daemon needed. |

**Run the `node --test` suites under Node ≥ 22** (Chris's login shell resolves nvm's `lts/*` = 24). A non-login shell can fall through to the launchd `/usr/local/bin/node` v20.13, where the suites' top-level `before()` hook never runs — every test then fails with `Cannot read properties of undefined (reading 'setVisibleTabs')` and `container-routes.test.mjs` hangs. That is the Node version, not a regression; `PATH=$HOME/.nvm/versions/node/v24.11.1/bin:$PATH` in front of the command fixes it. Also never run two suites concurrently: each binds a fixed port (18767/18768/…) and a leftover daemon makes the next run fail with `unauthorized: invalid token`.

For nav-memory work run `npm run test:nav-memory`, `node scripts/probe-navmem.mjs`, and the unchanged `node scripts/smoke.mjs`. The default ETL probe uses a fake tool-free Claude executable and fake Ollama endpoint; a live subscription is not a test prerequisite.

After any extension change, run the relevant probe(s) — `npm run build` doesn't catch logic errors in handlers.

## Footguns to remember

- **Zen Workspaces scope `browser.tabs.query({})` to the ACTIVE workspace — but only the QUERY.** Zen rebuilds `gBrowser.tabs` from the active space's strip (`tabbrowser/tabs.js` `allTabs` ← `gZenWorkspaces.tabboxChildren`) and the WebExtension `Window.getTabs()` iterates that, so no query flag (`hidden`, `populate`) ever lists other spaces' tabs — don't try to "fix" it with a better query. The parent-side id map is **not** scoped: `tabTracker.getTab(id)` is a plain lookup, so `tabs.get`, `scripting.executeScript`, `tabs.captureTab` and `tabs.update` all reach any tab by id. That is what `probeHiddenWorkspaceTabs` (`extension/src/handlers.ts`) exploits: ids are dense sequential ints, so it probes every id up to the highest seen (`tabs.onCreated` keeps the horizon current and forces ids onto tabs created in any space). `pages.list({includeHidden})` and `pages.get` ride on it; `findTabById` (`server/src/tools.ts`) resolves a `tabId` outside the visible set that way, flagged `inActiveWorkspace: false`. Selecting such a tab (`tabs.update({active:true})`) trips `gZenWorkspaces.onBeforeTabSelect`, which switches the space natively — no keystrokes. What stays forbidden: `pageIdx` is a position that silently re-points at a different tab when the workspace changes, so it must never search other workspaces, and nothing may auto-reresolve a lost tab by URL — identity by id is fine, guessing by position or text is the bug wearing a hat. `probe-hidden.mjs` verifies the live behavior; `tab-target.test.mjs` pins it offline.
- **zen-mcp picks the CONTAINER; the SPACE is not ours to pick, and both ways of making it ours are worse than the mess.** Zen exposes no workspace id to WebExtensions, so a tab we open is stamped with whatever space is active at that moment (`_shouldShowTab` assigns any tab lacking `zen-workspace-id` to the current one). That looks like a bug worth fixing and is not. Both mechanisms were measured against live Zen 1.21.15b on 2026-08-25 and both were reverted. **`zen.workspaces.force-container-workspace`** files the tab into the space bound to its container, then `ZenSpaceManager.onTabBrowserInserted` runs an unconditional `setTimeout(() => this.changeWorkspace(workspace), 0)` — no `inBackground` check — so every background tab an agent opens yanks the user's browser to another space. **Space Routing rules** (`zen-space-routing.jsonlz4`) do gate that switch on `!inBackground` in `ZenSpaceRoutingManager.#routeToWorkspace`, so focus survives — but the tab is still *moved*, and at the time it disappeared from the extension API the instant it was filed (verified end to end: an `open_url` tab returned `NOT_FOUND` to `close_page` on the very next call). The id-probe path above has since made such a tab reachable, so the reachability half of that objection is moot — but placement stays off: silently relocating a tab into a space the user is not looking at is still a side effect, and untidy-but-where-you-opened-it is the deliberate choice. **One mechanism moves the browser to the tab; the other moves the tab away from where it was opened, and there is no third option** — the scoping is imposed above the WebExtension layer, which is the same constraint as the workspace footgun above. Untidy-but-reachable is the deliberate choice; `npm run check:spaces` fails if either mechanism comes back on. What the 1:1 container↔space binding still buys is the user's *own* new tabs landing in the right jar, so that check stays. **Spaces live in `zen-sessions.jsonlz4` (mozlz4, `spaces[].containerTabId`), NOT in `zen_workspaces` in places.sqlite** — that table is a one-time migration source `ZenSessionManager` reads once on the first launch of Zen 1.21+ and never writes again, so it is a fossil that still lists deleted spaces and misses every space created since; reading it produced a confidently wrong report here (4 of 6 containers "unbound" when all 6 were fine).
- **N sessions share one browser, and only the browser state collides.** Every Claude session spawns its own MCP server per `zen-*` entry, all of them clients of the one daemon (3 projects × 7 entries ≈ 21 clients). The multiplexing is sound and needs no work: the daemon keys `pending` by request UUID → `clientId` and routes each response to its originator, the extension dispatches with `void handleRequest` so no session blocks another, and session-scoped state (`--container` default, container-name cache, `pendingUrls`, nav-memory host injection) lives in the per-session server process where it cannot leak. **Don't move any of that into the daemon** to "share" it. What genuinely collides is one browser's tab state: (a) `pageIdx` re-points when *any* session opens or closes a tab, so the workspace footgun above fires routinely under concurrency — address by `tabId`; (b) `expectTabSet` fingerprints the whole visible set (`tabSetFingerprint`), so an unrelated session's new tab trips it — it fails safe, and scoping the fingerprint to one tab to quiet the noise would destroy the guarantee that makes positional addressing safe at all; (c) snapshot UID maps are keyed by `tabId` alone, so two sessions snapshotting the same tab clobber each other and the loser gets `uid "N_M" not found` — the correct loud failure, not something to paper over; (d) `pendingUrls` only knows tabs *this* process drove, so two sessions opening the same host inside the commit window each open one, which the next `open_url` reuse pass absorbs.
- **CSP `upgrade-insecure-requests`** is in Firefox MV3's default extension CSP and silently rewrites `ws://127.0.0.1` to `wss://`. The daemon doesn't speak TLS so the connection hangs in CONNECTING. The manifest already overrides this (`content_security_policy.extension_pages` without that directive). **Don't remove that override.**
- **`<all_urls>` is opt-in by user in MV3.** Declared in manifest ≠ granted at runtime. User must toggle "Access your data for all websites" in `about:addons`. `screenshot_page` (`tabs.captureTab`) needs this; `scripting.executeScript` works without.
- **`screenshot_page` captures in place and must stay that way.** It calls `tabs.captureTab(tabId, opts)` (`handlers.ts`), which shoots an inactive background tab without activating it or focusing its window. The older `captureVisibleTab` path did need activation — it rejects with "Missing activeTab permission" in Zen even with `<all_urls>`, so it was replaced in `378fd7b`. **Don't "fix" a capture problem by activating the tab first**: that reintroduces focus-stealing from the user's real browser, and it's the one tool that concurrent sessions can otherwise call freely. `scripts/probe-focus.mjs` asserts the no-focus-change behavior.
- **MV3 backgrounds suspend** after ~80s of "idle" in Firefox 147 even with active WebSockets (keepalive re-verified on Firefox 153 / Zen 1.21.9b: still required, still works). The 30s `browser.alarms` keepalive keeps the background alive AND force-reconnects when `ws.readyState !== OPEN`. **Don't remove this** without a replacement strategy.
- **Snapshot UID maps are in `browser.storage.session`.** Keep writes small and keyed by tabId. Clear both memory and session storage on navigation invalidation.
- **Rich-editor `fill`/`type` can't rely on `execCommand("insertText")`.** Firefox gates editing execCommands on `document.hasFocus()`, which is false during background automation — and on framework editors (Lexical/ProseMirror/Slate) it then *lies*, returning `true` while inserting nothing. `richInsert` (`handlers.ts`) gates execCommand on `hasFocus`, else dispatches a synthetic `beforeinput` + explicit Range and **verifies by DOM readback** (~20ms reconcile, measured on Lexical). Only fire `input` yourself when the editor did **not** claim the `beforeinput` (`preventDefault`), or the text double-inserts. If the readback still fails, `runFillLike` escalates to focus-the-window-then-retry (the only path that gives execCommand a trusted, working beforeinput). **Don't "simplify" this back to `textContent = value` or to trusting execCommand's return.**
- **Connect must be idempotent and resilient to stale ws.** `connect()` treats CLOSED/CLOSING as null. The keepalive uses `isHealthy()` (`ws.readyState === OPEN`) not the cached state field — state lies after asymmetric WS shutdown.
- **`evaluate_script`** injects the bundled Babel + eval5 evaluator, transpiles the user function body to ES5, then interprets it against the page window without `eval()`/`Function()` so strict page CSP is not a blocker. User provides a synchronous function body, uses `return` for the result, and must return a JSON-serializable value. DOM nodes fail.
- **AMO signing** rejects re-uploads of an already-signed version. Always bump the manifest version, and check AMO for the highest version (curl + jq snippet above) before deciding what to bump to — local artifacts can lag behind what AMO has on file.
- **Container routing must fail loudly, never fall back.** The host→container table decides which cookie jar a URL lands in, so a rule naming a container that doesn't exist **errors and opens nothing** (`containerNamed` in `server/src/tools.ts`). Do not "improve" this into a fallback to the session default — a page quietly opening in the wrong jar is the exact failure the table exists to prevent, and it looks like success. Same reason the load path distinguishes *absent file* (fine, no rules) from *malformed file* (reported error, not silently empty).
- **Console hosts are CLAIMED: a miss is an error, not a fallback.** The `containers`/`consoles` sections (`routes.ts`) route shared multi-project hosts (Google Search Console) by which container's domain/alias appears in the *percent-decoded* URL, on token boundaries — `pocketbuddy.org` must not claim `notpocketbuddy.org` or `pocketbuddy.org.evil.com` (`containsToken`). A console URL mentioning no configured string throws (`unmatchedConsoleClaim` consumed in `decideContainer`); do not soften this into a session-default fallback — that jar is the wrong-login accident the section exists to prevent. The sanctioned outs: an explicit `container` argument, or a plain `routes` rule on the console host as its deliberate default (it matches below the console tier, so property URLs still route per-project). And **never add a host to `consoles` whose URLs don't carry a configured domain/alias** (Google Analytics uses numeric property ids) — every URL on it would error until aliases exist.
- **Identity is read from path+query+fragment ONLY — never the host, and never userinfo.** `parseUrlTarget` builds `target.identity` from exactly those three parts, and `containsToken` searches only it. Searching the whole URL was measured to be a silent-misroute bug on two counts: a container owning a console's parent domain (`stripe.com` + console `dashboard.stripe.com`) matched every URL on that console *inside the console's own hostname*, killing the claim and stealing another client's account page into the wrong jar; and `https://victim.org@console.example/` forged an identity through userinfo. **Don't "simplify" this back to scanning the whole href.** For the same reason `domainToken` maps `*.example.com` to the token `.example.com`, not the bare apex — a config line's token must mean exactly what its host rule means, or the console matches URLs the host rule refuses.
- **A console URL's own text decides its container — so don't route untrusted URLs.** Real consoles put the property in the query (`?resource_id=sc-domain:pocketbuddy.org`), so the query must be searched, so anyone who controls the URL string can steer the container by appending `?x=<domain>` or `#<domain>`. This is inherent to substring identity matching and is **not** a bug to fix by narrowing further — narrowing to exclude the fragment buys nothing while breaking hash-routed consoles. The claim protects against *accidents*, not against a hostile URL. Treat a console URL harvested from a page, email, or nav-memory as untrusted: pass `container` explicitly instead.
- **Route beats session scope; explicit beats route.** Precedence is `new_page_in_container` / `open_url({container})` → host rule → `--container` / `set_default_container` → none. That ordering is deliberate: it is what makes a project's URL land in that project's container from *any* `zen-*` entry. Every tab-opening call prints which rule or fallback decided, so a wrong jar is diagnosable from the transcript alone.
- **A new tab reports `about:blank` until its navigation commits.** `pendingUrls` in `server/src/tools.ts` remembers, for ~30s, what this session asked each tab to load, and `effectivePageUrl` uses it while the tab is still blank. Without it, a second `open_url` issued right after the first opens a duplicate — the live probe caught exactly that. Same reason `new_page`/`open_url` report the *requested* URL rather than the extension's `result.url`. Don't drop this for "just read `page.url`".
- **`open_url` reuse is workspace-bound and container-bound.** It only considers tabs in the ACTIVE Zen workspace whose `cookieStoreId` equals the routed container's — a same-host tab in the wrong container is never touched. When nothing matches it opens a new tab and says why. Don't add a cross-container or cross-workspace search: that is the workspace footgun above wearing a different hat.
- **Nav-memory ETL receives untrusted browser telemetry.** Production invocation must retain the empty temporary cwd, `--safe-mode`, `--tools ""`, schema-constrained output, minimal environment, timeout, and no-session-persistence flags. Do not add an agentic Codex fallback.
- **Nav-memory raw data stays structural.** Never add generic text hints, fill/type/select values, find queries, page content, evaluated code, cookie/storage values, or arbitrary error messages to `NavEventRecord`.
- **`fill_secret`'s host binding fails loud, and the value never touches the transcript.** The tool resolves a secret NAME from the login Keychain (service `cx-secret`) inside the server process (`server/src/secrets.ts`) and passes the value straight to the fill RPC; the config `~/.config/zen-mcp/secrets.json` binds each name to the exact hosts it may be filled into. A miss — unbound host, unknown name, malformed config — is an **error that fills nothing**, never a fallback to "fill anyway": the binding is the defense against a prompt-injected session steering a credential into a lookalike form, so don't soften it, don't add subdomain inference, and don't widen exact-host matching. Every outgoing string after the value exists is passed through `scrubSecretValue`, error paths included, because the extension's error text is not trusted to omit it — keep that wrap when touching the handler. Never log the value daemon-side, and never add a variant that returns a secret to the caller. A `TIMEOUT` from the tool usually means a macOS Keychain access dialog is waiting on screen (first use per server binary).
- **`navigate_goal` sends page data off the machine, so its gate fails closed.** The goal, title/path/headings and control labels go to `api.typesafe.ai`. `requireJevHost` (`server/src/jev.ts`) runs before the Keychain is even read: an absent `jev.json` is "not enabled", a malformed one is an error, an unlisted host is refused, and the host is re-checked after every click. Don't add wildcards, subdomain inference, or an allow-all default. **Financial data never goes to TypeSafe** (Chris, 2026-09-16): `FINANCIAL_DOMAINS` blocks those registrable domains even if listed, and listing one fails the whole allowlist. Extend the set; never add an override or a flag to bypass it. Every page-derived string goes through `redactText` in `goal.ts` (`safe`), and off-host links are withheld: the live run on 2026-09-16 sent `Google Account: <name> (<email>)` before that fix. Code owns eligibility and every stop rule; Jev probabilities only ever stop the loop, never widen what may be clicked. Keep `MUTATION_THRESHOLD` low (0.3) — a false stop costs a hand-back, a false click can cost a client. Design and measurements: `docs/jev.md`.
- **Nav-memory excludes dev hosts by design.** `isDevHost` (`shared/src/nav-redact.ts`) drops `localhost`/`*.localhost`/`127.*`/`*.local` at both capture (`deriveLocation`) and validation (`validateEvent`) — the host key has no port, so every localhost project would share one note bucket and cross-contaminate, and dev UIs rot too fast to be worth remembering. Missing notes for a dev server is correct behavior, not a capture bug. Ranking is also kind-weighted (`KIND_WEIGHT`, `ranking.ts`): tool-tip/anti-pattern/iframe-quirk outrank workflow/timing at equal standing, because cadence-shaped notes are the easiest to reinforce and were measured crowding the 8 injection slots (Apollo's two most vacuous notes at `reinforced: 7`). Don't flatten the weights to "simplify" the score.
- **Two mechanisms produce `reinforced`, and neither covers the other.** The distiller sees the host's top-20 notes as a numbered `KNOWN NOTES` list and answers `reinforces: <n>` (positional integers only — ids would be spoofable, and only `1..len` is honored); the hourly `consolidate()` sweep merges same-host pairs at cosine ≥ `MERGE_SIMILARITY` (0.86, `embeddings.ts`). The sweep can't rephrase and the distiller can't see across hosts or sessions — **deleting one because "the other handles it" silently stops a whole class of duplicate from merging**, which is exactly the state this feature was built to fix (46 notes, all stuck at `reinforced: 1`).
- **`sessions/done/` is telemetry, not garbage.** `completeWork` archives consumed work there instead of `rm`-ing it; it's the only durable record of which tools ran against which hosts, already redacted, capped at 300 files / 30 days. Don't "clean it up" back into a delete.
- **Probe scripts that drive live Zen must set `ZEN_MCP_NAV_MEMORY=0`.** Without it, probe traffic (`example.com`, localhost fixtures) is captured and distilled into the real store — that's where the 16 junk notes came from. `probe-navmem.mjs` is the deliberate exception: it tests capture, against a scratch daemon.
- **In-place extension upgrades occasionally no-op silently.** Always confirm the new version in `about:addons` after install. If stuck, remove the existing extension (`⋯ → Remove`) and re-run `open -a "/Applications/Zen.app" <xpi>`; that's reliable for a clean install. The localhost-XPI-server flow (step 7 of the iteration loop) is a deeper fallback if even `open -a` produces nothing.

## Container routing: how to extend the table

The schema won't rot — **placement will**. Once domains land in sections for convenience ("it's one word shorter"), the file stops recording *why* anything is where it is and every later edit is a guess. Keep one meaning per section:

| Section | Means | Membership test |
|---|---|---|
| `containers` | **Identity** — strings that *name* the project | "Would I want a Search Console URL containing this string routed here?" If the question reads as nonsense, it doesn't belong. |
| `consoles` | **Shared hosts where the wrong jar is an incident** | Every URL you'd open there carries some container's identity string. |
| `routes` | **Residence** — lives in a jar, doesn't name a project | `claude.ai` → Geek. Also the deliberate soft default on a console host (matches below the console tier). |

The first row is load-bearing: every `containers` domain is cross-multiplied into console tokens (`compileTable`, `routes.ts`), which is the whole per-project console mechanism. Let that section drift into "domains I associate with Geek" and you grow rules that steer console URLs on accidental substring hits, plus `ambiguousWith` warnings that scale with the mess. Verified: `claude.ai` under `routes` resolves to Geek, and a `search.google.com` URL naming `claude.ai` still throws the claim error — the separation is real, not stylistic.

**Growth is demand-driven.** Add a host on *first misroute*, one line, then prove it with `container_routes({url: "<the real url>", reload: true})` — never batch-add anticipatorily. Unrouted hosts fail *soft* (session default) and every tab-open prints which rule decided, so a misroute is visible in the transcript and costs one line. Speculative rules are the debt: unexercised, and wrong by the time they matter. Same policy but stricter for `consoles`, since one entry converts soft fallbacks into hard errors across an entire host.

**Never add a catch-all** (`"default": "Personal"`, `"*"`). Route beats session scope, so a match-everything rule would override `--container` on every entry and `zen-geek` would stop meaning anything. The per-entry default *is* the catch-all layer, correctly placed below the table.

Scale isn't a concern: rules compile as `domains + routes + (consoles × (domains + aliases))` against `MAX_RULES = 500` — a hand-maintained table stays in the low tens — and matching is a linear scan run once per tab-open. A `_readme` key at the top of the config is ignored by the loader (only the three known keys are read) and holds the short version of this doctrine.

## Where things live

| What | Where |
|---|---|
| RPC types + method names | `shared/src/methods.ts`, `shared/src/protocol.ts` |
| Error codes + `ZenToolError` | `shared/src/errors.ts`, `server/src/errors.ts` |
| Daemon WS routing + auth | `daemon/src/index.ts` |
| Nav-memory store, service, ETL, ranking | `daemon/src/nav-memory/` |
| Nav-memory capture and injection | `server/src/nav-memory.ts` |
| MCP tool registrations | `server/src/tools.ts` |
| Locator-prefix parser (`css:`/`xpath:`/`text:`/`text*:`/`role:`) | `server/src/locator.ts` |
| Container resolver (ported from the archived Marionette fork) | `server/src/container.ts` |
| Host→container route table (load, match, describe) | `server/src/routes.ts` · config `~/.config/zen-mcp/containers.json` |
| Expected signed-in account per host (advisory, printed not enforced) | `server/src/routes.ts` (`asAccount`, `accountForContainer`) · printed by `accountNote` in `server/src/tools.ts` |
| Secret bindings + Keychain resolver for `fill_secret` | `server/src/secrets.ts` · config `~/.config/zen-mcp/secrets.json` |
| Snapshot → one-line-per-control collector (`interactive_elements`) | `server/src/interactive.ts` |
| Jev client + host allowlist | `server/src/jev.ts` · config `~/.config/zen-mcp/jev.json` · key `TYPESAFE_API_KEY` |
| `navigate_goal` loop (injected deps, stop rules, trace) | `server/src/goal.ts` · design `docs/jev.md` |
| Daemon WS client (used by MCP server) | `server/src/daemon-client.ts` |
| Extension RPC handlers (pages.*, dom.*, cookies, storage, etc.) | `extension/src/handlers.ts` |
| Extension WS client + reconnect/heartbeat | `extension/src/connection.ts` |
| Snapshot port (treeWalker, selectors, attrs) | `extension/src/snapshot/` |
| Bundled Readability for `read_page` (~112KB, injected) | `extension/src/readability-bundle.js` |
| Background entrypoint + keepalive | `extension/src/background.ts` |
| Options page | `extension/src/options/` |
| AMO sign wrapper that sources `.env` | `extension/scripts/sign.sh` |

## Things deliberately NOT done

Still gaps as of this writing:

- **Console messages**, **dialog handling** (`accept_dialog` / `dismiss_dialog`), **network capture / full network response bodies**. Content-script bridges with degraded fidelity. Still v2.
- **Privileged-context tools** — fundamental WebExtension capability gap, and now permanently out of scope (see the top of this file). Prefs go through `user.js` / `about:config`; there is no chrome-privileged path.
- **File upload by UID** — browser security blocks it from any extension.
- **Multi-window management** — `tab.windowId` flows through `PageInfo` but there are no window-level tools (focus, move, resize).

Already done (was deferred in the original plan but landed since):

- `read_page` via bundled Readability + Turndown.
- Cookies (`get_cookies` / `set_cookies` / `clear_cookies`).
- Local + session storage (`get_storage` / `set_storage` / `clear_storage`).
- Locator-prefix support (`css:`, `xpath:`, `text:`, `text*:`, `role:`) across `click`, `hover`, `fill`, etc. — the `_by_uid` family still works as the snapshot path; the unprefixed/prefixed variants are the Playwright-style fast path.
- `get_page_text`, `find_by_text`, `wait_for`, `press_key`, `type`, `select_option`, `scroll`.

If you're adding any of these, double-check the README's "Tool surface" table and update both there and here.

## License

MIT OR Apache-2.0 (inherited from the `firefox-devtools-mcp` lineage).
