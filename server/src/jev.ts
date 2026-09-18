import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeHost, registrableDomain } from "@zen-mcp/shared/nav-redact";
import { ZenToolError } from "./errors.js";

/**
 * TypeSafe System One ("Jev") client, and the host allowlist that gates it.
 *
 * Jev returns typed judgments - a Choice with a probability per option, a Noul (probability
 * of yes) - in a few hundred milliseconds. navigate_goal uses it to pick the next click so
 * the calling model is not consulted once per step.
 *
 * Everything sent here LEAVES THIS MACHINE: the goal, the page title and path, and the
 * labels of the page's controls. On Mercury, Gmail or Stripe those labels are customer
 * names. That is why the allowlist fails closed, on the same doctrine as fill_secret and the
 * container table: an absent file means "not enabled", a malformed file is a loud error,
 * and neither is ever read as allow-all. Nothing is sent before the host check passes.
 */

export const JEV_KEY_NAME = "TYPESAFE_API_KEY";
export const JEV_MODEL = "jev-latest";
const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 600;

/**
 * Financial data never goes to TypeSafe (Chris's decision, 2026-09-16) - not "unless
 * allowlisted", never. Matched on registrable domain so every subdomain is covered, and
 * enforced twice: listing one makes the whole allowlist a loud error, and requireJevHost
 * refuses one regardless. Extend this set; never add an override.
 */
export const FINANCIAL_DOMAINS: ReadonlySet<string> = new Set([
  // Banking, payments and money movement Chris uses
  "stripe.com",
  "mercury.com",
  "plaid.com",
  // His personal-finance app (budgets, accounts, net worth)
  "pocketbuddy.org",
  // Oracle Fusion Financials supplier portals (tax ids, bank details)
  "oraclecloud.com",
  // Federal registrations carrying EFT banking details, and tax filing
  "sam.gov",
  "irs.gov",
  "eftps.gov",
  // Common rails and institutions, so an accidental listing fails closed
  "paypal.com",
  "wise.com",
  "brex.com",
  "ramp.com",
  "gusto.com",
  "intuit.com",
  "coinbase.com",
  "chase.com",
  "bankofamerica.com",
  "wellsfargo.com",
  "capitalone.com",
  "americanexpress.com",
  "fidelity.com",
  "schwab.com",
  "vanguard.com",
  "robinhood.com",
]);

export function isFinancialHost(host: string): boolean {
  const domain = registrableDomain(host) ?? host;
  return FINANCIAL_DOMAINS.has(domain);
}

export function jevConfigPath(): string {
  return process.env.ZEN_MCP_JEV_CONFIG ?? join(homedir(), ".config", "zen-mcp", "jev.json");
}

export interface JevConfig {
  path: string;
  present: boolean;
  hosts: Set<string>;
  error: string | null;
}

/** Read on every call: the file is tiny, and an edit should apply without a restart. */
export function loadJevConfig(): JevConfig {
  const path = jevConfigPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, present: false, hosts: new Set(), error: null };
    }
    return { path, present: true, hosts: new Set(), error: (err as Error).message };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { hosts?: unknown }).hosts)) {
      return { path, present: true, hosts: new Set(), error: 'expected {"hosts": ["exact.host", ...]}' };
    }
    const hosts = new Set<string>();
    for (const entry of (parsed as { hosts: unknown[] }).hosts) {
      const host = typeof entry === "string" ? normalizeHost(entry) : null;
      if (!host || typeof entry !== "string" || host !== entry.trim().toLowerCase()) {
        return {
          path,
          present: true,
          hosts: new Set(),
          error: `${JSON.stringify(entry)} is not a bare host (no scheme, path, port, or wildcard)`,
        };
      }
      if (isFinancialHost(host)) {
        return {
          path,
          present: true,
          hosts: new Set(),
          error: `"${host}" is a financial site, and financial data is never sent to TypeSafe - remove it`,
        };
      }
      hosts.add(host);
    }
    return { path, present: true, hosts, error: null };
  } catch (err) {
    return { path, present: true, hosts: new Set(), error: (err as Error).message };
  }
}

