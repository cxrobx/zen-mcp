// Unit coverage for the two pure pieces behind interactive_elements and navigate_goal:
//
// collectInteractive (server/src/interactive.ts) turns a snapshot tree into one line per
// control. The failure it guards against is silent: a link whose text lives in a child span
// arrives unnamed, two "Edit" buttons become indistinguishable, or a typed field value leaks
// into a listing that is about to be sent off the machine.
//
// runGoal (server/src/goal.ts) is the Jev loop. Every stop rule is a place where a wrong
// click on a live, logged-in browser would otherwise happen, so each one is pinned here with
// injected fakes: no browser, no daemon, no network.
//
// The Jev allowlist (server/src/jev.ts) is pinned here too: financial sites can never be
// made eligible, by listing them or otherwise.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isFinancialHost, loadJevConfig, requireJevHost } from "../server/dist/jev.js";
import {
  INTERACTIVE_MAX_LIMIT,
  collectInteractive,
  formatInteractiveLine,
} from "../server/dist/interactive.js";
import { NONE_OPTION, runGoal } from "../server/dist/goal.js";

let nextUid = 0;
function n(tag, props = {}, children = []) {
  return { uid: props.uid ?? `1_${nextUid++}`, tag, children, ...props };
}

const PAGE_URL = "https://dashboard.example.com/acct/home?session=abc";

test("a link's label is recovered from descendant text, and its href loses the query", () => {
  const tree = n("body", {}, [
    n("a", { uid: "1_1", href: "https://dashboard.example.com/acct/webhooks?tab=x#top" }, [
      n("span", { text: "Webhooks" }),
    ]),
    n("a", { uid: "1_2", href: "https://docs.example.org/guide?ref=1", name: "Docs" }),
  ]);
  const r = collectInteractive(tree, [], { pageUrl: PAGE_URL });
  assert.equal(r.elements[0].label, "Webhooks");
  assert.equal(r.elements[0].kind, "link");
  assert.equal(r.elements[0].href, "/acct/webhooks");
  assert.equal(r.elements[1].href, "docs.example.org/guide");
});

test("same-label buttons are told apart by their row, and flagged as duplicates", () => {
  const row = (title, uid) =>
    n("tr", {}, [n("td", { text: title }), n("td", {}, [n("button", { uid, text: "Edit" })])]);
  const tree = n("body", {}, [
    n("div", { role: "dialog", name: "Payment methods" }, [
      n("table", {}, [row("ACH Direct Debit", "1_10"), row("Cards", "1_11")]),
    ]),
  ]);
  const [first, second] = collectInteractive(tree, []).elements;
  assert.equal(first.context, 'row "ACH Direct Debit" in dialog "Payment methods"');
  assert.equal(second.context, 'row "Cards" in dialog "Payment methods"');
  assert.equal(first.duplicate, true);
  assert.match(formatInteractiveLine(first), /\(same label elsewhere\)/);
});

test("a row whose only words are its link adds no row context", () => {
  const tree = n("nav", {}, [n("ul", {}, [n("li", {}, [n("a", { text: "Payments" })])])]);
  const [el] = collectInteractive(tree, []).elements;
  assert.equal(el.context, "nav");
});

test("field values never appear, only the field's name", () => {
  const tree = n("body", {}, [
    n("input", { uid: "1_20", name: "Email", value: "chris@private.example" }),
    n("textarea", { uid: "1_21", value: "typed notes", text: "typed notes" }),
    n("select", { uid: "1_22", name: "Country", value: "US" }),
  ]);
  const r = collectInteractive(tree, []);
  const listing = r.elements.map(formatInteractiveLine).join("\n");
  assert.equal(listing.includes("chris@private.example"), false);
  assert.equal(listing.includes("typed notes"), false);
  assert.deepEqual(
    r.elements.map((e) => [e.kind, e.label]),
    [["input", "Email"], ["textbox", ""], ["combobox", "Country"]],
  );
});

