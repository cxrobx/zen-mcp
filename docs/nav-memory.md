# Nav memory

Status: implemented (M0–M4).

Nav memory preserves low-sensitivity navigation knowledge learned while the Zen tools operate real websites. It is intentionally advisory: every injected block tells the model to verify observations against the live page.

## Architecture

- The per-session MCP server derives destination hosts, captures allowlisted structural events, streams them to the daemon, and injects at most 1.5 KiB of summaries when a page with a verified outcome is reached. Shown note ids are excluded from later queries, so general hints do not crowd out new page-specific knowledge. Page-identity queries are cached for five minutes (up to 256 paths); the shown-id set is capped at 500. Failed queries remain retryable.
- The persistent daemon owns the atomic JSON store, exact/related-host ranking, per-page raw work files, Claude distillation, optional Ollama embeddings, deduplication, decay, stats, and deletion.
- The extension and protocol version are unchanged. `navMemory.*` requests use the existing authenticated request/response transport and never reach the extension.

State lives under `~/.config/zen-mcp/nav-memory/` by default. Directories use mode `0700`; notes and raw work use `0600`. Pending, failed, and consumed (`sessions/done/`) telemetry expires after 30 days and is also count-capped (200 / 50 / 300 files).

## Session durability

A session's events live in daemon memory until something flushes them to a work file. Three things do:

- **Disconnect** — the MCP process closing finalizes one work file per host and keyed page identity.
- **Idle checkpoint** — a session with events but no activity for 10 minutes is finalized on the next tick. The connection stays open; the next event simply starts a fresh session. This bounds loss from an abrupt daemon death (`kill -9` skips the shutdown path) to roughly ten minutes, and it means an all-day Claude session keeps flushing instead of holding everything hostage until it exits.
- **High-water checkpoint** — a session reaching 400 events is finalized immediately, rather than shift-dropping its oldest events at the 500 cap. Fragmenting one session across several work files is harmless because re-learned facts reinforce rather than duplicate.

## Privacy and injection controls

Capture is a structural allowlist. It includes normalized URL paths, keyed page fingerprints, sanitized locators, tool success, navigation state, match counts, snapshot counts, key combinations, and stable error codes. It excludes form values, option values, cookie/storage data, page text, find queries, script source/results, screenshots, titles, active-element names, and arbitrary errors.

The daemon repeats validation and redaction. Query strings and fragments are discarded, identifier-shaped path segments are globbed, private public-suffix tenants remain isolated, and automatic hints require both matching path scope and an outcome proof for the same keyed page identity. The identity is HMAC-SHA256 over origin and decoded pathname segments using the existing authentication token; queries and fragments are excluded. This distinguishes long routes that both redact to `/*` without saving their raw names. Key rotation safely makes previous proofs ineligible. Readable paths remain redacted; fingerprints stay local and are omitted from distiller input.

Learned telemetry is passed only to a tool-disabled Claude print process in safe mode, with schema-constrained output, no session persistence, a minimal environment, an empty temporary working directory, and a hard timeout. There is no Codex fallback. Learned notes use declarative language, confidence no higher than 0.7, and further validation before storage. New selector notes must name an exact locator and tool observed in that page's telemetry. Their summary is generated from that observation rather than the model's guessed control purpose. Locators are never cut into incomplete selectors. All new facts begin as candidates.

This is privacy minimization rather than a mathematical guarantee against all possible PII. Retention, filesystem permissions, planted-secret probes, and `nav_memory_forget` provide defense and recovery.

## Retrieval and lifecycle

Explicit playbook queries rank exact-host notes ahead of related hosts determined by a private-suffix-aware PSL. Automatic queries require the exact host and keyed page identity plus a confirmed state proof; unchecked, suspect and obsolete notes cannot inject, regardless of confidence or reinforcement. Ranking combines confidence, capped reinforcement, recency, and matching path scope. Ollama semantic ranking is used only for explicit playbook queries and has a short fallback timeout; automatic injection never waits on Ollama.

An empty first visit does not suppress hints on later paths. Automatic hints include note ids for feedback. Concurrent reads share a query and each shown note is emitted once while its id remains in the bounded session set. Feedback invalidates the host's path cache and prevents an older in-flight response from injecting stale advice.

