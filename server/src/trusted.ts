// Opt-in trusted input (T299): one real OS-level click, for controls that ignore synthetic
// (isTrusted:false) events — Material dropdowns, buttons that open a popup window.
//
// Costs, which is why nothing reaches here without `trusted: true`: the tab and its window are
// brought to the front, the real cursor moves for a moment (and is put back), and the helper
// needs macOS Accessibility. The flow:
//   1. remember the frontmost app (to hand focus back afterwards)
//   2. extension: focus the window, activate the tab, scroll the element in, report its point
//   3. extension again, no scroll: the same element must still be painted at the same point,
//      the tab still active and its window focused
//   4. helper: frontmost app must be Zen and the window under the point Zen's, then click
// Any miss refuses with the reason and clicks nothing.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type GetPageResult,
  type LocatorSpec,
  Methods,
  type PageInfo,
  type PagesListResult,
  type TrustedPointResult,
} from "@zen-mcp/shared";
import type { DaemonClient } from "./daemon-client.js";
import { ZenToolError } from "./errors.js";

const ZEN_BUNDLE_ID = "app.zen-browser.zen";
const HELPER_TIMEOUT_MS = 10_000;
// Two reads of the point a few hundred ms apart may differ by sub-pixel layout; anything
// more means the page moved, and the click would land somewhere else.
const MAX_DRIFT_PX = 2;

export function helperPath(): string {
  return (
    process.env.ZEN_MCP_INPUT_HELPER ??
    fileURLToPath(new URL("../../native/build/zen-mcp-input", import.meta.url))
  );
}

