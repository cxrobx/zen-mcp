# Jev in zen-mcp

Status: implemented 2026-09-16 (`interactive_elements`, `wait_for` `stable`, `navigate_goal`). An experiment with a written keep/kill test at the bottom.

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

**5. Everything in the request leaves the machine, so gate it like a credential.**
- A **fail-closed allowlist**: absent means off, malformed is an error, unlisted sends nothing and never reads the key.
- **Redact** every page-derived string (`redactText`: emails, JWTs, UUIDs, keys, long digits).
- **Withhold** what you don't need. The first live run sent `Google Account: <name> (<email>)` as a candidate. Off-host links are now withheld, and redaction backstops the rest.
- **Some data never goes, whatever the config says.** Financial sites are blocked in code (`FINANCIAL_DOMAINS` in `server/src/jev.ts`, matched on registrable domain): listing one makes the whole allowlist an error, and the host check refuses one regardless. Chris's decision, 2026-09-16: financial data is not sent to TypeSafe. Extend the set; never add an override.

**6. Inject every dependency; test the "sends nothing" paths hardest.**
`runGoal(deps, options)` takes page/settle/elements/click/ask/allowHost as functions, so every stop rule has a unit test with fakes (`scripts/interactive-goal.test.mjs`). The end-to-end suite (`scripts/navigate-goal.test.mjs`) runs a fake TypeSafe HTTP server and a fake `security` that logs lookups, which is how "unlisted host never reads the key" is proven rather than assumed.

## Measurements

| What | Result |
|---|---|
| Choice latency, synthetic 15 / 120 options | 384 ms / 130 ms (warm connection) |
| Choice with 500 options | HTTP 400: at most 255 choices |
| Mutation check on `Delete endpoint` | 0.92 |
| `interactive_elements` vs `take_snapshot`, Search Console overview | 2,909 vs 18,764 characters |
| Live: "open the Pages indexing report" (3 runs) | 1 handback before the `arrived_via` fix; then DONE twice, 1 click, 3.2–3.6 s, done=0.81 |
| Live: "open the Sitemaps report" | DONE, 1 click, 2.6 s, pick p=1.00, done=0.95 |
| Tokens per 1-click run | ~4.8k over 3 requests |

For comparison, nav-memory telemetry puts the median gap between Claude-driven steps at 4.8 s.

## Known limits

- **`done` for "Pages" sits at 0.81**, just over the line. A goal whose wording differs from the page's own words will hand back more often than it finishes.
- **`stable` can fire before an SPA's main content renders** if the control count doesn't change during the transition (the nav stays put). On one run, step 2 counted the same 48 controls as step 1. The decision still used the new path and title, but the candidate list may be stale on such pages.
- **Top frame only** for `stable`; the snapshot itself does reach iframes.
- **Pricing unchecked.** Tokens are reported per run; cost per token isn't known yet.
- **Read-only by construction.** No typing, selecting, toggling or form flows, and that is not a gap to close here.

## Use cases — how to recognize one

Added 2026-09-17 from two X posts: a Grok answer to "give me a few brief use cases as
an entrepreneur" (route tickets/leads by intent; score risk, pricing or inventory in
real time; run dozens of parallel user-flow sims or A/B tests; power high-speed browser
agents; guardrail other AI agents — all under a cent per run), and Max Blade's demo of
Jev playing Subway Surfers at superhuman speed and 50 games at once. Both are
**marketing-adjacent claims, not measurements taken here.** Kept because the shapes they
name are right, and two of them are the shapes already built in this repo.

The framing worth keeping, from Blade: **Jev does not replace an LLM — it is a different
primitive.** An LLM is something you call. Jev is cheap and fast enough to put *inside* a
loop.

### The shape test

A judgment fits Jev when all four hold:

1. **The answer is picked, not composed.** One of a set, a yes/no, or a level on an
   ordered rubric. If the deliverable is a sentence, that is an LLM.
2. **Code can enumerate the set.** ≤255 options, built by code, always with a `none`.
3. **A wrong answer is survivable or catchable.** There is a threshold to set and a
   hand-back path when it is not met (rule 3 above).
