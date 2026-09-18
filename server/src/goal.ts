import { normalizeUrl, redactText } from "@zen-mcp/shared/nav-redact";
import { ZenToolError } from "./errors.js";
import { INTERACTIVE_MAX_LIMIT, type InteractiveCollection, type InteractiveElement } from "./interactive.js";
import type { JevChoiceAnswer, JevNoulAnswer, JevQuestion, JevResponse } from "./jev.js";

/**
 * navigate_goal: reach a read-only destination with Jev choosing each click.
 *
 * The division of labor is the whole design:
 *   - CODE decides what is eligible (controls that navigate or reveal, never fields,
 *     toggles, or action-word labels), enforces the host allowlist, and owns every stop rule.
 *   - JEV makes the judgments code cannot: which control moves toward the goal, whether the
 *     goal is already reached, whether this is a sign-in wall, whether a chosen control
 *     could change anything.
 * A probability never overrules a rule. A low one only ever stops the loop.
 *
 * Every dependency is injected, so the loop is testable without a browser or the network.
 */

export const GOAL_DEFAULT_MAX_STEPS = 5;
export const GOAL_MAX_STEPS = 10;
export const GOAL_DEFAULT_MIN_CONFIDENCE = 0.6;
export const DONE_THRESHOLD = 0.8;
export const AUTH_WALL_THRESHOLD = 0.7;
// Deliberately low: a false stop costs one hand-back, a false click can cost a client.
export const MUTATION_THRESHOLD = 0.3;
export const NONE_OPTION = "none";

// Kinds that navigate, open, or reveal. Fields, toggles, options and sliders change state.
const NAVIGATION_KINDS = new Set(["link", "button", "tab", "menuitem", "treeitem", "clickable"]);

// Withheld before Jev ever sees them. Jev's mutation check is the second line, not the only one.
export const ACTION_WORDS =
  /\b(delete|remove|destroy|discard|pay|purchase|buy|checkout|send|submit|save|confirm|publish|deploy|revoke|disable|deactivate|enable|activate|archive|transfer|approve|reject|refund|charge|cancel|unsubscribe|sign out|log ?out|reset|rotate|regenerate|create|invite|upgrade|downgrade)\b/i;

export interface GoalPage {
  url: string;
  title: string;
}

/**
 * Why the loop is waiting. The first look at a page earns a real quiet window; after a click
 * the wait is only as long as the page needs to react (a navigation is already committed by
 * the time the click RPC returns, a same-page click needs a beat for menus and panels).
 */
export type SettleHint = { after: "start" } | { after: "click"; navigated: boolean };

export interface GoalDeps {
  page(): Promise<GoalPage>;
  /**
   * Resolves once the page stopped re-rendering (`settled: false` if it never did). `detail`
   * is a short human note on where the time went, for the trace.
   */
  settle(hint: SettleHint): Promise<{ settled: boolean; detail?: string }>;
  elements(pageUrl: string): Promise<InteractiveCollection>;
  click(uid: string): Promise<{ navigated: boolean }>;
  ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResponse>;
  /** Throws when this host's data may not be sent. Re-checked every step: a click can leave the host. */
  allowHost(host: string | null): void;
}

export interface GoalOptions {
  goal: string;
  maxSteps: number;
  minConfidence: number;
  /**
   * Code-owned finish check: after Jev judges the goal reached, this must appear in the final
   * URL or visible text (case-insensitive) or the run hands back. Without it, "done" is Jev's
   * word alone, and the trace says so.
   */
  expect?: string;
}

export interface RecentAction {
  control: string;
  destination: string | null;
  page_changed: boolean;
}

export const RECENT_ACTIONS_MAX = 10;

export interface GoalPick {
  uid: string;
  kind: string;
  label: string;
  context: string;
  probability: number;
  confidence: number;
}

export interface GoalStep {
  n: number;
  path: string;
  settled: boolean;
  found: number;
  offered: number;
  /** Time spent waiting for the page before this step's observation. */
  settleMs: number;
  settleDetail?: string;
  withheld: number;
  done: number;
  authWall: number;
  pick?: GoalPick;
  mutates?: number;
  requests: number;
  jevMs: number;
  tokens: number;
  action: string;
}

export interface GoalAlternative {
  uid: string;
  label: string;
  probability: number;
}

export interface GoalResult {
  outcome: "done" | "handback";
  reason: string;
  /** How "done" was established: by code against `expect`, or by Jev's judgment alone. */
  verified: "expect" | "jev" | null;
  steps: GoalStep[];
  clicks: number;
  totalMs: number;
  finalUrl: string;
  finalPath: string;
  alternatives: GoalAlternative[];
}