export function requireJevHost(config: JevConfig, host: string | null): void {
  // First, and independent of the file: no configuration can make a financial site eligible.
  if (host && isFinancialHost(host)) {
    throw new ZenToolError(
      "BAD_PERMS",
      `"${host}" is a financial site - navigate_goal never sends financial data to TypeSafe`,
      "Nothing was sent. Drive this page directly with interactive_elements and click_by_uid instead.",
    );
  }
  if (config.error) {
    throw new ZenToolError(
      "BAD_INPUT",
      `Jev allowlist ${config.path} is malformed: ${config.error}`,
      "Nothing was sent to TypeSafe. A broken allowlist is never read as empty or as allow-all - fix the file.",
    );
  }
  if (!config.present) {
    throw new ZenToolError(
      "BAD_PERMS",
      `navigate_goal is not enabled: ${config.path} does not exist`,
      'Nothing was sent to TypeSafe. Create it as {"hosts": ["exact.host"]}, listing only hosts whose control labels may leave this machine.',
    );
  }
  if (!host || !config.hosts.has(host)) {
    const allowed = [...config.hosts].sort().join(", ") || "(none)";
    throw new ZenToolError(
      "BAD_PERMS",
      `host "${host ?? "(unparseable)"}" is not in the Jev allowlist ${config.path}`,
      `Nothing was sent to TypeSafe. Allowed: ${allowed}. Matching is exact-host - add a host only if its control labels (which can include customer names) may leave this machine.`,
    );
  }
}

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> };

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
}

function statusHint(status: number): string {
  if (status === 401) return `The API key was rejected. Re-store it with sk ${JEV_KEY_NAME}.`;
  if (status === 429 || status === 529) return "TypeSafe is rate limiting or overloaded; retry in a moment.";
  if (status === 400 || status === 422) return "The request was malformed - a navigate_goal bug, not a page problem.";
  return "TypeSafe returned an unexpected status.";
}

function checkShape(body: unknown, questions: Record<string, JevQuestion>): JevResponse {
  const r = body as Partial<JevResponse> | null;
  if (!r || typeof r !== "object" || !r.answers || typeof r.answers !== "object") {
    throw new ZenToolError("UPSTREAM", "TypeSafe response had no answers object");
  }
  for (const [id, question] of Object.entries(questions)) {
    const answer = r.answers[id] as JevAnswer | undefined;
    const valid =
      answer?.type === question.type &&
      (answer.type === "noul"
        ? typeof answer.noul === "number"
        : typeof answer.choice === "string" && typeof answer.probabilities === "object");
    if (!valid) {
      throw new ZenToolError("UPSTREAM", `TypeSafe response is missing a valid "${id}" ${question.type} answer`);
    }
  }
  return {
    model: typeof r.model === "string" ? r.model : "unknown",
    answers: r.answers,
    usage: {
      input_tokens: r.usage?.input_tokens ?? 0,
      output_tokens: r.usage?.output_tokens ?? 0,
    },
    latencyMs: 0,
  };
}

/**
 * Open the TLS connection to TypeSafe ahead of the first real request. Node's fetch pools
 * connections per origin, so a throwaway request during the page's first settle turns the
 * measured ~700ms cold first request into a warm ~200ms one. Nothing page-derived is sent;
 * the result is ignored and a failure here is not an error (the real request reports its own).
 */
export function warmJev(apiKey: string): void {
  const endpoint = process.env.ZEN_MCP_TYPESAFE_URL ?? DEFAULT_ENDPOINT;
  fetch(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(5_000),
  })
    .then((r) => r.body?.cancel())
    .catch(() => undefined);
}

/**
 * Diagnostic trace of what leaves the machine: when ZEN_MCP_JEV_TRACE names a file, every
 * request body and answer set is appended as one JSON line. Bodies are already redacted
 * (that is the caller's contract), so the file is safe to read but still off by default.
 */
function traceJev(record: Record<string, unknown>): void {
  const path = process.env.ZEN_MCP_JEV_TRACE;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch {
    // A trace that cannot be written must never fail the run.
  }
}

/**
 * One System One request. Questions in a request are answered independently and in
 * parallel, so everything that can be asked of the same state belongs in one call.
 * 429/529 get a single delayed retry; anything else fails loudly on the first try.
 */
export async function askJev(
  apiKey: string,
  state: unknown,
  questions: Record<string, JevQuestion>,
  options: { timeoutMs?: number } = {},
): Promise<JevResponse> {
  const endpoint = process.env.ZEN_MCP_TYPESAFE_URL ?? DEFAULT_ENDPOINT;
  const body = JSON.stringify({ model: JEV_MODEL, state, questions });
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError";
      throw new ZenToolError(
        timedOut ? "TIMEOUT" : "UPSTREAM",
        timedOut
          ? `TypeSafe did not answer within ${(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`
          : `TypeSafe request failed: ${(err as Error).message}`,
      );
    }
    if ((response.status === 429 || response.status === 529) && attempt === 1) {
      await response.body?.cancel();
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ZenToolError(
        "UPSTREAM",
        `TypeSafe returned HTTP ${response.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}`,
        statusHint(response.status),
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ZenToolError("UPSTREAM", "TypeSafe returned a non-JSON body");
    }
    const result = checkShape(parsed, questions);
    result.latencyMs = Date.now() - started;
    traceJev({ latencyMs: result.latencyMs, usage: result.usage, state, questions, answers: result.answers });
    return result;
  }
}
