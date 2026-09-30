# Nav-memory quirk eval

Does automatic note injection change what an agent gets done, and in which direction: when the notes are right, when the page has changed since they were learned, and as the real pipeline writes them?

**Status: protocol fixed and committed before any memory arm ran. Results are added below it when the run finishes.**

## Protocol

### Pages

A local fixture site (`scripts/quirk-fixture.mjs`), served on a LAN address because nav-memory ignores localhost by design. Eight pages carry one learnable fact each, of a class the production note store already records on real sites. Two control pages carry nothing to learn. Every quirk page has a changed version at the same path, where the learned fact is false.

| Page | Class | Original page | Changed page |
| --- | --- | --- | --- |
| nickname | timing | The field unlocks about 3.5 s after a click; a fill before that is discarded. | No lock, and the field has a new id. |
| promo | iframe-quirk | The field and button sit in a cross-origin iframe, out of reach of locator tools. | Both are in the top document under new ids. |
| invoice | anti-pattern | The "View" link opens a new tab, which a synthetic click cannot do. | The link opens in place at a new address; the old address is a "moved" page. |
| assign | tool-tip | Typing a name does not assign; an option in the list has to be clicked. | A plain `<select>`. |
| settings | selector | Two "Save" buttons; the first one in the page saves something else. | The order is swapped and the ids are renamed. |
| workspace | workflow | "Create" is ignored until a checkbox in a collapsed section is ticked. | No checkbox; "Create" works. |
| order | url-pattern | The list pages five rows at a time; each order also has a direct address. | Same list; the direct address has moved and the old one is a "moved" page. |
| waitlist | workflow | "Continue" is not the last step; a "Confirm" button appears about a second later. | One step. |
| city, rates | control | A plain form and a plain table. | Not run. |

The task sentence is the same on both versions of a page.

### Arms

| Arm | Page | Notes shown |
| --- | --- | --- |
| off | original | None. |
| shipped | original | What the gate lets through today: the real distiller's accepted-locator notes from one scripted first visit, each promoted through the real `nav_memory_feedback` tool with a live state check. |
| ungated | original | Everything the real distiller wrote on that first visit. This is how the store behaved before the gate. |
| ideal | original | One hand-written note per page stating the quirk, within the 140-byte summary cap. The ceiling. |
| off-changed | changed | None. |
| stale-ungated | changed | The ungated notes, learned on the original page. |
| stale-ideal | changed | The ideal notes, written for the original page. |

Ungated and ideal notes would not pass the gate, so the harness marks them verified in the scratch bank only. No live proof backs that mark. Notes reach the planner through the real injection path in the server, not through the prompt.

The first visit is scripted to look like one: the naive attempt, then the recovery. The three banks were frozen before any scored run. Hash: `64f9e90a661593526e6857655a3a1cc6e4269d4f54d6924962526da8c25cc13e`.

### Runner

`scripts/nav-memory-quirk-eval.mjs`. Claude Haiku 4.5 plans, the current server tool handlers act in live Zen, and nav-memory calls go to a scratch store per run. Each run gets a fresh tab and a fresh planner context, at most 12 tool calls in at most 8 planning rounds, then one report-only round if its last calls were still unread. The oracle reads the page's own application state 1.2 s after the last action and is never shown to the planner; for a read task it is a pattern match on the answer. Arm order rotates by page and repetition. A planner CLI failure is retried in a fresh session up to three times and counted.

Six repetitions: 64 runs each (ten pages on the four original-page arms, eight on the three changed-page arms), 384 in all, in four parallel shards with every arm of a page in the same shard.

### Scoring

Primary: completion on the eight quirk pages, as a difference against no memory taken within each page and then averaged across pages. Intervals are stratified bootstrap, p-values stratified permutation, both seeded (`scripts/nav-memory-quirk-report.mjs`). Secondary: tool calls per run, errored calls, runs that claimed completion without it, and the same contrasts on the control pages, where any loss is pure overhead.

### The rule, fixed before the run

- Ideal beats off by under 15 points: injection has no ceiling for this planner. Drop automatic injection and keep `get_domain_playbook`.
- Ideal helps but shipped and ungated do not: the distiller and the gate are the bottleneck, not the idea.
- Stale notes lose more against off-changed than fresh notes gain against off: net negative wherever pages change.