test("visible text is collected in DOM order, invisible nodes and field values excluded", () => {
  const tree = n("body", {}, [
    n("h1", { text: "Indexing" }),
    n("p", { text: "12 pages are not indexed" }),
    n("div", { text: "hidden banner", computed: { visible: false } }),
    n("input", { name: "Filter", value: "chris@private.example" }),
    n("a", { text: "Learn more" }),
  ]);
  const r = collectInteractive(tree, []);
  assert.equal(r.text, "Indexing 12 pages are not indexed Filter Learn more");
  assert.equal(collectInteractive(null, []).text, "");
});

test("invisible nodes and media are skipped; roles and onclick-divs are kept", () => {
  const tree = n("body", {}, [
    n("button", { text: "Hidden", computed: { visible: false } }),
    n("img", { name: "logo", computed: { visible: true, interactive: true } }),
    n("div", { role: "tab", name: "Overview" }),
    n("div", { text: "Open menu", computed: { visible: true, interactive: true } }),
  ]);
  assert.deepEqual(
    collectInteractive(tree, []).elements.map((e) => [e.kind, e.label]),
    [["tab", "Overview"], ["clickable", "Open menu"]],
  );
});

test("iframe controls carry their frame, and headings are collected", () => {
  const tree = n("body", {}, [
    n("h1", { text: "Indexing" }),
    n("button", { uid: "1_30_f7_", text: "Inspect" }),
  ]);
  const r = collectInteractive(tree, [{ uid: "1_30_f7_", css: "button", frameId: 7 }]);
  assert.equal(r.elements[0].frameId, 7);
  assert.match(formatInteractiveLine(r.elements[0]), /frame=7/);
  assert.deepEqual(r.headings, ["Indexing"]);
});

test("off-host destinations and aria-selected controls are flagged", () => {
  const tree = n("body", {}, [
    n("a", { uid: "1_40", href: "https://accounts.example.net/signout", name: "Account" }),
    n("a", { uid: "1_41", href: "https://dashboard.example.com/acct/x", text: "Local" }),
    n("div", { uid: "1_42", role: "tab", name: "Overview", aria: { selected: true } }),
  ]);
  const [off, local, tab] = collectInteractive(tree, [], { pageUrl: PAGE_URL }).elements;
  assert.equal(off.offHost, true);
  assert.equal(local.offHost, undefined);
  assert.equal(tab.selected, true);
  assert.match(formatInteractiveLine(tab), /\(selected\)/);
});

test("the limit truncates in DOM order and reports the true total", () => {
  const tree = n("body", {}, Array.from({ length: 300 }, (_, i) => n("a", { text: `Link ${i}` })));
  const r = collectInteractive(tree, [], { limit: INTERACTIVE_MAX_LIMIT });
  assert.equal(r.elements.length, 254);
  assert.equal(r.total, 300);
  assert.equal(r.truncated, true);
  assert.equal(r.elements[0].label, "Link 0");
});

test("on-screen controls win the cap, keeping DOM order inside each group", () => {
  // A long article: 300 links, only the last 10 on screen. A cap taken in DOM order would
  // spend itself before reaching any of them.
  const tree = n(
    "body",
    {},
    Array.from({ length: 300 }, (_, i) =>
      n("a", { text: `Link ${i}`, computed: { visible: true, inViewport: i >= 290 } }),
    ),
  );
  const r = collectInteractive(tree, [], { limit: INTERACTIVE_MAX_LIMIT });
  assert.equal(r.total, 300);
  assert.equal(r.truncated, true);
  // The ten on-screen links lead, in DOM order.
  assert.deepEqual(
    r.elements.slice(0, 10).map((e) => e.label),
    Array.from({ length: 10 }, (_, i) => `Link ${290 + i}`),
  );
  // Off-screen links are ordered behind them, not dropped - this loop cannot scroll.
  assert.equal(r.elements[10].label, "Link 0");
  assert.equal(r.elements.length, 254);
});

test("without viewport data the order is plain DOM order, not a silent demotion", () => {
  const tree = n("body", {}, Array.from({ length: 5 }, (_, i) => n("a", { text: `Link ${i}` })));
  const r = collectInteractive(tree, []);
  assert.deepEqual(
    r.elements.map((e) => e.label),
    ["Link 0", "Link 1", "Link 2", "Link 3", "Link 4"],
  );
});

// --- runGoal -------------------------------------------------------------------------