function eligible(el: InteractiveElement): boolean {
  if (!NAVIGATION_KINDS.has(el.kind)) return false;
  if (!el.label && !el.href) return false;
  // Clicking it would leave the allowlisted host and end the run anyway - and account
  // menus live here ("Google Account: <name> (<email>)"), so never offering them keeps
  // them out of the request too.
  if (el.offHost) return false;
  return !ACTION_WORDS.test(el.label);
}

/**
 * Every page-derived string goes through the same redaction nav-memory uses (emails, JWTs,
 * UUIDs, keys, long digit runs) before it can leave the machine. Labels are what Jev needs;
 * "<email>" in place of an address costs it nothing.
 */
const safe = (value: string): string => redactText(value);

function controlText(el: InteractiveElement): string {
  return `${el.kind} "${safe(el.label)}"`;
}

function describe(el: InteractiveElement): string {
  const parts = [controlText(el)];
  if (el.href) parts.push(`goes to ${safe(el.href)}`);
  if (el.context) parts.push(`in ${safe(el.context)}`);
  if (el.selected) parts.push("currently selected");
  return parts.join(", ");
}

function noul(reply: JevResponse, id: string): number {
  return (reply.answers[id] as JevNoulAnswer).noul;
}

function fmt(p: number): string {
  return p.toFixed(2);
}

function charge(step: GoalStep, reply: JevResponse): void {
  step.requests += 1;
  step.jevMs += reply.latencyMs;
  step.tokens += reply.usage.input_tokens + reply.usage.output_tokens;
}

function stepQuestions(candidates: InteractiveElement[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    done: {
      type: "noul",
      instructions:
        "Has `goal` already been reached? Judge from `page`: its title, path, headings and selected controls, and `arrived_via` - the control just clicked to get here and where it pointed. Arriving at the destination a goal-matching control pointed to counts as reaching it.",
      criteria: {
        true: "The current page is the destination the goal describes",
        false: "The destination is somewhere else, or the evidence does not show it",
      },
    },
    auth_wall: {
      type: "noul",
      instructions:
        "Is `page` a sign-in, account chooser, password, two-step verification, or re-authentication screen?",
    },
  };
  // A Choice needs real options; with nothing eligible, only done/auth_wall are worth asking.
  if (candidates.length > 0) {
    const criteria: Record<string, string> = {};
    for (const el of candidates) criteria[el.uid] = describe(el);
    criteria[NONE_OPTION] =
      "None of these: no listed control moves toward the goal, or reaching it needs typing, a form, or a change rather than a click";
    questions.next = {
      type: "choice",
      instructions:
        "Which ONE control should be clicked next to make progress toward `goal` from the current `page`? Prefer a control whose label or destination names where the goal is going. Avoid repeating anything in `clicked_so_far` unless the page has clearly changed.",
      criteria,
    };
  }
  return questions;
}