function runHelper(args: string[]): Promise<Record<string, unknown>> {
  const bin = helperPath();
  if (!existsSync(bin)) {
    throw new ZenToolError(
      "BAD_PERMS",
      `trusted input helper not built (${bin})`,
      "Run native/build.sh in the zen-mcp repo, then grant it Accessibility when macOS asks.",
    );
  }
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: HELPER_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        reject(new ZenToolError("UPSTREAM", `trusted input helper failed: ${stderr || err.message}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
      } catch {
        reject(new ZenToolError("UPSTREAM", `trusted input helper printed non-JSON: ${stdout}`));
      }
    });
  });
}

export type TrustedTarget = { uid: string } | { locator: LocatorSpec };

export interface TrustedClickResult {
  matchedTag?: string;
  url: string;
  title: string;
  restoredFocus: boolean;
  /** Tabs or popup windows that appeared during the click (a `window.open`, a `_blank` link). */
  opened: PageInfo[];
}

// Tab ids are dense and increasing, so whatever a click opens gets an id above the highest
// one that existed before it, in any window or Zen workspace. includeHidden is what reaches
// the other workspaces; it costs one id probe pass, acceptable for an opt-in action.
async function highestTabId(daemon: DaemonClient): Promise<number> {
  const r = await daemon.call<PagesListResult>(Methods.PagesList, { includeHidden: true });
  return r.pages.reduce((max, p) => Math.max(max, p.tabId), 0);
}

const OPENED_PROBE = 6;

async function tabsOpenedAfter(daemon: DaemonClient, above: number): Promise<PageInfo[]> {
  const found: PageInfo[] = [];
  for (let id = above + 1; id <= above + OPENED_PROBE; id++) {
    const r = await daemon.call<GetPageResult>(Methods.PagesGet, { tabId: id }).catch(() => null);
    if (r?.page) found.push(r.page);
  }
  return found;
}

function refusal(where: string, r: TrustedPointResult, action: "click" | "key" = "click"): ZenToolError {
  const why =
    r.reason === "covered"
      ? `something else is painted over it (${r.coveredBy ?? "?"})`
      : r.reason === "not_visible"
        ? "it matched but nothing visible (0px or off-screen)"
        : r.reason === "not_found"
          ? "no element matched"
          : r.reason === "tab_not_active"
            ? "the tab is not the active one"
            : r.reason === "window_not_focused"
              ? "the browser window is not focused"
              : r.reason === "ambiguous"
                ? `the uid's selector matches ${r.matches ?? "several"} elements, so the click could land on the wrong one (take a fresh snapshot)`
                : (r.reason ?? "unknown");
  return new ZenToolError(
    r.reason === "not_found" ? "NOT_FOUND" : "STALE",
    `trusted ${action} refused at ${where}: ${why}. Nothing was ${action === "click" ? "clicked" : "pressed"}.`,
  );
}

export async function trustedClick(
  daemon: DaemonClient,
  tabId: number,
  target: TrustedTarget,
  timeoutMs?: number,
): Promise<TrustedClickResult> {
  const before = await runHelper(["front"]);
  const highestBefore = await highestTabId(daemon);
  const priorPid = typeof before.pid === "number" ? before.pid : 0;
  const restorePid = before.bundleId === ZEN_BUNDLE_ID ? 0 : priorPid;

  // Focus settles asynchronously (a window that just closed, a Zen space switch), so a
  // prepare refused only for focus is retried; every other refusal is final.
  let first: TrustedPointResult = { ok: false };
  for (let attempt = 0; attempt < 4; attempt++) {
    first = await daemon.call<TrustedPointResult>(Methods.DomTrustedPoint, {
      tabId,
      ...target,
      activate: true,
      scroll: attempt === 0,
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    });
    if (first.ok || (first.reason !== "window_not_focused" && first.reason !== "tab_not_active")) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!first.ok) throw refusal("prepare", first);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const check = await daemon.call<TrustedPointResult>(Methods.DomTrustedPoint, {
    tabId,
    ...target,
    activate: false,
    scroll: false,
    timeoutMs: 1_000,
  });
  if (!check.ok) throw refusal("final check", check);
  const drift = Math.hypot((check.screenX ?? 0) - (first.screenX ?? 0), (check.screenY ?? 0) - (first.screenY ?? 0));
  if (drift > MAX_DRIFT_PX) {
    throw new ZenToolError("STALE", `trusted click refused: the element moved ${drift.toFixed(1)}px between checks. Nothing was clicked.`);
  }

  const fired = await runHelper([
    "click",
    "--x", String(check.screenX),
    "--y", String(check.screenY),
    "--dpr", String(check.devicePixelRatio ?? 1),
    "--expect-bundle", ZEN_BUNDLE_ID,
    ...(restorePid ? ["--restore-pid", String(restorePid)] : []),
  ]);
  if (fired.ok !== true) {
    const reason = String(fired.reason ?? "unknown");
    const hint = typeof fired.hint === "string" ? fired.hint : undefined;
    const detail = fired.coveredBy ? ` (${String(fired.coveredBy)})` : fired.frontmost ? ` (frontmost: ${String(fired.frontmost)})` : "";
    throw new ZenToolError(
      reason === "accessibility_not_granted" ? "BAD_PERMS" : "STALE",
      `trusted click refused by the helper: ${reason}${detail}. Nothing was clicked.`,
      hint,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  return {
    ...(check.matchedTag ? { matchedTag: check.matchedTag } : {}),
    url: check.url ?? "",
    title: check.title ?? "",
    restoredFocus: fired.restoredFocus === true,
    opened: await tabsOpenedAfter(daemon, highestBefore),
  };
}

export interface TrustedKeyResult {
  url: string;
  title: string;
  restoredFocus: boolean;
}

/**
 * One real key press (or combo) into the tab. With a target, a trusted click on it first,
 * which is how a person focuses a field; without one, the tab is only brought to the front
 * and the key goes to whatever already has focus there. Refused combos: Cmd+Q, Cmd+Opt+Esc.
 */
export async function trustedKey(
  daemon: DaemonClient,
  tabId: number,
  key: string,
  mods: string[],
  target?: TrustedTarget,
  timeoutMs?: number,
): Promise<TrustedKeyResult> {
  const before = await runHelper(["front"]);
  const restorePid = before.bundleId === ZEN_BUNDLE_ID ? 0 : typeof before.pid === "number" ? before.pid : 0;
  let page: TrustedPointResult = { ok: false };
  if (target) {
    await trustedClick(daemon, tabId, target, timeoutMs);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    page = await daemon.call<TrustedPointResult>(Methods.DomTrustedPoint, {
      tabId,
      activate: true,
      scroll: false,
    });
    if (page.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!page.ok) throw refusal("prepare", page, "key");
  const fired = await runHelper([
    "key",
    "--key", key,
    ...(mods.length ? ["--mods", mods.join(",")] : []),
    "--expect-bundle", ZEN_BUNDLE_ID,
    ...(restorePid ? ["--restore-pid", String(restorePid)] : []),
  ]);
  if (fired.ok !== true) {
    const reason = String(fired.reason ?? "unknown");
    throw new ZenToolError(
      reason === "accessibility_not_granted" ? "BAD_PERMS" : reason === "wrong_frontmost_app" ? "STALE" : "BAD_INPUT",
      `trusted key refused by the helper: ${reason}${fired.frontmost ? ` (frontmost: ${String(fired.frontmost)})` : ""}. Nothing was pressed.`,
      typeof fired.hint === "string" ? fired.hint : undefined,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { url: page.url ?? "", title: page.title ?? "", restoredFocus: fired.restoredFocus === true };
}

/** XPath string literal for arbitrary text (XPath 1.0 has no escapes). */
export function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat(${s.split("'").map((part) => `'${part}'`).join(`, "'", `)})`;
}