const HOST = "dashboard.example.com";

function el(uid, label, extra = {}) {
  return { uid, kind: "link", label, context: "", duplicate: false, ...extra };
}

function reply(answers) {
  return { model: "jev-test", answers, usage: { input_tokens: 100, output_tokens: 10 }, latencyMs: 5 };
}

function stepReply({ done = 0.05, auth = 0.02, choice, probs }) {
  return reply({
    done: { type: "noul", noul: done },
    auth_wall: { type: "noul", noul: auth },
    ...(choice ? { next: { type: "choice", choice, probabilities: probs, confidence: probs[choice] } } : {}),
  });
}

function guardReply(p) {
  return reply({ mutates: { type: "noul", noul: p } });
}

/** pages: [{ url, title, elements, go: { uid: nextPageIndex | "throw" } }] */
function harness(pages, replies, allowed = [HOST]) {
  let current = 0;
  const calls = { ask: [], click: [], settle: [] };
  const deps = {
    page: async () => ({ url: pages[current].url, title: pages[current].title ?? "" }),
    settle: async (hint) => {
      calls.settle.push(hint);
      return { settled: true };
    },
    elements: async () => ({
      elements: pages[current].elements,
      total: pages[current].elements.length,
      truncated: false,
      headings: [],
      text: pages[current].text ?? "",
    }),
    click: async (uid) => {
      calls.click.push(uid);
      const to = pages[current].go?.[uid];
      if (to === "throw") throw new Error('uid "x" not found');
      if (typeof to === "number") current = to;
      return { navigated: typeof to === "number" };
    },
    ask: async (state, questions) => {
      calls.ask.push({ state, questions });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      assert.ok(next, "ask called more times than the test scripted");
      return next;
    },
    allowHost: (host) => {
      if (!allowed.includes(host)) throw new Error(`host "${host}" is not allowed`);
    },
  };
  return { deps, calls };
}

const OPTS = { goal: "open the webhooks page", maxSteps: 5, minConfidence: 0.6 };
const home = (extra = {}) => ({
  url: `https://${HOST}/acct/home`,
  title: "Home",
  elements: [el("u1", "Payments"), el("u2", "Webhooks", { href: "/acct/webhooks" })],
  go: { u2: 1 },
  ...extra,
});
const webhooks = { url: `https://${HOST}/acct/webhooks`, title: "Webhooks", elements: [el("w1", "Add endpoint")] };

test("goal: already reached on arrival means no click and one request", async () => {
  const { deps, calls } = harness([home()], [stepReply({ done: 0.93, choice: "u1", probs: { u1: 0.5, u2: 0.4, none: 0.1 } })]);
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "done");
  assert.equal(r.clicks, 0);
  assert.equal(calls.click.length, 0);
  assert.equal(calls.ask.length, 1);
});

test("goal: pick, pass the mutation check, click, then judge done", async () => {
  const { deps, calls } = harness(
    [home(), webhooks],
    [
      stepReply({ choice: "u2", probs: { u1: 0.03, u2: 0.95, none: 0.02 } }),
      guardReply(0.04),
      stepReply({ done: 0.9, choice: "w1", probs: { w1: 0.6, none: 0.4 } }),
    ],
  );
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "done");
  assert.deepEqual(calls.click, ["u2"]);
  assert.equal(r.steps[0].pick.label, "Webhooks");
  assert.equal(r.steps[0].action, "clicked, navigated");
  assert.equal(r.finalPath, "/acct/webhooks");
  // The first request's state names the page and nothing clicked yet; the second records the click.
  assert.deepEqual(calls.ask[0].state.recent_actions, []);
  assert.deepEqual(calls.ask[2].state.recent_actions, [
    { control: 'link "Webhooks"', destination: "/acct/webhooks", page_changed: true },
  ]);
  assert.equal(calls.ask[0].state.page.path, "/acct/home");
  // The first look earns a real quiet window; after a navigating click only a beat.
  assert.deepEqual(calls.settle, [{ after: "start" }, { after: "click", navigated: true }]);
  assert.equal(typeof r.steps[0].settleMs, "number");
  // Without `expect`, done is Jev's word alone and the result says so.
  assert.equal(r.verified, "jev");
  assert.match(r.reason, /not verified by code/);
  // "done" is judged with the evidence of how the page was reached.
  assert.equal(calls.ask[0].state.arrived_via, null);
  assert.deepEqual(calls.ask[2].state.arrived_via, { control: 'link "Webhooks"', destination: "/acct/webhooks" });
});

