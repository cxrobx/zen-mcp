# Tool surface

The full per-tool reference, moved from the README.

Per-tab tools take `tabId` (durable) or `pageIdx` (positional) — see [Addressing tabs](#addressing-tabs-tabid-vs-pageidx) below before using `pageIdx`.

| Bucket | Tools |
|---|---|
| **Containers** | `list_containers`, `container_routes`, `set_default_container`, `new_page_in_container` |
| **Pages** | `open_url`, `list_pages`, `new_page`, `navigate_page`, `select_page`, `close_page`, `navigate_history`, `screenshot_page` |
| **DOM read** | `take_snapshot`, `interactive_elements`, `clear_snapshot`, `resolve_uid_to_selector`, `evaluate_script`, `get_page_text`, `read_page`, `find_by_text`, `wait_for` |
| **DOM actions** | `click_by_uid`, `hover_by_uid`, `fill_by_uid`, `fill_form_by_uid`, `drag_by_uid_to_uid`, `click`, `hover`, `fill`, `fill_secret`, `type`, `drag`, `select_option`, `press_key`, `scroll` |
| **Goal navigation (Jev)** | `navigate_goal` |
| **Cookies/storage** | `get_cookies`, `set_cookies`, `clear_cookies`, `get_storage`, `set_storage`, `clear_storage` |
| **Diagnostics** | `get_firefox_info` |
| **Navigation memory** | `get_domain_playbook`, `nav_memory_stats`, `nav_memory_forget` |

## Addressing tabs: `tabId` vs `pageIdx`

Every per-tab tool accepts **either** `tabId` (durable) or `pageIdx` (positional) — exactly one, never both. Both come from `list_pages`, which prints `tabId=NNN` on each line and a `tabSet=` fingerprint in its header.

**Prefer `tabId`.** `pageIdx` is a position in the currently visible tab list, so it is only valid for as long as that list is unchanged.

> ⚠️ **Zen Workspaces caveat.** Zen builds the tab list from the **active workspace's** strip only, so `browser.tabs.query({})` never enumerates tabs in other workspaces — they are not hidden-but-listed, they are simply not in the list. Switching workspaces mid-session therefore re-points every `pageIdx` at a different tab, and no error is raised: the operation just lands somewhere else.
>
> A `tabId` is different: it is an identity, and Zen's id map is *not* workspace-scoped. Since extension 0.0.18 a tab in another workspace is resolved by id (`pages.get`) and every id-addressed tool reaches it **in place** — reads, DOM actions, screenshots, navigation — without switching your workspace. `list_pages({ includeHidden: true })` enumerates those tabs after the visible set, marked `[-]` (no position). Only a tab that exists in *no* workspace errors (`NOT_FOUND … the tab was closed`). Moving the browser there is still deliberate: `select_page` on such a tab, or `open_url(..., active: true)`, makes Zen switch to its workspace and says so.

Optional guard for `pageIdx` callers: pass `expectTabSet` with the fingerprint from the `list_pages` header. If the visible set changed at all (tab opened, closed, or workspace switched), the call fails with `STALE` **without acting**.

`get_firefox_info` reports `tabs.visible` and `tabs.fingerprint` for the active workspace. It reports no workspace id because **Zen exposes none to WebExtensions** — the fingerprint is the only available signal, and while it always changes on a workspace switch, it also changes on any ordinary tab open/close. The same gap is why hidden tabs are flagged "other workspace" rather than named: the workspace a tab belongs to is a Zen-internal tab attribute the API never surfaces.

## fill_secret: Keychain secrets without transcript exposure

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

## interactive_elements and navigate_goal

`interactive_elements` lists a tab's controls one per line (UID, kind, label, link destination, row and region) from a fresh snapshot, so the UIDs work with `click_by_uid`. It is roughly 6× smaller than `take_snapshot` (measured on Search Console: 2,909 vs 18,764 characters). Row context tells same-label controls apart, and field values are never shown.

`wait_for({ condition: "stable" })` waits until the page's interactive-control count holds for `stableMs` (default 500). Use it after a click on an asynchronously rendering page when you don't know which text will appear.

`navigate_goal` reaches a **read-only** destination ("open the Sitemaps report") with TypeSafe's Jev model choosing each click, so the calling model isn't consulted per step. It only clicks links, buttons, tabs and menu items; it withholds fields, toggles, off-host links and action-word labels; it asks Jev whether the chosen control could change anything before clicking; and it stops on a sign-in page, low confidence, `none`, a repeated click, the page moving between observation and click, leaving the host, or `maxSteps`. It returns a per-step trace that says where every millisecond went (Jev, waiting on the page, and why). Pass `expect` (text that must appear in the final URL or visible text) to have **code** verify the finish; without it the result is marked `DONE (unverified)`, because Jev's "done" is a judgment, not evidence. After a navigating click it waits for the page's **title to change** before a short hold, not for a quiet window: on an SPA the URL flips at once and the content swaps a second or two later, and a quiet window measured "stable" on the old view.

It sends the goal, page title/path/headings, up to 2,000 characters of visible text, and control labels (all redacted for emails, tokens and ids) to `api.typesafe.ai`, so it runs **only on hosts listed** in `$XDG_CONFIG_HOME/zen-mcp/jev.json` (fallback `~/.config/...`, override `ZEN_MCP_JEV_CONFIG`):

```json
{ "hosts": ["search.google.com"] }
```

Exact hosts only. An absent file means "not enabled", a malformed one is an error, and an unlisted host sends nothing and never reads the key. **Financial sites are refused in code** (Stripe, Mercury, Plaid, PocketBuddy, Oracle Fusion, SAM.gov, banks and payment rails; see `FINANCIAL_DOMAINS` in `server/src/jev.ts`), and listing one makes the whole file an error. The key is `TYPESAFE_API_KEY` in the login Keychain (`sk TYPESAFE_API_KEY`). Design, thresholds and measurements: [`docs/jev.md`](jev.md).

Tools the Marionette-based predecessor had that have **no WebExtension equivalent**, and so are absent here by design: `list_privileged_contexts` / `select_privileged_context` / `evaluate_privileged_script`, `set_firefox_prefs` / `get_firefox_prefs`, `restart_firefox`, `upload_file_by_uid`, `install_extension` / `list_extensions` / `uninstall_extension`.

Deferred to v2 (need degraded-fidelity content-script bridges): `list_console_messages`, `clear_console_messages`, `list_network_requests`, `get_network_request`, `accept_dialog`, `dismiss_dialog`, `screenshot_by_uid`, full-page screenshot.

Fidelity gaps to know:
- `screenshot_page` captures the target tab's visible viewport in place via `tabs.captureTab(tabId)` — it does **not** activate the tab or change window focus. It defaults to JPEG quality 80; pass `format: "png"` for lossless output.
- `evaluate_script` requires JSON-serializable results (the `scripting.executeScript` constraint). Returning DOM nodes or non-serializable objects fails. The function body is transpiled and interpreted without `eval()`/`Function()`, so page CSP does not block it.
- Large textual responses from `take_snapshot`, `evaluate_script`, `get_page_text`, `read_page`, `get_cookies`, and `get_storage` honor `maxBytes` + `cursor`; `interactive_elements` honors `maxBytes`.
- Locator actions (`click`, `hover`, `fill`, `type`, `drag`, `select_option`, `press_key`) auto-wait for matches with `timeoutMs` and scroll targets into view before acting.

Focus behavior: automation is non-disruptive by default. `new_page` / `new_page_in_container` open tabs in the **background** (pass `active: true` to foreground), `navigate_page` and the DOM tools act on a tab by id without activating it, and `screenshot_page` captures without focus. The only tools that surface a tab to the foreground are `select_page` and an explicit `active: true` on `new_page` / `open_url` — and when the tab lives in another Zen workspace, those are also the only tools that make Zen switch workspaces. This means an agent can drive one container while you browse in another without your focus being stolen.

**Spaces.** A tab opened in a container is filed into the Zen space bound to that container, in the background, so it never lands in the space you happen to be in and your view doesn't move. Zen's Space Routing rules can't see a tab's container, so zen-mcp opens each container tab at a marker (`about:blank#zen-space=<container id>;`) that one rule per container sends to the right space, then loads the real URL. Install the rules with `npm run spaces:markers -- --write` and restart Zen once (it reads them at startup); `npm run check:spaces` verifies them and `scripts/probe-space-marker.mjs` proves it live. Your own browsing is untouched, since nothing you do produces a marker. Keep `zen.workspaces.force-container-workspace` off: it also files tabs by container, but switches your view to every tab it files.