export async function runGoal(deps: GoalDeps, options: GoalOptions): Promise<GoalResult> {
  const started = Date.now();
  const steps: GoalStep[] = [];
  const recentActions: RecentAction[] = [];
  let arrivedVia: { control: string; destination: string | null } | null = null;
  let settleHint: SettleHint = { after: "start" };
  let clicks = 0;
  let lastPickKey = "";
  let finalUrl = "";
  let finalPath = "/";

  const finish = (
    outcome: GoalResult["outcome"],
    reason: string,
    alternatives: GoalAlternative[] = [],
    verified: GoalResult["verified"] = null,
  ): GoalResult => ({
    outcome,
    reason,
    verified,
    steps,
    clicks,
    totalMs: Date.now() - started,
    finalUrl,
    finalPath,
    alternatives,
  });

  for (let n = 1; ; n++) {
    try {
      const settleStarted = Date.now();
      const { settled, detail: settleDetail } = await deps.settle(settleHint);
      const settleMs = Date.now() - settleStarted;
      const page = await deps.page();
      const normalized = normalizeUrl(page.url);
      const host = normalized?.host ?? null;
      finalUrl = page.url;
      finalPath = normalized?.path ?? "/";
      try {
        deps.allowHost(host);
      } catch (err) {
        if (clicks === 0) throw err;
        return finish("handback", `the last click left the allowlist: ${(err as Error).message}`);
      }

      const collection = await deps.elements(page.url);
      const allowed = collection.elements.filter(eligible);
      const candidates = allowed.slice(0, INTERACTIVE_MAX_LIMIT);
      const byUid = new Map(candidates.map((el) => [el.uid, el]));
      const step: GoalStep = {
        n,
        path: finalPath,
        settled,
        found: collection.total,
        offered: candidates.length,
        settleMs,
        ...(settleDetail ? { settleDetail } : {}),
        withheld: collection.elements.length - allowed.length,
        done: 0,
        authWall: 0,
        requests: 0,
        jevMs: 0,
        tokens: 0,
        action: "",
      };
      steps.push(step);

      const state = {
        goal: options.goal,
        page: {
          host,
          path: finalPath,
          title: safe(page.title.replace(/\s+/g, " ").trim().slice(0, 120)),
          headings: collection.headings.map(safe),
          selected: collection.elements.filter((el) => el.selected).slice(0, 5).map(controlText),
          text: safe(collection.text ?? ""),
        },
        arrived_via: arrivedVia,
        // A copy: the state handed to ask must not change under it when the next click lands.
        recent_actions: recentActions.slice(-RECENT_ACTIONS_MAX).map((a) => ({ ...a })),
      };
      const reply = await deps.ask(state, stepQuestions(candidates));
      charge(step, reply);
      step.done = noul(reply, "done");
      step.authWall = noul(reply, "auth_wall");

      if (step.done >= DONE_THRESHOLD) {
        if (options.expect) {
          const needle = options.expect.toLowerCase();
          const met = page.url.toLowerCase().includes(needle) || (collection.text ?? "").toLowerCase().includes(needle);
          if (!met) {
            step.action = "stopped: Jev said done, expectation not met";
            return finish(
              "handback",
              `Jev judged the goal reached (done=${fmt(step.done)}) but ${JSON.stringify(options.expect)} is not in the URL or visible text`,
            );
          }
          step.action = "goal reached, verified";
          return finish("done", `goal reached: ${JSON.stringify(options.expect)} is on the page (done=${fmt(step.done)})`, [], "expect");
        }
        step.action = "goal reached";
        return finish("done", `Jev judged the goal reached (done=${fmt(step.done)}) - Jev's judgment, not verified by code`, [], "jev");
      }
      if (step.authWall >= AUTH_WALL_THRESHOLD) {
        step.action = "stopped: sign-in page";
        return finish(
          "handback",
          `this looks like a sign-in or verification page (auth_wall=${fmt(step.authWall)}) - that needs you, not automation`,
        );
      }
      const next = reply.answers.next as JevChoiceAnswer | undefined;
      if (!next) {
        step.action = "stopped: nothing clickable";
        return finish("handback", "no eligible control on this page (none that navigates without an action word)");
      }
      const alternatives = Object.entries(next.probabilities)
        .filter(([uid]) => uid !== NONE_OPTION)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([uid, probability]) => ({ uid, label: byUid.get(uid)?.label ?? "", probability }));

      if (clicks >= options.maxSteps) {
        step.action = "stopped: step budget spent";
        return finish("handback", `maxSteps (${options.maxSteps}) spent without the goal judged reached`, alternatives);
      }
      if (next.choice === NONE_OPTION) {
        step.action = "stopped: Jev picked none";
        return finish(
          "handback",
          `Jev found no control that moves toward the goal (none=${fmt(next.probabilities[NONE_OPTION] ?? 0)})`,
          alternatives,
        );
      }
      const picked = byUid.get(next.choice);
      if (!picked) {
        step.action = "stopped: unknown pick";
        return finish("handback", `Jev picked "${next.choice}", which was not offered`, alternatives);
      }
      const probability = next.probabilities[next.choice] ?? 0;
      step.pick = {
        uid: picked.uid,
        kind: picked.kind,
        label: picked.label,
        context: picked.context,
        probability,
        confidence: typeof next.confidence === "number" ? next.confidence : probability,
      };
      if (probability < options.minConfidence) {
        step.action = "stopped: low confidence";
        return finish("handback", `best pick was only p=${fmt(probability)} (< ${options.minConfidence})`, alternatives);
      }
      const pickKey = `${finalPath}\u0000${picked.kind}\u0000${picked.label}\u0000${picked.href ?? ""}`;
      if (pickKey === lastPickKey) {
        step.action = "stopped: repeat";
        return finish(
          "handback",
          `would click ${picked.kind} "${picked.label}" again on an unchanged path - stopping instead of looping`,
          alternatives,
        );
      }

      // A separate request: the element under test only exists once the choice is known.
      const guard = await deps.ask(
        {
          element: {
            kind: picked.kind,
            label: safe(picked.label),
            destination: picked.href ? safe(picked.href) : null,
            context: safe(picked.context),
          },
          page: state.page,
        },
        {
          mutates: {
            type: "noul",
            instructions:
              "Could activating `element` create, change, send, pay for, or delete anything, rather than only navigating, opening a view, or revealing information?",
            criteria: {
              true: "It performs or commits an action with side effects",
              false: "It only navigates, opens, expands, filters, or reveals",
            },
          },
        },
      );
      charge(step, guard);
      step.mutates = noul(guard, "mutates");
      if (step.mutates >= MUTATION_THRESHOLD) {
        step.action = "stopped: might change something";
        return finish(
          "handback",
          `${picked.kind} "${picked.label}" might change something (mutates=${fmt(step.mutates)}) - not clicked`,
          alternatives,
        );
      }

      // Freshness: the decision was made about the page as observed. If the tab moved on its
      // own since then (a redirect, a late navigation), the pick is about a page that is gone.
      const before = await deps.page();
      if (before.url !== page.url) {
        step.action = "stopped: page moved";
        return finish(
          "handback",
          `the page moved from ${finalPath} to ${normalizeUrl(before.url)?.path ?? before.url} between observing and clicking - not clicked`,
          alternatives,
        );
      }

      let navigated = false;
      try {
        const clicked = await deps.click(picked.uid);
        navigated = clicked.navigated;
        step.action = navigated ? "clicked, navigated" : "clicked";
      } catch (err) {
        step.action = "click failed";
        return finish("handback", `clicking ${picked.uid} failed (${(err as Error).message}) - the page may have re-rendered`);
      }
      clicks += 1;
      const destination = picked.href ? safe(picked.href) : null;
      recentActions.push({ control: controlText(picked), destination, page_changed: navigated });
      arrivedVia = { control: controlText(picked), destination };
      settleHint = { after: "click", navigated };
      lastPickKey = pickKey;
    } catch (err) {
      // Before any click nothing has happened, so the error is the whole answer. After a
      // click the tab has moved, and the trace of how it got there is worth more than the throw.
      if (clicks === 0) throw err;
      return finish("handback", `stopped on error: ${err instanceof ZenToolError ? err.toToolText() : (err as Error).message}`);
    }
  }
}