test("goal: off-host controls are never offered, and emails never leave in any request", async () => {
  const page = home({
    title: "Home - chris@private.example",
    text: "Signed in as chris@private.example. Webhooks deliver events to your endpoints.",
    elements: [
      el("g1", "Google Account: Chris (chris@private.example)", { kind: "button", href: "accounts.example.net/SignOut", offHost: true }),
      el("p1", "Profile for chris@private.example", { href: "/acct/profile" }),
      el("u2", "Webhooks", { href: "/acct/webhooks", selected: true }),
    ],
    go: { u2: 1 },
  });
  const { deps, calls } = harness(
    [page, webhooks],
    [
      stepReply({ choice: "p1", probs: { p1: 0.9, u2: 0.05, none: 0.05 } }),
      guardReply(0.02),
      stepReply({ done: 0.95, choice: "none", probs: { none: 1 } }),
    ],
  );
  await runGoal(deps, OPTS);
  const options = calls.ask[0].questions.next.criteria;
  assert.equal("g1" in options, false, "an off-host control was offered");
  assert.match(options.p1, /Profile for <email>/);
  assert.match(options.u2, /currently selected/);
  assert.deepEqual(calls.ask[0].state.page.selected, ['link "Webhooks"']);
  assert.equal(calls.ask[0].state.page.text, "Signed in as <email>. Webhooks deliver events to your endpoints.");
  for (const call of calls.ask) {
    assert.equal(JSON.stringify(call).includes("chris@private.example"), false, "an email left the machine");
  }
});

test("goal: fields, toggles and action words are withheld; options stay under Jev's 255 cap", async () => {
  const many = Array.from({ length: 400 }, (_, i) => el(`m${i}`, `Report ${i}`));
  const page = home({
    elements: [
      el("d1", "Delete endpoint", { kind: "button" }),
      el("t1", "Live mode", { kind: "switch" }),
      el("f1", "Search", { kind: "input" }),
      el("s1", "Save changes", { kind: "button" }),
      ...many,
    ],
  });
  const { deps, calls } = harness([page], [stepReply({ choice: NONE_OPTION, probs: { m0: 0.1, none: 0.9 } })]);
  const r = await runGoal(deps, OPTS);
  const options = Object.keys(calls.ask[0].questions.next.criteria);
  assert.equal(options.length, 255);
  assert.ok(options.includes(NONE_OPTION));
  for (const withheld of ["d1", "t1", "f1", "s1"]) assert.equal(options.includes(withheld), false, withheld);
  assert.equal(r.steps[0].withheld, 4);
  assert.equal(r.outcome, "handback");
});

test("goal: Jev picking none hands back without clicking", async () => {
  const { deps, calls } = harness([home()], [stepReply({ choice: NONE_OPTION, probs: { u1: 0.2, u2: 0.1, none: 0.7 } })]);
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /no control that moves toward the goal/);
  assert.equal(calls.click.length, 0);
  assert.equal(r.alternatives[0].uid, "u1");
});

test("goal: a pick below minConfidence hands back with alternatives and no mutation check", async () => {
  const { deps, calls } = harness([home()], [stepReply({ choice: "u2", probs: { u1: 0.45, u2: 0.5, none: 0.05 } })]);
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /p=0\.50 \(< 0\.6\)/);
  assert.equal(calls.click.length, 0);
  assert.equal(calls.ask.length, 1, "no guard request for a pick that will not be clicked");
  assert.deepEqual(r.alternatives.map((a) => a.uid), ["u2", "u1"]);
});

test("goal: the mutation check at or above 0.3 stops before the click", async () => {
  const { deps, calls } = harness(
    [home()],
    [stepReply({ choice: "u2", probs: { u2: 0.9, none: 0.1 } }), guardReply(0.3)],
  );
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /might change something \(mutates=0\.30\) - not clicked/);
  assert.equal(calls.click.length, 0);
});

