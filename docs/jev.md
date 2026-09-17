# Jev in zen-mcp

Status: implemented 2026-09-16 (`interactive_elements`, `wait_for` `stable`, `navigate_goal`). An experiment with a written keep/kill test at the bottom.

**Before proposing a second integration, read § *Where else — the survey and the verdict*. The answer as of 2026-09-17 is no, and the three tripwires that would change it are listed there. Don't re-derive it.**

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

## Where else — the survey and the verdict

**Verdict, 2026-09-17: no second integration.** Jev is priced for a problem this shop doesn't have. Its whole pitch is cost *per decision*, and the marginal cost of a decision here is already **zero** — the decision layer runs on the Claude subscription (jobscan's haiku workers, aimedia's planner, every headless `claude -p`). "40–400× cheaper" is a comparison against a metered bill that doesn't exist; adding Jev doesn't remove a line item, it adds one. It also adds permanent harness surface — the fail-closed allowlist, `redactText`, the financial-domain block and the tests for all three — which exists because the first live run leaked an account email.

Not "Jev is bad." **Jev is built for someone paying per decision at volume.** This shop pays per month, at low volume, against latency budgets measured in seconds.

### Four filters that kill a candidate before the shape test

1. **Text or JSON only** (~32k tokens, no images). Anything judged from a frame or a screenshot is out — aimedia's story checks read a scene's last frame; the iOS validator compares screenshots.
2. **Quality is lateral at best.** 67.8% agreement in TypeSafe's own four-workflow eval — level with Sonnet 5, behind Opus 5 (73.1) and Sol (74.1). Only ever a swap where **haiku is already good enough**; never where Opus was the right call.
3. **Cost only binds where the subscription doesn't reach.** See the verdict.
4. **Latency needs a sub-2-second budget to matter.** 130–400 ms against ~3–5 s wins nothing under a 60-second SLA.

### The survey

| Candidate | The judgment | Why not now |
|---|---|---|
| **QES / LSA responder** | urgency × $value · service category · technician class · is the six-field intake complete | The shape is exact — this *is* the differentiator sold against Housecall Pro. But the budget is **60 s**, which haiku clears by 20×, and one contractor is not volume. **Correction to an earlier read here: "sub-60s is contractual, therefore binding" was wrong** — a constraint met 20× over is not a constraint |
| **jobscan** | score a posting against the rubric | **The only live signal.** haiku workers tripped the Claude *session limit* — the one place the subscription stops being free, because the constraint turns into rate, not dollars. Still weak: 3 workers, a weekly sweep |
| **PocketBuddy values alignment** | merchant ↔ a stated value | Genuine fan-out shape, already schema-gated — but single-user volume. Not the bottleneck |
| **`navigate_goal`** | built | Let the keep/kill test below finish; don't expand the allowlist to feed it |

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

## Porting to another project

1. Store the key once: `sk TYPESAFE_API_KEY`. Consume it with `secret run -k TYPESAFE_API_KEY -- <cmd>`; the Python SDK reads that env var by default. Never put it in a file.
2. Write down what code decides and what Jev judges before writing a question.
3. Build the candidate set in code, cap it (255 for Choice), and add a `none`.
4. Batch independent questions; make a second request only for dependent ones.
5. Set each threshold by the cost of being wrong in that direction, and let probabilities only narrow what happens.
6. If anything user- or client-derived goes into state: allowlist, redact, withhold.
7. Inject the Jev call so tests can fake it, and test the refusal paths end to end.
8. Measure latency, tokens and hand-back rate on real inputs before deciding it fits.

Good candidates are judgments over a bounded set: categorizing a transaction, routing an intake message, checking a record against its source. It's a poor fit where the answer has to be generated rather than chosen.

Two notes that read against the general Jev literature. For the vendor-level treatment — the interface, calibration vs. accuracy, the four-workflow eval, and pricing at $0.042 per million input tokens — see **"The model that won't talk"** (the decision-native-models guide, in Onyx under `Learnings/Anthropic/Anthropic Applied AI Architect`). This doc is what happened when those claims met a build.

- **Here Jev *drives* the loop rather than sitting beside one.** The usual framing puts cheap typed judgments in five seats around a *generative* agent loop: completion check, tool gate, trace grade, loop detection, escalation. `navigate_goal` has no LLM in the loop at all — Jev is the controller and code is everything else. That is cheaper again, and it has a different failure mode: nothing in the loop can explain itself, so the run's own record is the only evidence there is. That is why `runGoal` returns `steps[]` and the probe prints it. Build the trace before the second use case, not after.

## Keep or kill

Keep `navigate_goal` if it is at least **3× faster** than the Claude-driven path on three recurring **non-financial** reads, with **zero wrong clicks**. Search Console is measured. Stripe is out permanently (financial). Bing Webmaster Tools is the natural second task, since it's the same kind of SEO console; the third should be chosen deliberately, because every allowlisted host's control labels leave the machine. If it fails the test, `interactive_elements` and `stable` stand on their own; shelve `navigate_goal` and record why here.
