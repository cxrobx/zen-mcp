# Jev in zen-mcp

Status: implemented 2026-09-16 (`interactive_elements`, `wait_for` `stable`, `navigate_goal`); loop reworked 2026-09-18 after comparing it with browser-use's `jev-ultrafast` (§ *The loop, reworked*). In use since 2026-09-18 under a written tripwire at the bottom (§ *In use, with a tripwire*).

**Before proposing a second integration, read § *Where else — the survey and the verdict* and § *Jev vs a trained classifier*. The answer as of 2026-09-17 is no, and the three tripwires that would change it are listed there. Don't re-derive it.**

This is also the reference for adding TypeSafe's Jev to other projects. The zen-mcp specifics are examples of rules that travel.

## What Jev is

TypeSafe's System One model. You send **state** (text or JSON) and named **questions**, and each comes back as a typed answer with probabilities:

| Primitive | Returns | Use it for |
|---|---|---|
| `noul` | probability of yes | a condition: "is this a sign-in page?" |
| `choice` | the top option + a probability per option + `confidence` | one of a set: "which control next?" (max **255** options) |
| `score` | a probability-weighted level on an ordered rubric | a degree: "how urgent?" |

It does not generate text or explain itself. Measured here: 130–400 ms per request, roughly 2–3k input tokens for a 40-option choice.

## The division of labor

The design rule that made this work, and the one to copy:

- **Code narrows.** It builds the candidate set, decides what is eligible, and enforces every hard rule (allowlist, redaction, withheld kinds, step budget).
- **Jev judges.** It makes the calls code can't: which control matches the goal, whether we've arrived, whether a control could change something.
- **Code decides.** Thresholds turn probabilities into actions. A probability can only ever *stop* the loop; it never widens what may be done.

In `server/src/goal.ts`: `eligible()` is code, `stepQuestions()` is the Jev ask, and the `if` chain after each reply is code deciding.

## Rules learned in this build

**1. Jev can only pick what it's shown, so the candidate set is the real design work.**
A snapshot averages ~500 elements and Choice caps at 255, so code filters first (visible, navigational, same-host, no action words) and always adds a `none` option. Without `none`, a page with no right answer still yields a confident-looking wrong one.

**2. Ask independent questions of the same state in one request; dependent ones need a second.**
`next`, `done` and `auth_wall` go together: they share state and can't see each other's answers. The mutation check (`mutates`) needs the chosen element, which only exists after the first reply, so it's a second request. That costs ~200 ms, and only for picks that will actually be clicked.

**3. Thresholds encode the cost of being wrong, not a quality bar.**

| Gate | Threshold | Why this side |
|---|---|---|
| `done` | ≥ 0.8 | A false "done" silently ends short of the goal |
| pick probability | ≥ 0.6 | Below it, the second choice is plausible enough to hand back |
| `auth_wall` | ≥ 0.7 | Sign-in pages need the human regardless |
| `mutates` | ≥ **0.3** stops | Asymmetric: a false stop costs one hand-back, a false click can cost a client |

**4. A weak judgment usually means missing evidence, not a weak model.**
First live run: after clicking "Pages", `done` came back at **0.42**. The state held only title, path and headings. Adding `arrived_via` (the control just clicked and its destination) raised it to **0.81** on the same page, and the pick went from 0.71 to 0.93. Give the question what a person would look at before tuning thresholds.

The 2026-09-18 sequel: adding the page's visible text (2,000 chars, redacted) made `done` **drop** to 0.71–0.77 on the same goal, and it was right to. The trace showed the text was the Overview page's: the loop had judged "done" on the page it had just left (rule 8 below). With the real page in evidence, `done` is 0.95–0.98. More evidence is only ever better; if it lowers a score, the score was wrong before.

**5. Everything in the request leaves the machine, so gate it like a credential.**
- A **fail-closed allowlist**: absent means off, malformed is an error, unlisted sends nothing and never reads the key.
- **Redact** every page-derived string (`redactText`: emails, JWTs, UUIDs, keys, long digits).
- **Withhold** what you don't need. The first live run sent `Google Account: <name> (<email>)` as a candidate. Off-host links are now withheld, and redaction backstops the rest.
- **Some data never goes, whatever the config says.** Financial sites are blocked in code (`FINANCIAL_DOMAINS` in `server/src/jev.ts`, matched on registrable domain): listing one makes the whole allowlist an error, and the host check refuses one regardless. Chris's decision, 2026-09-16: financial data is not sent to TypeSafe. Extend the set; never add an override.