At 48 runs per arm on quirk pages this detects differences of roughly 25 points. Smaller effects will show as wide intervals, not verdicts.

## Pilot and calibration

Done with the no-memory arms only, before any memory arm ran and before the banks were trained.

| Page | off, first pilot | Change | off, after |
| --- | ---: | --- | ---: |
| nickname | 2/4 | None. | |
| promo | 4/4 | None. | |
| invoice | 3/4 | None. | 2/2 |
| assign | 4/4 | None. | |
| settings | 4/4 | None. | |
| workspace | 0/4 | The error message now names the Advanced section. | 1/4 |
| order | 0/4 | The target order is two "Load more" clicks in, not four. | 2/4 |
| waitlist | 1/4 | None. | |

Two departures from what was planned, both made on this data alone:

- The plan was to drop any page at 0% or 100%. That would have left three pages on four runs of evidence each. The two floor pages were eased once instead and the three ceiling pages were kept. Because a ceiling page cannot show a completion gain, the main contrast is also reported on the five pages with headroom: nickname, invoice, workspace, order, waitlist.
- The pilot exposed a harness fault: a run stopped by the call budget never got to read its last results, so a read task could not report an answer it had already fetched. The report-only round fixes that in every arm. The "after" numbers for invoice and order include it.

## What the pipeline wrote

From one scripted first visit per page, the real distiller wrote 21 notes; 12 passed the shipped gate.

| Page | Shipped | Ungated adds |
| --- | --- | --- |
| nickname | `click accepted locator #unlock.` · `fill accepted locator #nickname.` | "requires clicking `#unlock` before filling `#nickname`" · "Text-based wait condition is observed" |
| promo | none | `fill failed for locator #promo.` |
| invoice | none | `click accepted locator #view-march.` |
| assign | `fill accepted locator #assignee.` · `wait_for accepted locator #people li.` | "Filling #assignee triggers visibility of #people li" |
| settings | `click accepted locator #profile-save.` · `click accepted locator text:Save.` · `fill accepted locator #display-name.` | none |
| workspace | none | "staged form with advanced options toggle" |
| order | `click accepted locator #more.` | "Pagination requires row-count assertions between clicks" |
| waitlist | `fill accepted locator #team.` · `wait_for accepted locator #confirm-join.` | "multi-step progression with dynamic element appearance" |
| city | `click accepted locator #news.` · `fill accepted locator #city.` | "Path /city is navigable" |
| rates | none | none |

Two of these are worth reading before the results. On settings, `click accepted locator text:Save.` is the click that hit the wrong button on the first visit; it passed the gate because the gate proves a state on the page, not that the note caused it. On invoice, `click accepted locator #view-march.` records a click the popup blocker stopped.

So the shipped arm shows a note on five of the eight quirk pages, and on three it is the same as no memory.

## Reproduce

```sh
# 1. the fixture, on a LAN address
QUIRK_CONTROL_TOKEN=<any string> node scripts/quirk-fixture.mjs --host <lan-ip>

# 2. freeze the banks, then run a shard (repeat with other QUIRK_TASKS)
export QUIRK_ORIGIN=http://<lan-ip>:18931 QUIRK_CONTROL_TOKEN=<same string> QUIRK_BANK=<dir>/bank.json
node scripts/nav-memory-quirk-eval.mjs train
QUIRK_TASKS=order,settings QUIRK_REPS=6 QUIRK_OUT=<dir>/shard-1.json node scripts/nav-memory-quirk-eval.mjs run

# 3. score
node scripts/nav-memory-quirk-report.mjs --bank <dir>/bank.json <dir>/shard-*.json
```

Needs the Zen extension connected and an authenticated Claude CLI. A run is resumable: rerun the same command and it skips what the report already holds. Never drive the fixture with a session's own zen tools, or that session's nav-memory will capture the fixture host into the production store.

Raw reports, the frozen bank and the pilot files for this run are in `~/.local/state/zen-mcp/evals/quirk-2026-09-30/`, outside the repository.