Six Google Cloud Console seed notes bootstrap the inspectable playbook. Seeds and existing notes are preserved as candidates until a relevant live outcome is verified; seeding and heuristic reinforcement do not bypass the gate. Forgetting a seed records a tombstone so it is not restored on restart. Learned notes decay after 60 unseen days; weak, unreinforced notes older than 180 days are removed. Seeds retain a 0.5 confidence floor.

## Verified outcome feedback

`nav_memory_feedback` accepts a note id, a target tab, an outcome (`confirmed`, `contradicted`, or `obsolete`), and one live assertion: selector presence, path match, or a selector state (`visible`, `enabled`, `checked`, `count`, `value`). Presence and path checks can record a verdict or retire advice, but only a confirmed state assertion promotes a candidate for automatic hints on the verified page. The server checks the live page in place and rejects a loading page, failed assertion, or development host. The daemon verifies exact host, path scope and any stored page fingerprint before saving. No page text, form values, arbitrary reasons, or script source enter the evidence record.

The caller must choose an assertion that demonstrates the note's outcome. For a fill/select action, compare the resulting field value with `state: "value"`; only the boolean comparison is returned and persisted, and a disabled or missing control cannot pass. For a toggle, check `checked` or `enabled`; for generated elements, check `count`. Code verifies that assertion; it does not establish the causal meaning of arbitrary advice. A successful click or fill RPC alone is not confirmation. For example, confirming a workflow requires checking its destination or resulting control; retiring a selector requires checking that it is absent on the settled page where it was expected.

```js
nav_memory_feedback({
  tabId: 101,
  id: "<note id from an injected hint or get_domain_playbook>",
  outcome: "obsolete",
  check: { selector: "#retired-control", present: false }
})
```

Feedback has its own evidence counters, separate from heuristic ETL reinforcement. Within the last 64 retained feedback sessions for a note, repeated reports from one MCP connection count once; a corrected verdict replaces that connection's vote. Changed evidence can upgrade a presence-only report to a state proof without adding a vote. Each record retains a hashed connection id, timestamp, outcome and sanitized assertion. History and counters survive restarts. A reconnect starts a new connection, so these counts are not a measure of independent human reviewers.

Contradicted advice becomes `suspect` and receives one-quarter of its previous ranking multiplier, plus a reliability penalty from its negative-outcome counts. Suspect notes remain inspectable but do not automatically inject. Obsolete advice stops automatic injection, including seeded advice, but remains in explicit playbooks for inspection. A confirmation makes it active again; automatic eligibility additionally requires a state proof for the queried page; the earlier negative evidence continues to affect ranking. Distillation cannot clear feedback status, and semantic consolidation preserves notes with feedback under their original ids.

## Consolidation

Reinforcement is what makes the store learn rather than merely accumulate: `reinforced` feeds the ranking multiplier, so a repeatedly-observed fact outranks a one-off. Two mechanisms produce it, and they cover different gaps.

**At distill time.** Each ETL run shows the distiller the page's top 20 existing notes, including their scope, success polarity and feedback status, as a numbered `KNOWN NOTES` list. When an observation confirms one, the model answers with `"reinforces": <number>` instead of restating the fact in new words. References are positional integers, never note ids, and only `1..list.length` is honored. Every merge route additionally requires the same exact host, kind, path glob (including unscoped versus scoped), success polarity, keyed page identity and observed locator/tool. An incompatible reference falls through to a distinct note. Newly learned ids include scope and polarity; existing ids and seed tombstones remain valid. Several paraphrases from one work file reinforce a target only once. Note validation and privacy controls still run before merge decisions.

**Hourly sweep.** The distiller only ever sees one host during one session, so near-duplicates that arrived by other routes still pile up. Once an hour the daemon compares compatible pairs within each host and merges at or above `MERGE_SIMILARITY` (0.86). Notes with verified feedback retain their ids and evidence instead of being consolidated. The higher-confidence note is kept as the target, `reinforced` counts are summed, `tools` are unioned, the earliest `createdAt` and latest `lastSeenAt` survive, and the target keeps its embedding. A seed may be a merge target but never a deleted source, and two seeds are never collapsed into each other. Every merge logs the host, kept id, dropped id, and score. Scope and polarity checks reduce false merges; cosine similarity still is not proof of semantic equivalence.

The two mechanisms are complementary, not redundant: the sweep cannot rephrase, and the distiller cannot see across hosts or sessions. Removing either one stops a distinct class of duplicate from ever merging.

## Operations