**6. Inject every dependency; test the "sends nothing" paths hardest.**
`runGoal(deps, options)` takes page/settle/elements/click/ask/allowHost as functions, so every stop rule has a unit test with fakes (`scripts/interactive-goal.test.mjs`). The end-to-end suite (`scripts/navigate-goal.test.mjs`) runs a fake TypeSafe HTTP server and a fake `security` that logs lookups, which is how "unlisted host never reads the key" is proven rather than assumed.

**7. "Done" is a judgment, not evidence; let code verify when it can.**
`expect` (text that must appear in the final URL or visible text) turns Jev's `done` into a code-checked finish. Without it the result is marked `DONE (unverified)`. jev-ultrafast does the same with an independent checker after the run, and says outright that its `DONE` choice is never evidence of success.

**8. After a click, wait for the page to LEAVE the old view; a quiet window is the wrong signal on an SPA.**
Measured with `scripts/probe-transition.mjs` on Search Console: the URL flips on the click, the control count wobbles at once (60 → 58, still the Overview), a loading skeleton then holds a **stable** count under the old title for ~850 ms, and the real page arrives with the **title change** at 1.5–2.0 s (up to 4 s when Google queues the route behind its data loads). The 500 ms quiet window reported "stable" on the old view every time, so the baseline's `done=0.80` was judged against the wrong page, and its 2.7–3.3 s runs were fast by measuring nothing. The loop now waits for the title to change (capped at 4 s, falling back to a count change when the title is unavailable), then a 200 ms count hold capped at 1.5 s. The trace prints where each wait went. If a wait constant looks tunable, run the probe first.

## Measurements

| What | Result |
|---|---|
| Choice latency, synthetic 15 / 120 options | 384 ms / 130 ms (warm connection) |
| Choice with 500 options | HTTP 400: at most 255 choices |
| Mutation check on `Delete endpoint` | 0.92 |
| `interactive_elements` vs `take_snapshot`, Search Console overview | 2,909 vs 18,764 characters |
| Live: "open the Pages indexing report" (3 runs) | 1 handback before the `arrived_via` fix; then DONE twice, 1 click, 3.2–3.6 s, done=0.81 |
| Live: "open the Sitemaps report" | DONE, 1 click, 2.6 s, pick p=1.00, done=0.95 (superseded by the A/B above) |
| Tokens per 1-click run | ~4.8k over 3 requests |
| **2026-09-18 baseline, 6 runs** (before the rework) | Pages: 1 of 3 done, `done` 0.78–0.80, 2.7–3.3 s. Sitemaps: 3 of 3, 2.5–3.3 s. Every step-2 judgment was made on the stale Overview view |
| **2026-09-18 after the rework, 7 runs** | **7 of 7 done**, `done` 0.95–0.98, real page in evidence. Pages 4.1–4.9 s (one 6.6 s, one 16 s before the hold cap), Sitemaps 4.7–6.1 s. Of that, 1.5–4.0 s is Google swapping the route after the click, ~0.5 s the first settle, ~0.6–0.9 s Jev over 3 requests, ~0.5 s snapshots and RPCs |
| Jev first request, cold vs warmed | ~700 ms cold; 130–350 ms after a throwaway GET during the first settle (`warmJev`) |
| Tokens per 1-click run, with visible text | ~5.4–5.9k over 3 requests (was ~4.8k) |
| **Fast-site A/B, Wikipedia** ("open the Talk page" from the Gödel article, old loop in a worktree vs new, 3 runs each) | Old: 2 of 3 done, 3.7–3.9 s; the failure was the same stale-view bug (clicked Talk, observed the still-loading original page, `done` 0.65, tried the same link again). New: 3 of 3, 3.3–3.4 s, `done` 0.98–0.99, first Jev request ~250 ms vs ~600 ms. Of the new clock: ~0.55 s first settle, ~0.8 s Jev, ~0.7 s post-click, ~1.3 s snapshots of a 2,026-control page |
| Wikipedia, ambiguous goal ("the incompleteness theorems article") | Both loops hand back about half the time at p≈0.55: 2,026 controls, capped at 254 in DOM order, several lookalike links. A candidate-set limit, not a loop one |
| jev-ultrafast, Google Flights, for scale | 11 actions in 7.07 s; Jev median 178 ms over 17 requests (3.7 s of the 7); ~640 ms per action all-in |

