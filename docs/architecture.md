# Architecture

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

## Multi-entry pattern

Three Claude Code MCP entries (e.g. `zen-cxv`, `zen-personal`, `zen-buildersbuddy`) each spawn a fresh **MCP server process**. All three connect to the same **daemon** (single TCP port). The daemon routes each request to the single **extension** and routes the response back to the originating client. Order-preserving with a per-request id; no cross-talk.

Two MCP entries calling `new_page` simultaneously each open their own tab in their own container — the daemon doesn't serialize them.

## Auth + heartbeat

- **Token**: shared secret, 32 bytes random hex, stored at `~/.config/zen-mcp/auth.token` (0600). First message on every connection must be a `hello` with the token within 5s. Constant-time compared via `crypto.timingSafeEqual`.
- **Heartbeat**: daemon sends WebSocket pings every 30s. If no pong, the connection is terminated and (for clients) eligible for replacement.
- **Reconnect**: clients (server + extension) reconnect with exponential backoff capped at 10s. Resets to 0 on `welcome`.

## What the daemon owns

The daemon binds the WebSocket port. Exactly **one** extension connection at a time (a new hello with role=extension replaces the old one and fails its in-flight requests). Many clients. Extension-bound requests are routed by request id; a per-id timer fails the call after 30s.

## Navigation memory

Overview below; the full design (capture allowlist, redaction, distillation, consolidation, retention, operations) is in [nav-memory.md](nav-memory.md).

The server records only bounded structural facts such as normalized URL shapes, sanitized locators, tool success, navigation, match counts, and stable error codes. It never records entered form values, cookie/storage values, page bodies, evaluated code, find queries, screenshots, or arbitrary error text. Events stream to the daemon during the session; disconnect atomically finalizes one pending work file per host.

The daemon stores notes in an atomic, versioned JSON document and ranks exact-host observations before public-suffix-aware related hosts. Path-scoped notes are injected only on matching paths. Injection is summary-only, capped at 1.5 KiB, framed as advisory data, and occurs once per host per MCP process. `get_domain_playbook` returns the complete reviewed context on demand.

Pending telemetry is distilled in an empty temporary directory by `claude -p --safe-mode --tools "" --no-session-persistence` with schema-constrained output. There is no agentic fallback. Ollama is optional: when unavailable, deterministic ranking and normalized-text deduplication remain active, and missing embeddings are backfilled later.

Notes consolidate instead of accumulating. Each distill run is shown the host's existing notes as a numbered list and answers with `reinforces: <number>` when an observation confirms one, so the note's `reinforced` count grows and it outranks one-offs. An hourly sweep is the safety net for duplicates that arrive by other routes: within each host it merges pairs whose embeddings are at least 0.86 similar, summing `reinforced`, keeping the higher-confidence note, and logging every merge. Seeds can be merge targets but are never deleted.

Sessions are checkpointed to disk when they go idle for 10 minutes or reach 400 events, so an abrupt daemon kill loses at most a few minutes of telemetry and long-running sessions flush continuously.

State directories are mode `0700` and files are `0600`. Pending work is capped at 200 files, failed at 50, and consumed work — archived to `sessions/done/` rather than deleted, as a durable redacted usage history — at 300; all expire after 30 days. `nav_memory_forget` deletes a note or an exact host, including its raw work by default. Forgetting a trusted seed creates a durable tombstone. Export is a copy of `notes.json`; for import, stop the daemon, replace that file with mode `0600`, and restart.

`nav_memory_stats` answers "is it learning?" in one call: the `etl` block reports `created` vs `merged` note mutations, `consolidated` sweep merges, and the `lastEtlAt` / `lastConsolidateAt` timestamps.

## Snapshot caching

`take_snapshot` injects `extension/dist/snapshot/inject.js` via `scripting.executeScript({ files, world: 'MAIN' })`, then calls `window.__zenExtMcpCreateSnapshot`. The returned `uidMap` is cached in the background script keyed by tabId and persisted in `browser.storage.session`, so UIDs survive routine MV3 background suspension. Subsequent `click_by_uid`/`fill_by_uid`/etc. resolve uid -> selector via the cache, then run an inline action `func` against `document.querySelector(selector)`. Traversal is bounded at 100 DOM levels and 5,000 captured nodes so deeply nested framework panels remain reachable without allowing unbounded snapshots.

The cache is dropped on full navigation, SPA history updates, hash changes, and `tabs.onRemoved`. Take a fresh snapshot after any meaningful route change.