test("goal: a sign-in page hands back even with a confident pick", async () => {
  const { deps, calls } = harness([home()], [stepReply({ auth: 0.85, choice: "u2", probs: { u2: 0.99, none: 0.01 } })]);
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /sign-in/);
  assert.equal(calls.click.length, 0);
});

test("goal: the same pick on an unchanged path stops instead of looping", async () => {
  const stuck = home({ go: {} });
  const { deps, calls } = harness(
    [stuck],
    [
      stepReply({ choice: "u2", probs: { u2: 0.9, none: 0.1 } }),
      guardReply(0.02),
      stepReply({ choice: "u2", probs: { u2: 0.9, none: 0.1 } }),
    ],
  );
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /again on an unchanged path/);
  assert.deepEqual(calls.click, ["u2"]);
});

test("goal: maxSteps caps the clicks", async () => {
  const pages = [0, 1, 2].map((i) => ({
    url: `https://${HOST}/p${i}`,
    elements: [el(`n${i}`, `Next ${i}`)],
    go: { [`n${i}`]: Math.min(i + 1, 2) },
  }));
  const replies = [];
  for (const i of [0, 1]) replies.push(stepReply({ choice: `n${i}`, probs: { [`n${i}`]: 0.9, none: 0.1 } }), guardReply(0.01));
  replies.push(stepReply({ choice: "n2", probs: { n2: 0.9, none: 0.1 } }));
  const { deps, calls } = harness(pages, replies);
  const r = await runGoal(deps, { ...OPTS, maxSteps: 2 });
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /maxSteps \(2\) spent/);
  assert.equal(calls.click.length, 2);
});

test("goal: an unlisted host throws before anything is asked", async () => {
  const { deps, calls } = harness([home()], [], ["other.example.com"]);
  await assert.rejects(runGoal(deps, OPTS), /not allowed/);
  assert.equal(calls.ask.length, 0);
});

test("goal: a click that leaves the allowlisted host hands back with the trace", async () => {
  const away = { url: "https://accounts.example.net/signin", elements: [] };
  const { deps, calls } = harness(
    [home({ go: { u2: 1 } }), away],
    [stepReply({ choice: "u2", probs: { u2: 0.9, none: 0.1 } }), guardReply(0.02)],
  );
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /left the allowlist/);
  assert.equal(r.clicks, 1);
  assert.equal(calls.ask.length, 2, "nothing is sent about the off-list page");
});

test("goal: a Jev failure before any click throws; after a click it hands back", async () => {
  const before = harness([home()], [new Error("HTTP 529")]);
  await assert.rejects(runGoal(before.deps, OPTS), /529/);

  const after = harness(
    [home(), webhooks],
    [stepReply({ choice: "u2", probs: { u2: 0.9, none: 0.1 } }), guardReply(0.02), new Error("HTTP 529")],
  );
  const r = await runGoal(after.deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /stopped on error: HTTP 529/);
  assert.equal(r.clicks, 1);
});

test("goal: a failed click hands back instead of retrying", async () => {
  const { deps, calls } = harness(
    [home({ go: { u2: "throw" } })],
    [stepReply({ choice: "u2", probs: { u2: 0.9, none: 0.1 } }), guardReply(0.02)],
  );
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /clicking u2 failed/);
  assert.equal(calls.click.length, 1);
  assert.equal(r.clicks, 0);
});

test("goal: nothing eligible means no Choice question is sent", async () => {
  const bare = home({ elements: [el("x1", "Delete all", { kind: "button" })] });
  const { deps, calls } = harness([bare], [stepReply({})]);
  const r = await runGoal(deps, OPTS);
  assert.equal(calls.ask[0].questions.next, undefined);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /no eligible control/);
});

test("goal: a pick that was never offered is refused", async () => {
  const { deps, calls } = harness([home()], [stepReply({ choice: "ghost", probs: { ghost: 0.9, none: 0.1 } })]);
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /was not offered/);
  assert.equal(calls.click.length, 0);
});

// --- financial sites never go to TypeSafe ----------------------------------------------