export function formatGoalResult(result: GoalResult): string {
  const requests = result.steps.reduce((sum, s) => sum + s.requests, 0);
  const jevMs = result.steps.reduce((sum, s) => sum + s.jevMs, 0);
  const tokens = result.steps.reduce((sum, s) => sum + s.tokens, 0);
  const settleMs = result.steps.reduce((sum, s) => sum + s.settleMs, 0);
  const lines = [
    `navigate_goal ${result.outcome === "done" ? (result.verified === "expect" ? "DONE (verified)" : "DONE (unverified)") : "HANDED BACK"}: ${result.reason}`,
    `${result.clicks} click${result.clicks === 1 ? "" : "s"}, ${(result.totalMs / 1000).toFixed(1)}s total (Jev ${jevMs}ms over ${requests} request${requests === 1 ? "" : "s"}, ${tokens.toLocaleString("en-US")} tokens; waiting on the page ${settleMs}ms) - now at ${result.finalPath}`,
  ];
  for (const s of result.steps) {
    lines.push(
      `step ${s.n} ${s.path}${s.settled ? "" : " (page never settled)"} - waited ${s.settleMs}ms${s.settleDetail ? ` (${s.settleDetail})` : ""} - offered ${s.offered} of ${s.found} controls${s.withheld ? ` (${s.withheld} withheld: fields, toggles, off-host links, action words)` : ""} - Jev ${s.jevMs}ms, ${s.tokens.toLocaleString("en-US")} tok`,
    );
    let detail = `  done=${fmt(s.done)} auth_wall=${fmt(s.authWall)}`;
    if (s.pick) {
      detail += ` pick=${s.pick.uid} ${s.pick.kind} ${JSON.stringify(s.pick.label)} p=${fmt(s.pick.probability)}`;
      if (s.pick.context) detail += ` in ${s.pick.context}`;
    }
    if (s.mutates !== undefined) detail += ` mutates=${fmt(s.mutates)}`;
    lines.push(`${detail} -> ${s.action}`);
  }
  if (result.alternatives.length > 0) {
    lines.push(
      `top candidates: ${result.alternatives.map((a) => `${a.uid} ${JSON.stringify(a.label)} p=${fmt(a.probability)}`).join(" | ")}`,
    );
  }
  if (result.outcome === "handback") {
    lines.push(
      "The tab is left where the last step put it. UIDs above belong to its latest snapshot and still work with click_by_uid.",
    );
  }
  return lines.join("\n");
}