4. **The decision recurs often enough that latency or cost is the binding constraint** —
   per request, per step, per row, per tick. One decision an hour does not need Jev; a
   3-second LLM call is fine there.

Fail any of them and it is an LLM job, a rules job, or not a job.

### Four shapes

| Shape | What it looks like | Status here |
|---|---|---|
| **Request-path decision** | Classify / route / score inside a live request where seconds and cents per call do not fit: intent → queue, lead → priority, an urgency or risk score | Not built |
| **Loop controller** | A judgment per step of a loop the code is driving — the thing an LLM cannot sit inside | **Built:** `navigate_goal` (which control, are we done, per step) |
| **Fan-out** | The same question over N rows, or N parallel runs at once | Planned: PocketBuddy values alignment (batched per merchant) |
| **Guardrail on another agent** | A cheap second opinion on every action an LLM-driven agent wants to take | **Built:** the `mutates` check before any click |

The useful part is that two of the four already exist here, arrived at independently
before the posts: the "new world" shape (loop controller) and the guardrail shape.

### Mapped across the portfolio

Candidate reads, not commitments. Each still owes the shape test and the privacy gate.

| Where | Judgment | Shape | Note |
|---|---|---|---|
| QES / LSA responder | is this a real lead · urgency · auto-reply vs. dispatch · is the six-field intake complete | request-path | The *reply text* stays an LLM job; only the routing is Jev's |
| jobscan | score a posting against the rubric | fan-out | Today a haiku worker doing exactly a pick-from-rubric — the cheapest swap on this list |
| cxmail triage | needs-a-reply · urgency · which mail rule | request-path / fan-out | |
| PocketBuddy values alignment | merchant ↔ stated value | fan-out | Allowlisted schema only — `finance-app/plans/values-alignment.md` |
| BuildersBuddy / Artist Advisory | a deal or a track scored on an ordered rubric | fan-out | The `score` primitive |
| Anything user-linked financial | — | — | **Out.** Not a shape question |

### Where it is the wrong tool

- **The output is prose** — an LSA reply, proposal copy, a summary. Jev picks; it does not write.
- **You need the reason.** Jev returns a probability and nothing else. If a human has to
  be told *why*, an LLM has to say it.
- **The option set cannot be enumerated or capped.**
- **The decision is rare.** The whole advantage is per-decision cost and latency.
- **The state would carry user-linked financial data**, or anything that fails the
  allowlist / redact / withhold gate. That gate sits upstream of the use case, not inside it.

### On the "under a cent" claim

Both posts anchor on cost. **Not verified here.** This repo measures tokens (~4.8k over
3 requests for a 1-click run) and still has pricing unchecked. Price a real run before
committing to any fan-out candidate above — a per-row judgment at portfolio volume is
the one place a wrong cost assumption compounds.

## Porting to another project

1. Store the key once: `sk TYPESAFE_API_KEY`. Consume it with `secret run -k TYPESAFE_API_KEY -- <cmd>`; the Python SDK reads that env var by default. Never put it in a file.
2. Write down what code decides and what Jev judges before writing a question.
3. Build the candidate set in code, cap it (255 for Choice), and add a `none`.
4. Batch independent questions; make a second request only for dependent ones.
5. Set each threshold by the cost of being wrong in that direction, and let probabilities only narrow what happens.
6. If anything user- or client-derived goes into state: allowlist, redact, withhold.
7. Inject the Jev call so tests can fake it, and test the refusal paths end to end.
8. Measure latency, tokens and hand-back rate on real inputs before deciding it fits.

Use the shape test above to decide whether it is a fit at all.

## Keep or kill

Keep `navigate_goal` if it is at least **3× faster** than the Claude-driven path on three recurring **non-financial** reads, with **zero wrong clicks**. Search Console is measured. Stripe is out permanently (financial). Bing Webmaster Tools is the natural second task, since it's the same kind of SEO console; the third should be chosen deliberately, because every allowlisted host's control labels leave the machine. If it fails the test, `interactive_elements` and `stable` stand on their own; shelve `navigate_goal` and record why here.