test("goal: a same-page click asks for only a beat, and page_changed records it", async () => {
  const menu = home({ elements: [el("m1", "Reports", { kind: "button" }), el("u2", "Webhooks", { href: "/acct/webhooks" })], go: {} });
  const { deps, calls } = harness(
    [menu],
    [
      stepReply({ choice: "m1", probs: { m1: 0.9, u2: 0.05, none: 0.05 } }),
      guardReply(0.02),
      stepReply({ choice: "none", probs: { none: 1 } }),
    ],
  );
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.equal(r.steps[0].action, "clicked");
  assert.deepEqual(calls.settle[1], { after: "click", navigated: false });
  assert.deepEqual(calls.ask[2].state.recent_actions, [{ control: 'button "Reports"', destination: null, page_changed: false }]);
});

test("goal: the settle corrects page_changed when the click feedback missed the navigation", async () => {
  // Wikipedia's case: the click RPC returns before the load commits and reports navigated=false,
  // so the settle - which watched the page afterwards - is the witness that counts.
  const { deps, calls } = harness(
    [home(), webhooks],
    [
      stepReply({ choice: "u2", probs: { u1: 0.03, u2: 0.95, none: 0.02 } }),
      guardReply(0.04),
      stepReply({ choice: "none", probs: { none: 1 } }),
    ],
  );
  const click = deps.click;
  deps.click = async (uid) => ({ ...(await click(uid)), navigated: false });
  deps.settle = async (hint) => {
    calls.settle.push(hint);
    return hint.after === "click" ? { settled: true, changed: true } : { settled: true };
  };
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.equal(r.finalPath, "/acct/webhooks");
  // The click said nothing moved; the state Jev sees says otherwise, because the page did move.
  assert.deepEqual(calls.settle[1], { after: "click", navigated: false });
  assert.deepEqual(calls.ask[2].state.recent_actions, [
    { control: 'link "Webhooks"', destination: "/acct/webhooks", page_changed: true },
  ]);
});

test("goal: a settle that cannot tell leaves page_changed as the click reported it", async () => {
  const { deps, calls } = harness(
    [home(), webhooks],
    [
      stepReply({ choice: "u2", probs: { u1: 0.03, u2: 0.95, none: 0.02 } }),
      guardReply(0.04),
      stepReply({ choice: "none", probs: { none: 1 } }),
    ],
  );
  // No `changed` at all: the pre-click fingerprint failed, so the settle has no opinion.
  deps.settle = async (hint) => {
    calls.settle.push(hint);
    return { settled: true };
  };
  await runGoal(deps, OPTS);
  assert.deepEqual(calls.ask[2].state.recent_actions, [
    { control: 'link "Webhooks"', destination: "/acct/webhooks", page_changed: true },
  ]);
});

test("goal: a covered click that changed nothing hands back naming the overlay", async () => {
  const menu = home({ elements: [el("u2", "Webhooks", { href: "/acct/webhooks" })], go: {} });
  const { deps, calls } = harness(
    [menu],
    [stepReply({ choice: "u2", probs: { u2: 0.95, none: 0.05 } }), guardReply(0.03)],
  );
  deps.click = async (uid) => {
    calls.click.push(uid);
    return { navigated: false, occludedBy: 'div "cookie-consent" text "We use cookies"' };
  };
  deps.settle = async (hint) => {
    calls.settle.push(hint);
    return hint.after === "click" ? { settled: true, changed: false } : { settled: true };
  };
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /covered by div "cookie-consent"/);
  assert.match(r.reason, /dismiss that overlay/);
  // It stopped at once rather than spending the rest of the budget behind the modal.
  assert.equal(calls.click.length, 1);
  assert.match(r.steps[0].action, /covered by/);
});

test("goal: a covered click that DID change the page is not treated as blocked", async () => {
  // An overlay can sit over a control and the click still work. Only "covered AND nothing
  // moved" is evidence of a modal holding the page.
  const { deps, calls } = harness(
    [home(), webhooks],
    [
      stepReply({ choice: "u2", probs: { u1: 0.03, u2: 0.95, none: 0.02 } }),
      guardReply(0.04),
      stepReply({ done: 0.9, choice: "w1", probs: { w1: 0.6, none: 0.4 } }),
    ],
  );
  const click = deps.click;
  deps.click = async (uid) => ({ ...(await click(uid)), occludedBy: 'div "toast"' });
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "done");
  assert.equal(calls.click.length, 1);
});

