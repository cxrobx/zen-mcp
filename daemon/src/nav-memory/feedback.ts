import { NAV_FEEDBACK_OUTCOMES, type NavFeedbackEvidence, type NavFeedbackRecord, type NavNoteFeedback } from "@zen-mcp/shared";
import { isDevHost, normalizeUrl, sanitizeLocator, validPathGlob } from "@zen-mcp/shared/nav-redact";

export const MAX_FEEDBACK_HISTORY = 64;

export function sanitizeEvidence(raw: unknown): NavFeedbackEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as NavFeedbackEvidence;
  if (typeof p.host !== "string" || typeof p.path !== "string" || p.path.length > 500 || !p.path.startsWith("/")) return null;
  const location = normalizeUrl(`https://${p.host}${p.path}`);
  if (!location || isDevHost(location.host) || location.host !== p.host || location.path !== p.path) return null;
  if (p.observed !== p.expected || typeof p.target !== "string") return null;
  if (p.pageKey !== undefined && !/^[0-9a-f]{64}$/.test(p.pageKey)) return null;
  const identity = p.pageKey ? { pageKey: p.pageKey } : {};
  if (p.check === "path") {
    if (typeof p.expected !== "boolean" || !validPathGlob(p.target)) return null;
    return { host: location.host, path: location.path, ...identity, check: p.check, target: p.target, expected: p.expected, observed: p.observed };
  }
  if (p.check === "state") {
    if (!p.pageKey || !p.state || !["visible", "enabled", "checked", "count", "value"].includes(p.state)) return null;
    if (p.state === "count" ? !Number.isSafeInteger(p.expected) || Number(p.expected) < 0 || Number(p.expected) > 10_000 : typeof p.expected !== "boolean") return null;
  } else if (p.check !== "selector" || typeof p.expected !== "boolean") return null;
  const target = sanitizeLocator(p.target);
  return target ? { host: location.host, path: location.path, ...identity, check: p.check, ...(p.check === "state" ? { state: p.state } : {}), target, expected: p.expected, observed: p.observed } : null;
}

export function normalizeFeedback(raw: unknown): NavNoteFeedback | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const p = raw as NavNoteFeedback;
  if (![p.confirmed, p.contradicted, p.obsolete].every(n => Number.isSafeInteger(n) && n >= 0) ||
      !["active", "suspect", "obsolete"].includes(p.status) || !Array.isArray(p.history)) return undefined;
  const history: NavFeedbackRecord[] = [];
  for (const record of p.history.slice(-MAX_FEEDBACK_HISTORY)) {
    if (!record || !/^[0-9a-f]{64}$/.test(record.session) || !Number.isFinite(Date.parse(record.at)) ||
        !NAV_FEEDBACK_OUTCOMES.includes(record.outcome)) continue;
    const evidence = sanitizeEvidence(record.evidence);
    if (evidence) history.push({ session: record.session, at: record.at, outcome: record.outcome, evidence });
  }
  return { confirmed: p.confirmed, contradicted: p.contradicted, obsolete: p.obsolete, status: p.status, history };
}
