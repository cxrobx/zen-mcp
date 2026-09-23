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

Every click, hover and key press is built in JavaScript and fired with `dispatchEvent`, so the page sees `isTrusted: false`. Firefox gives WebExtensions no way to produce trusted input. Most sites never check, and in-page buttons, links, forms and app controls work normally. What does not happen is anything the browser reserves for a real user action, or anything that belongs to the browser rather than the page:

| Doesn't happen | Do this instead |
|---|---|
| A click that opens a new tab or window (`target="_blank"`, `window.open`) — the popup blocker stops it, and Firefox's "prevented a pop-up" bar is outside what `screenshot_page` captures | For a `_blank` link, `click` names the URL in its result (`opens in a new tab: <url>`); `open_url` it. A button that builds its URL in script has no workaround |
| Clipboard writes, fullscreen, file pickers, audible autoplay | Not reachable. File uploads: Playwright, where the session isn't needed |
| CSS `:hover` — `hover` fires mouse events but never puts the element in the hover state | Works only on menus that open from JavaScript listeners |
| The browser's own handling of a key: `press_key` doesn't type text, move focus on `Tab`, submit a form on `Enter`, or reach browser shortcuts like `Cmd+L` | `fill`/`type` for text, `click` the submit button, `open_url`/`navigate_page` for navigation |
| Sites that check `isTrusted` and ignore synthetic events (some anti-bot checks, a few components) | Hand the click back to the user |

Where the page cancels part of a click, `click` behaves as a browser does (since extension 0.0.21): a cancelled `pointerdown` suppresses `mousedown`/`mouseup` and leaves focus alone, and a cancelled `mousedown` leaves focus alone. Before that, the forced focus opened and immediately closed menus that cancel the press to keep focus off their trigger (Radix-style).

Real trusted input would need either browser remote control (rejected above) or chrome-privileged code loaded into Zen — out of scope today. So far the limit has come up once (a button in an embedded admin app that opened its page in a new tab), and handing that click to the user covered it.
