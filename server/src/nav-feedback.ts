import { Methods, type EvaluateScriptResult, type NavFeedbackEvidence } from "@zen-mcp/shared";
import { isDevHost, matchesPathGlob, normalizeUrl, sanitizeLocator, validPathGlob } from "@zen-mcp/shared/nav-redact";
import type { DaemonClient } from "./daemon-client.js";
import { ZenToolError } from "./errors.js";

export interface FeedbackCheck {
  selector?: string;
  pathGlob?: string;
  present?: boolean;
  state?: "visible" | "enabled" | "checked" | "count" | "value";
  count?: number;
  value?: string;
}

// Assertions execute read-only, in place. The result contains no page prose,
// input values, script source or arbitrary errors in the persistent record.
export async function verifyFeedback(daemon: Pick<DaemonClient, "call">, tabId: number, check: FeedbackCheck, fingerprint?: (url: string) => string | null): Promise<NavFeedbackEvidence> {
  if (Boolean(check.selector) === Boolean(check.pathGlob)) throw new ZenToolError("BAD_INPUT", "provide exactly one of selector or pathGlob");
  if (check.pathGlob && !validPathGlob(check.pathGlob)) throw new ZenToolError("BAD_INPUT", "invalid path glob");
  if (check.selector && (check.selector.length > 160 || !sanitizeLocator(check.selector))) throw new ZenToolError("BAD_INPUT", "invalid CSS selector");
  const state = check.state;
  const validState = state && ["visible", "enabled", "checked", "count", "value"].includes(state);
  if ((state && (!validState || !check.selector || !fingerprint)) ||
      (state === "count" ? !Number.isSafeInteger(check.count) || check.count! < 0 || check.count! > 10_000 || check.present !== undefined || check.value !== undefined :
       state === "value" ? typeof check.value !== "string" || check.value.length > 2000 || check.present !== undefined || check.count !== undefined :
       typeof check.present !== "boolean" || check.count !== undefined || check.value !== undefined)) {
    throw new ZenToolError("BAD_INPUT", "provide one valid assertion: present, state with present, count with count, or value with value");
  }
  const css = JSON.stringify(check.selector);
  let expression = "e !== null";
  if (state === "visible") expression = 'e ? e.getClientRects().length > 0 && getComputedStyle(e).visibility === "visible" && getComputedStyle(e).display !== "none" : null';
  if (state === "enabled") expression = 'e && "disabled" in e ? !e.disabled : null';
  if (state === "checked") expression = 'e && "checked" in e ? e.checked : null';
  // Only a comparison leaves the content process; neither the actual nor the
  // expected field value is returned or saved in the evidence record.
  if (state === "value") expression = `e && "value" in e ? !e.disabled && e.value === ${JSON.stringify(check.value)} : null`;
  if (state === "count") expression = `document.querySelectorAll(${css}).length`;
  const code = check.selector
    ? `var e = document.querySelector(${css}); return { url: location.href, ready: document.readyState, present: ${expression} };`
    : `return { url: location.href, ready: document.readyState };`;
  const result = await daemon.call<EvaluateScriptResult>(Methods.DomEvaluate, { tabId, code });
  const value = result.result as { url?: unknown; ready?: unknown; present?: unknown } | null;
  const location = value && typeof value.url === "string" ? normalizeUrl(value.url) : null;
  if (!location || isDevHost(location.host)) throw new ZenToolError("BAD_INPUT", "feedback requires a live, non-development web page");
  if (value?.ready !== "complete") throw new ZenToolError("STALE", "page is still loading; verify after it settles");
  const observed = check.selector ? value?.present : matchesPathGlob(location.path, check.pathGlob!);
  const expected = state === "count" ? check.count! : state === "value" ? true : check.present!;
  if (observed !== expected) throw new ZenToolError("BAD_INPUT", "live page did not satisfy the feedback assertion; no outcome recorded");
  const pageKey = fingerprint?.(value!.url as string);
  if (state && !pageKey) throw new ZenToolError("BAD_INPUT", "page identity unavailable");
  return {
    host: location.host,
    path: location.path,
    ...(pageKey ? { pageKey } : {}),
    check: state ? "state" : check.selector ? "selector" : "path",
    ...(state ? { state } : {}),
    target: check.selector ? sanitizeLocator(check.selector)! : check.pathGlob!,
    expected,
    observed: observed as boolean | number,
  };
}