test("goal: the page moving between observation and click hands back without clicking", async () => {
  const { deps, calls } = harness(
    [home(), webhooks],
    [stepReply({ choice: "u2", probs: { u1: 0.03, u2: 0.95, none: 0.02 } }), guardReply(0.04)],
  );
  let looks = 0;
  const observed = deps.page;
  // The observation sees home; the freshness look right before the click sees a redirect.
  deps.page = async () => (++looks === 2 ? { url: `https://${HOST}/acct/relogin`, title: "Session" } : observed());
  const r = await runGoal(deps, OPTS);
  assert.equal(r.outcome, "handback");
  assert.match(r.reason, /moved from \/acct\/home to \/acct\/relogin/);
  assert.equal(r.steps[0].action, "stopped: page moved");
  assert.equal(calls.click.length, 0);
});

test("goal: expect verifies the finish in code - met in the text, or in the URL", async () => {
  const done = stepReply({ done: 0.93, choice: "none", probs: { none: 1 } });
  const arrived = { ...webhooks, text: "Webhooks - 3 endpoints configured" };
  for (const [expect, where] of [
    ["endpoints CONFIGURED", "text"],
    ["/acct/webhooks", "url"],
  ]) {
    const { deps } = harness([arrived], [done]);
    const r = await runGoal(deps, { ...OPTS, expect });
    assert.equal(r.outcome, "done", where);
    assert.equal(r.verified, "expect", where);
    assert.match(r.reason, /is on the page/);
    assert.equal(r.steps[0].action, "goal reached, verified");
  }
});

test("goal: expect not met hands back even though Jev said done", async () => {
  const { deps, calls } = harness(
    [{ ...webhooks, text: "Webhooks - 3 endpoints configured" }],
    [stepReply({ done: 0.93, choice: "none", probs: { none: 1 } })],
  );
  const r = await runGoal(deps, { ...OPTS, expect: "Sitemaps" });
  assert.equal(r.outcome, "handback");
  assert.equal(r.verified, null);
  assert.match(r.reason, /done=0\.93.*"Sitemaps" is not in the URL or visible text/);
  assert.equal(calls.click.length, 0);
});

test("financial hosts match on registrable domain, subdomains included, lookalikes not", () => {
  for (const host of [
    "dashboard.stripe.com",
    "app.mercury.com",
    "dashboard.plaid.com",
    "pocketbuddy.org",
    "ehxr.fa.us2.oraclecloud.com",
    "fa-evii-saasfaprod1.fa.ocs.oraclecloud.com",
    "sam.gov",
  ]) {
    assert.equal(isFinancialHost(host), true, host);
  }
  for (const host of ["search.google.com", "app.hubspot.com", "notstripe.com"]) {
    assert.equal(isFinancialHost(host), false, host);
  }
});

test("listing a financial host makes the whole allowlist an error, not a partial list", () => {
  const dir = mkdtempSync(join(tmpdir(), "zen-jev-config-"));
  const previous = process.env.ZEN_MCP_JEV_CONFIG;
  try {
    const file = join(dir, "jev.json");
    writeFileSync(file, JSON.stringify({ hosts: ["search.google.com", "app.mercury.com"] }));
    process.env.ZEN_MCP_JEV_CONFIG = file;
    const config = loadJevConfig();
    assert.match(config.error ?? "", /"app\.mercury\.com" is a financial site/);
    assert.equal(config.hosts.size, 0);
    assert.throws(() => requireJevHost(config, "search.google.com"), /malformed/);
  } finally {
    if (previous === undefined) delete process.env.ZEN_MCP_JEV_CONFIG;
    else process.env.ZEN_MCP_JEV_CONFIG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a financial host is refused even by a config that somehow contains it", () => {
  const config = { path: "(test)", present: true, hosts: new Set(["dashboard.stripe.com"]), error: null };
  assert.throws(() => requireJevHost(config, "dashboard.stripe.com"), /financial site - navigate_goal never sends financial data/);
});
