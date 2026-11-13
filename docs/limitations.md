# Limits: what zen-mcp can't do

Moved from the README. The design premise and the short version are in the [README](../README.md#why).

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

### Input is synthetic, and pages can tell

Every click, hover and key press is built in JavaScript and fired with `dispatchEvent`, so the page sees `isTrusted: false`. Firefox gives WebExtensions no way to produce trusted input, so the one exception is an opt-in that goes around the browser entirely ([Trusted input](#trusted-input-opt-in), below). Most sites never check, and in-page buttons, links, forms and app controls work normally. What does not happen is anything the browser reserves for a real user action, or anything that belongs to the browser rather than the page:

| Doesn't happen | Do this instead |
|---|---|
| A click that opens a new tab or window (`target="_blank"`, `window.open`) — the popup blocker stops it, and Firefox's "prevented a pop-up" bar is outside what `screenshot_page` captures | For a `_blank` link, `click` names the URL in its result (`opens in a new tab: <url>`); `open_url` it. A button that builds its URL in script: `click` with `trusted: true` |
| Clipboard writes, fullscreen, file pickers, audible autoplay | Not reachable. File uploads: Playwright, where the session isn't needed |
| CSS `:hover` — `hover` fires mouse events but never puts the element in the hover state | Works only on menus that open from JavaScript listeners |
| The browser's own handling of a key: `press_key` doesn't type text, move focus on `Tab`, submit a form on `Enter`, or reach browser shortcuts like `Cmd+L` | `fill`/`type` for text, `click` the submit button, `open_url`/`navigate_page` for navigation, or `press_key` with `trusted: true` |
| Sites that check `isTrusted` and ignore synthetic events (Google's Material dropdowns, some option menus, some anti-bot checks) | `click` / `click_by_uid` with `trusted: true`; `select_option` with `trusted: true` for a custom listbox |

Where the page cancels part of a click, `click` behaves as a browser does (since extension 0.0.21): a cancelled `pointerdown` suppresses `mousedown`/`mouseup` and leaves focus alone, and a cancelled `mousedown` leaves focus alone. Before that, the forced focus opened and immediately closed menus that cancel the press to keep focus off their trigger (Radix-style).

### Trusted input (opt-in)

`click`, `click_by_uid`, `select_option` and `press_key` take `trusted: true`. Instead of dispatching events, zen-mcp posts **one real macOS mouse click** at the element's position on screen, through a small native helper (`native/zen-mcp-input`, `CGEventPost`). The page sees `isTrusted: true` and the browser counts it as a user action, so Material dropdowns open and `window.open` popups are allowed. It is not a browser remote-control channel: nothing new listens on a port, and the helper does exactly two things, a left click and one key press (or combo).

A trusted click names any tab or popup window it opened (`opened: tabId=…`), so a popup can be read or closed by id. A trusted `press_key` with a `selector` clicks that element first, the way a person focuses it; without one the key goes to whatever has focus in the tab. Because the key is real, the browser's own handling runs too: `Tab` moves focus, `Enter` submits. `Cmd+Q` and `Cmd+Opt+Esc` are refused.

What it costs, and why it is never the default:

- **It brings the tab and its window to the front** and moves the real cursor for a moment. The cursor goes back where it was, and focus goes back to the app that had it. Every other tool stays in the background.
- **It needs macOS Accessibility** for the helper. Build it with `native/build.sh`; the first trusted click makes macOS ask. The helper disclaims responsibility when it starts, so the grant covers that one binary, not node or your terminal. `native/build.sh` signs it with a Developer ID when the keychain has one (override with `ZEN_MCP_SIGN_IDENTITY`), so the grant survives rebuilds; signed ad-hoc, every rebuild makes macOS ask again.
- **The tab must actually be visible.** The point comes from `mozInnerScreenX/Y` plus the element's visible centre, scaled by `devicePixelRatio` and the screen's backing scale.

It refuses, clicking nothing, when:

- **the screen is locked.** A locked Mac keeps the lock screen in front of every app, so Zen cannot be brought forward and no real event can reach it. The helper reads the session's lock state (`zen-mcp-input front` reports `locked`) and the tool refuses with that reason up front. Synthetic input still works while locked; for a control that needs a real click, unlock the Mac or run the step on another unlocked Mac's Zen. Before this check existed, a locked screen surfaced as "the browser window is not focused", which reads like a focus bug and is not one.
- the element matches but nothing visible (0px or scrolled out). The first visible match is used, since Material keeps 0px copies of its options.
- something else is painted at the point (`elementFromPoint`, through open shadow roots).
- the element moved more than 2px between the prepare read and the final check.
- the tab is not active, or its window is not focused.
- the frontmost app is not Zen, or the topmost window under the point is not Zen's (a notification or another app's window over it).

Trusted `select_option` makes two trusted clicks: one on the selector to open the list, then one on the visible `role=option` whose text equals `value` (`by: "label"`) or whose `data-value` equals it (`by: "value"`).

`scripts/probe-trusted.mjs` checks this against live Zen with a fixture whose controls act only on trusted events.