### The Claude-driven baseline, measured (2026-09-18)

The original keep/kill test compared against "the Claude-driven path", which until now was a proxy: nav-memory's 4.8 s median gap between steps. It is now measured directly. A general-purpose subagent was handed the **same goal in the same words**, on the **same pre-settled tab**, with the zen tools and `navigate_goal` forbidden, and bracketed its own browser work with millisecond timestamps. Three runs per site, same build on both sides.

| Goal | navigate_goal (median of 3) | Claude-driven (median of 3) | Ratio |
|---|---|---|---|
| Search Console, "open the Sitemaps report" | **4.8 s** (4.6 / 4.8 / 5.1) | **15.0 s** (9.4 / 15.0 / 15.4) | **3.1×** |
| Wikipedia, "open the Talk page for this article" | **3.8 s** (3.4 / 3.8 / 4.0) | **21.6 s** (20.8 / 21.6 / 28.0) | **5.7×** |

**The baseline is best-case, and deliberately so.** Every one of the six runs took the optimal route with **zero wrong turns in the browser** — typically `find_by_text` → `click_by_uid` → one confirming read, three calls. One run used `css:#ca-talk a` from prior knowledge of Wikipedia's DOM, a shortcut navigate_goal cannot take, and still took 20.8 s. The subagents were also handed an already-settled page, while navigate_goal's number includes its own ~0.55 s first settle. Both asymmetries favor the baseline, so the real ratios are wider.

**Where the Claude time goes: round trips, not the browser.** No agent reported a slow browser call. The cost is ~4-5 s per model turn, and a correct run needs three or four. Two of the three Wikipedia runs additionally burned 2 turns each guessing tool argument names (`wait_for` needs `condition` + `urlPattern`, `evaluate_script` needs `code`); the third spent one `ToolSearch` instead and had none. That is a real recurring cost of driving a tool surface by model, and it is exactly the cost a code loop does not pay.

**Independent confirmation of the click-feedback race.** Two of the three Wikipedia agents flagged, unprompted, that `click_by_uid` echoed the OLD url and title because the navigation had not committed, and both said an agent trusting that line would have clicked again. That is the same race that made `navigated` unreliable in the settle (see *Known limits*), found from the other side.

**So the shared-render worry was real but not fatal.** Google's route swap (1.5-4 s) is paid by both paths and does drag the ratio down: on Search Console the non-render work is 6.7× faster, the whole task 3.1×. On a fast site, where render is under a second, the full 5.7× shows through. The 3× bar survives on both, and it is tightest exactly where the site is slowest.

## Known limits

- **A one-click run is ~4–5 s on Search Console, and most of it is Google.** The route swap after a click takes 1.5–4 s before the page exists to judge. Any driver, Claude included, pays that; any speed comparison has to include it on both sides.
- **A page with a static title pays the 4 s title cap on every navigating click** before falling through to the count hold. Reduce the cap only with a probe trace in hand.
- **`stable` (the tool) is still a quiet window** and still fires on an SPA's old view. Use it after a click only when you know the count changes; otherwise wait for text or a selector.
- **Top frame only** for `stable` and the fingerprint probe; the snapshot itself does reach iframes.
- **The click feedback races a full page load**, so `navigated` is `false` for a real navigation on Wikipedia. The settle detects the path change itself and waits for the title anyway; don't rely on `navigated` alone.
- **Big pages are capped, in DOM order.** 2,026 controls on a Wikipedia article become 254 candidates, and the snapshot of such a page is ~1.3 s of a 3.4 s run. A visible-only, single-call snapshot (what jev-ultrafast does) is the next lever, and not worth its extension re-sign today: the measured ratio passes without it, and on console pages an observation is ~200 ms.
- **Pricing unchecked.** Tokens are reported per run; cost per token isn't known yet.
- **Read-only by construction.** No typing, selecting, toggling or form flows, and that is not a gap to close here.

## Where else — the survey and the verdict