- `get_domain_playbook`: full advisory notes with ids and feedback status, including obsolete notes for inspection.
- `nav_memory_feedback`: record a live-verified outcome against a note.
- `nav_memory_stats`: store, queue, retention, and embedding status, an `etl` block, `eligibility` candidate/verified counts, and `feedback` counters for confirmed/contradicted/obsolete verdicts and suspect/obsolete notes. Reinforcement counts indicate consolidation; outcome counters indicate checked results. Neither alone proves improved task success.
- `nav_memory_forget`: delete a note or exact host, including raw work by default.

Consumed work files are archived to `sessions/done/` instead of being deleted. They are already redacted, and they are the only durable record of which tools ran against which hosts — a usage history that survives daemon restarts, capped at 300 files and 30 days. `nav_memory_forget` with a host purges matching archived files too.
- `ZEN_MCP_NAV_MEMORY=0`: disable capture and automatic injection in one MCP server.
- `--nav-db` / `ZEN_MCP_NAV_DB`: override state location.
- `--claude-bin` / `ZEN_MCP_CLAUDE_BIN`: override the distiller executable.

Export by copying `notes.json`. Import only while the daemon is stopped, restore mode `0600`, then restart so startup validation and seed application run.

## Verification

```sh
npm run build && npm run typecheck
npm run test:nav-memory
node scripts/probe-navmem.mjs
node scripts/smoke.mjs
npm run eval:nav-memory
```

The nav-memory probe uses a scratch store, fake tool-free Claude process, fake Ollama endpoint, and planted secrets. It does not require a live browser or subscription request.

The deterministic evaluation compares memory enabled/disabled on a page-scoped form fixture, counts tool calls and failed actions, then changes the selector and checks stale-advice suppression and replacement knowledge. It demonstrates fixture behavior, not a real-world success rate. Run `ZEN_MCP_NAV_MEMORY=0 node scripts/probe-navmem-live.mjs` for real server handlers and real Zen against scratch memory. It opens and closes its own background example.com tab; production navigation memory is untouched.

`npm run eval:browser` runs a broader AI-driven benchmark against eight public demo tasks in real Zen: dropdowns, checkboxes, adding/removing controls, numeric input, delayed enablement, delayed rendering, table reading, and nested frames. It first executes successful scripted warmups and distills their structural telemetry with the real Claude distiller. Fresh, tool-disabled Claude decisions then drive current server handlers with memory enabled and disabled, alternating order over two repetitions. Independent DOM predicates or answer checks score completion; the model never sees the oracle. JavaScript proposals are limited to property reads and a small set of read methods. Each run is capped at 12 tool calls and eight decisions. Setup and oracle calls are excluded from the tool-call metric.

The benchmark needs a connected Zen extension and an authenticated `claude` CLI, makes model requests, opens only its own background tabs, and uses scratch memory with embeddings disabled. It measures task behavior with learned hints, not the causal effect of each individual code change or production performance. Default model: `haiku`. Configure `ZEN_BENCH_MODEL`, `ZEN_BENCH_REPETITIONS` (1–5), `ZEN_BENCH_CASES` (comma-separated task IDs), `ZEN_BENCH_CONTAINER`, and `ZEN_BENCH_OUTPUT` as needed. Reports include public-page traces and model usage, defaulting to the system temporary directory; no production notes or private pages are read into the model.

See [the audited browser benchmark](browser-task-benchmark-results.md) for the initial results and limitations. It did not demonstrate an overall reliability benefit from memory.

## Frozen browser evaluation

`npm run eval:browser` uses eight public demo tasks through the live Zen extension, with production capture disabled and a scratch memory service. Scripted warmups are independently checked before supported selector notes receive state/value proofs. The full bank is then frozen, hashed, and copied unchanged into every memory-off/on pair. No notes are learned or promoted during scored trials. The oracle checks the requested result, including three adds followed by one removal and the named table row; it is never shown to the model.

To reuse exactly the same bank, set `ZEN_BENCH_BANK=/private/tmp/your-bank.json`. `ZEN_BENCH_TRAIN_ONLY=1` creates a bank without scored trials; `ZEN_BENCH_BANK_OUTPUT` chooses its destination. Reports default to temporary files with mode 0600. Tool schemas are derived from the real Zod schemas. Each run has a fresh model context, its own background tab, at most 12 tool calls, and alternating condition order. Run `node scripts/audit-browser-benchmark.mjs <report> <audit>` to exclude whole matched pairs affected by runner failures. Read the audited report before drawing performance conclusions; a small demo benchmark cannot establish broad reliability.