> **Superseded twice, 2026-09-18 — read this before using the table below.** The verdict was already stale when written (PocketBuddy's **values alignment** shipped on Jev 2026-09-16, `services/alignment_outbound.py`), and Chris authorized a third integration on 2026-09-18: **PocketBuddy intent routing**. Tripwire 1 *was* met and the survey missed it — the survey asked whether a decision path had a sub-2-second budget, checked the QES 60s SLA, and never measured the chat router the user watches a spinner for. Measured: **2.2–2.6s on Luna vs ~170ms on Jev**, 98% agreement on the 86 labelled examples the router prompt already carried.
>
> **The correction that generalizes: a latency budget is what a human will sit through, not what an SLA says.** Filter 4 ("needs a sub-2-second budget") is right; applying it only to contractual deadlines is what made it miss. Ask where someone is *waiting*.
>
> Filter 3 also needs narrowing: the router was a **metered OpenAI call**, not subscription work, so "the marginal cost of a decision here is zero" was never true of it. Cost still didn't decide it — latency did — but the premise was wrong.
>
> The privacy rule below (§ rule 5, no financial data to TypeSafe) was **deliberately widened** for routing, not bypassed: a sanitized message with no user id may leave for an opted-in user. The reasoning is in finance-app's `agents/routing_outbound.py`.

**Verdict, 2026-09-17: no second integration.** Jev is priced for a problem this shop doesn't have. Its whole pitch is cost *per decision*, and the marginal cost of a decision here is already **zero** — the decision layer runs on the Claude subscription (jobscan's haiku workers, aimedia's planner, every headless `claude -p`). "40–400× cheaper" is a comparison against a metered bill that doesn't exist; adding Jev doesn't remove a line item, it adds one. It also adds permanent harness surface — the fail-closed allowlist, `redactText`, the financial-domain block and the tests for all three — which exists because the first live run leaked an account email.

Not "Jev is bad." **Jev is built for someone paying per decision at volume.** This shop pays per month, at low volume, against latency budgets measured in seconds.

### Five filters that kill a candidate before the shape test

1. **Text or JSON only** (~32k tokens, no images). Anything judged from a frame or a screenshot is out — aimedia's story checks read a scene's last frame; the iOS validator compares screenshots.
2. **Quality is lateral at best.** 67.8% agreement in TypeSafe's own four-workflow eval — level with Sonnet 5, behind Opus 5 (73.1) and Sol (74.1). Only ever a swap where **haiku is already good enough**; never where Opus was the right call.
3. **Cost only binds where the subscription doesn't reach.** See the verdict.
4. **Latency needs a sub-2-second budget to matter.** 130–400 ms against ~3–5 s wins nothing under a 60-second SLA.
5. **A trained classifier would be cheaper, faster and private.** Ask this *first* on anything classification-shaped: the competitor isn't another model, it's **no model**. It loses only when the labels are scarce, written as rules rather than found in the data, or churning — see § *Jev vs a trained classifier*.

### The survey

| Candidate | The judgment | Why not now |
|---|---|---|
| **QES / LSA responder** | urgency × $value · service category · technician class · is the six-field intake complete | The shape is exact — this *is* the differentiator sold against Housecall Pro. But the budget is **60 s**, which haiku clears by 20×, and one contractor is not volume. **Correction to an earlier read here: "sub-60s is contractual, therefore binding" was wrong** — a constraint met 20× over is not a constraint |
| **jobscan** | score a posting against the rubric | **The only live signal.** haiku workers tripped the Claude *session limit* — the one place the subscription stops being free, because the constraint turns into rate, not dollars. Still weak: 3 workers, a weekly sweep |
| **PocketBuddy values alignment** | merchant ↔ a stated value | ~~Not the bottleneck~~ — **already built and shipped 2026-09-16**, before this row was written. `services/alignment_outbound.py` is the five-field outbound record the routing work later copied |
| **PocketBuddy intent routing** | which agent · which tool domain · how long an answer · does this need dates | **Built 2026-09-18.** The case the survey missed: 2.2–2.6s of user-visible wait, a metered call, a bounded judgment over ~10 agents and 6 domains. 98% / ~170ms |
| **`navigate_goal`** | built, in use | Runs under the tripwire at the bottom; the allowlist grows on demand, never to feed it |

The move on all of them is the same, and it doesn't need Jev: **decompose into named typed questions on haiku first.** The decision-native-models guide's own strongest finding is that *decomposition, not the model,* produced most of the measured gain — every comparison model got more accurate, faster and cheaper inside an explicit decomposed workflow. Do that and the Jev swap stays a one-line, reversible margin lever for later.

### Looks like a fit, isn't

- **aimedia story checks** — vision. Out by filter 1. (The Whisper line-vs-planned-line check is text on text and could go; it's a sliver.)
- **CXMail triage** — one user. Nothing binds, and haiku is already fine.
- **TeacherHero's coach** — full curriculum context is the moat, and the moat is generative.
- **The `deny-secret-exposure` hook** — tempting as a `noul` ("does this command expose a credential?"). Hard no: it puts a network round trip in front of every Bash call, and a false negative leaks a key. A regex that fails **closed** beats a probability that is honest on average.

### Tripwires — revisit only when one of these is true

1. **A decision path gets a sub-2-second budget** — voice, a live UI gate, a real per-tick loop.
2. **Subscription rate limits, not dollars, become the binding constraint** on a single workflow. Watch jobscan; it has already tripped once.
3. **Per-decision cost is billed through to a client at volume** — the LSA line across *many* contractors, not one.

None are true today. Until one is, the answer is no.

## Jev vs a trained classifier

The five filters above ask whether Jev beats **another model**. Until 2026-09-19 none of them asked whether it beats **no model** — a logistic regression or a distilled encoder running in-process for nothing. On anything classification-shaped that is the cheaper competitor, and it is the one to rule out first.

Prompted by [@scheemunai](https://x.com/scheemunai/status/2101067322219696632) (X, 2026-09-18), who runs 500,000 YouTube transcripts a day through a topic classifier for an internal ad network — *"a small ML algo on a server, it classifies it in milliseconds for $0. Why would I use Jev for this?!"* For his task, you wouldn't. He is not wrong about Jev; he is describing a different problem.

### Five questions that decide it

| Ask | A trained classifier wins when | Jev wins when |
|---|---|---|
| **Labelled data** | thousands of examples arrive for free | dozens, hand-written, with no traffic to harvest |
| **Where the labels come from** | the data — clusters that exist in the world | a written rule that splits near-identical sentences |
| **Label-set churn** | stable for months | a new class ships with every feature |
| **Volume** | per-call cost *is* the bill | per-call cost is a rounding error and latency is the bill |
| **What goes outbound** | nothing — it runs in-process | the text leaves, and you can live with that |

Every row favouring the classifier favours it over an LLM too. That is the point: *"Jev or haiku"* is the second question, *"anything or nothing"* is the first.

### Worked example — PocketBuddy intent routing

Re-checked 2026-09-19 against the shipped implementation. Would a custom classifier have been the better fix? No, and each row says why.

- **Labelled data: 86 examples, and that is all of it.** `data_query` 29 · `context` 23 · `advisory` 12 · `transfer_rules` 6 · `budget` 6 · `dashboard_layout` 6 · `clarify` 4. Six examples for a class, two real users, and nothing to harvest. @scheemunai trains on half a million documents a day arriving for free.
- **The labels are prose rules, not clusters.** `"what's my net worth"` routes advisory but `"net worth over time"` routes data_query; `"I'll pay the card first"` is a decision to remember but `"should I pay the card first"` is advice. Those pairs are nearest neighbours in any embedding space and differ by a modal verb or a tense. Embedding + LR separates ad topics trivially and separates *those* essentially never on six examples. That — not anything magic about Jev — is why a read-the-criteria model wins here.
- **The label set churns.** `data_query`, `dashboard_layout`, `context` and the account tools inside `context` all shipped within months. A new class means relabel, retrain and a versioned artifact in the deploy; on Jev it is editing a paragraph in `ROUTES` and re-running the eval.
- **Volume is two real users.** The $0-per-call argument wins at 500k/day and buys nothing at 500/week.
- **Outbound is the row the classifier wins, and it wins it decisively.** `agents/routing_outbound.py` — 207 lines of masking, `is_person_shaped` withholding, the opt-in flag, the demo carve-out and a written residual risk about names in free text — exists *only* because the classifier is remote. A local model deletes the whole module. Weigh that honestly before the next integration; it is the strongest standing argument against one.

### What the swap is actually worth, measured

The same eval scores both routers on the same 86 labels: **reasoning-off Luna 85/86 at p50 1135 ms; Jev 84/86 plus 2 safe hand-backs at ~170 ms.** Accuracy is a wash. The entire case is ~1 s of time-to-first-token — and the largest single win on that path (2.2–2.6 s → ~1.1 s, from `reasoning_effort='none'`) was free, in-house and already shipped.

Two things to carry:

1. **Measure the incumbent after tuning it, not before.** "2.4 s vs 170 ms" reads as a 14× win; against the tuned incumbent it is 6.6× on one part of the wait.
2. **Take the free structural win before the vendor one.** `api/agents.py` still runs context → history → classify sequentially in both handlers, because Luna consumes `financial_context`. `RoutingRecord` has exactly two fields — Jev never reads the context — so under Jev the classify call can be gathered with the context build, hiding most of the remaining cost behind work already being done. Larger than the model swap, and free.

### The rule that travels

**Jev is for a judgment you can only state as a rule, over data you have no labels for, where someone is waiting.** Where the labels exist or the world supplies them, a small trained classifier is faster, free and private. Where the judgment has to be *written* — a clarifying question, a summary — neither is the tool.

Corollary for a bootstrap: the honest custom-classifier play is rarely "train one from scratch", it is **distil the decisions you are already logging** once there are thousands of them — which deletes the outbound path with it. Tripwire for routing: ~2,000 logged prod routes with every class above ~100 → re-run `scripts/eval_jev_routing.py` with a local distilled model as a third arm. Match at ~20 ms with nothing leaving the machine and the swap pays for itself twice.

## The loop, reworked (2026-09-18)

Prompted by browser-use's [`jev-ultrafast`](https://github.com/browser-use/jev-ultrafast): Zürich → London on Google Flights in 7.1 s, 11 actions, one Jev request per decision at 178 ms median. Same API and the same latency band as ours; the difference was entirely in the loop around it.

**What it does better, and what was taken:**

| Theirs | Ours, after | Taken? |
|---|---|---|
| Event-based waits: two frames or 50 ms; 200 ms for a combobox | Title-change wait after a navigating click, then a 200 ms hold; count-change then 150 ms after a same-page click | Yes, in the form the probe justified (rule 8) — their 50 ms would have judged the old view here too |
| Operation and every target head in **one** request; the executor reads only the matching head | Still two requests when a click will happen: `next` + `done` + `auth_wall`, then `mutates` on the pick | No — the guard needs the pick, and ~200 ms is its price |
| Visible text and a `recent_actions` history with `page_changed` in state | `page.text` (2,000 chars, redacted) and `recent_actions` replacing `clicked_so_far` | Yes |
| Semantic freshness guards before acting (document, URL, target, nearby context) | URL re-read right before the click; the uid itself fails loud if the node is gone | Partly |
| `DONE` never trusted; an independent checker verifies the outcome | `expect` verifies in code; otherwise the result says `unverified` | Yes |
| No allowlist, no redaction, no mutation guard, no financial block; a demo tab in a disposable profile | All four kept, unchanged | No, deliberately |
| `TYPE_TEXT` via a second small LLM (Mercury 2.5) | Read-only by construction | No |
| ~5.3k tokens per request (every target head in every request) | ~1.8–3.1k per request | — |

**The honest read on speed.** The baseline looked 1.5 s faster than the reworked loop and was wrong three times out of six. The rework is not slower; it is the first version that waits for the page to exist. What it removed: ~1 s of quiet-window overhead per click, and ~500 ms off the first Jev request. What it cannot remove: the site's own render time, which jev-ultrafast pays too (Flights' final "Search → results" interval alone was 1.9 s of its 7).

**Not done, on purpose:** the operation-as-choice restructure (`CLICK`/`WAIT`/`DONE`/`BLOCKED` in one distribution). It reads cleaner than two nouls plus a `none`, but it changes what every threshold means, and the thresholds encode the cost of being wrong on a live browser. Revisit only if `none` picks start landing where `done` should.

## Porting to another project

1. Store the key once: `sk TYPESAFE_API_KEY`. Consume it with `secret run -k TYPESAFE_API_KEY -- <cmd>`; the Python SDK reads that env var by default. Never put it in a file.
2. Write down what code decides and what Jev judges before writing a question.
3. Build the candidate set in code, cap it (255 for Choice), and add a `none`.
4. Batch independent questions; make a second request only for dependent ones.
5. Set each threshold by the cost of being wrong in that direction, and let probabilities only narrow what happens.
6. If anything user- or client-derived goes into state: allowlist, redact, withhold.
7. Inject the Jev call so tests can fake it, and test the refusal paths end to end.
8. Measure latency, tokens and hand-back rate on real inputs before deciding it fits.
9. After an action, wait for the page to *leave* the state you acted on (title, URL, a known element), never for a quiet window; then verify the finish in code when you can name what "arrived" looks like.

Good candidates are judgments over a bounded set: categorizing a transaction, routing an intake message, checking a record against its source. It's a poor fit where the answer has to be generated rather than chosen.

Two notes that read against the general Jev literature. For the vendor-level treatment — the interface, calibration vs. accuracy, the four-workflow eval, and pricing at $0.042 per million input tokens — see **"The model that won't talk"** (the decision-native-models guide, in Onyx under `Learnings/Anthropic/Anthropic Applied AI Architect`). This doc is what happened when those claims met a build.

- **Here Jev *drives* the loop rather than sitting beside one.** The usual framing puts cheap typed judgments in five seats around a *generative* agent loop: completion check, tool gate, trace grade, loop detection, escalation. `navigate_goal` has no LLM in the loop at all — Jev is the controller and code is everything else. That is cheaper again, and it has a different failure mode: nothing in the loop can explain itself, so the run's own record is the only evidence there is. That is why `runGoal` returns `steps[]` and the probe prints it. Build the trace before the second use case, not after.

## In use, with a tripwire

**Decision, 2026-09-18 (Chris): `navigate_goal` is in use. The formal keep/kill test is retired.**

The test asked for 3× faster than the Claude-driven path on three recurring non-financial reads with zero wrong clicks. Search Console passed at 3.1×, and the fast-site control at 5.7× (see *The Claude-driven baseline, measured*). The remaining two reads were not run, on purpose: the test existed to decide whether to invest, the investment is already spent, and the mechanism now predicts the answer (another slow console, another ~3×). Finishing it would be measurement for its own sake. The number that decides whether the tool earns its place is the **hand-back rate on goals nobody picked for measurability**, and only real use produces that.

**How to use it**

- **A fast path that sometimes declines, not a replacement for driving.** On an ambiguous page it hands back (about half the time at p≈0.55 on a 2,026-control article with lookalike links), where a Claude agent would reason through and finish. A hand-back leaves the tab where it stopped with working UIDs, so falling back to `click_by_uid` costs almost nothing.
- **Pass `expect` whenever you can name what arrival looks like.** Without it the finish is Jev's judgment alone.
- **The allowlist grows on demand, one host at a time, on first need** — the same policy as the container routing table, and for the same reason: a speculative entry is unexercised surface. Every allowlisted host's control labels leave the machine; that is the only real cost of using this, so it is the thing to be deliberate about. Financial hosts stay blocked in code regardless. `en.wikipedia.org` is listed as the fast-site A/B fixture (public link labels only), not as a workload.

**The tripwire — either one shelves it**

1. **Any wrong click: shelve immediately.** Not a ratio. A click on something that was not a step toward the goal, or on anything that changed state, is exactly what the eligibility filter, the action-word list and the mutation guard exist to prevent; one instance means they failed, and the tool runs in a browser holding client sessions.
2. **More hand-backs than finishes across the first ten real uses: shelve as not worth reaching for.** Real uses, not probe runs. Tally them here:

| # | Date | Host | Goal | Outcome | Note |
|---|---|---|---|---|---|
| | | | | | |

If it is shelved, `interactive_elements`, `wait_for stable`, the title-change settle and `scripts/probe-transition.mjs` stand on their own; record why here and leave the code.

**To re-measure** (a new host class, or a loop change that might move the ratio), use the A/B protocol from the baseline section: a subagent given the same goal in the same words on the same pre-settled tab, `navigate_goal` forbidden, timing its own browser work with `python3 -c 'import time;print(int(time.time()*1000))'` (BSD `date` has no `%3N`).
