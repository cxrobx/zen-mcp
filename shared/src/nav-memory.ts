export const NAV_NOTE_KINDS = [
  "selector",
  "iframe-quirk",
  "timing",
  "auth-flow",
  "workflow",
  "anti-pattern",
  "url-pattern",
  "tool-tip",
] as const;

export type NavNoteKind = (typeof NAV_NOTE_KINDS)[number];

export const NAV_NOTE_CAPS = {
  summary: 140,
  detail: 500,
  example: 300,
  pathGlob: 200,
  locator: 160,
} as const;

export interface NavNoteSource {
  seed?: boolean;
  seedVersion?: number;
  container?: string;
  sessionTs?: string;
  workId?: string;
}

export interface NavNote {
  id: string;
  host: string;
  registrableDomain: string | null;
  pathGlob: string | null;
  /** Keyed exact-page identity; redacted path globs are not unique page ids. */
  pageKey?: string;
  observation?: { tool: string; locator: string };
  kind: NavNoteKind;
  summary: string;
  detail: string;
  example: string | null;
  tools: string[];
  success: boolean;
  confidence: number;
  reinforced: number;
  createdAt: string;
  lastSeenAt: string;
  source: NavNoteSource | null;
  embedding: string | null;
  /** Explicit, live-verified outcomes, separate from heuristic ETL reinforcement. */
  feedback?: NavNoteFeedback;
}

export const NAV_FEEDBACK_OUTCOMES = ["confirmed", "contradicted", "obsolete"] as const;
export type NavFeedbackOutcome = (typeof NAV_FEEDBACK_OUTCOMES)[number];
export type NavFeedbackStatus = "active" | "suspect" | "obsolete";

export interface NavFeedbackEvidence {
  host: string;
  path: string;
  pageKey?: string;
  check: "selector" | "path" | "state";
  state?: "visible" | "enabled" | "checked" | "count" | "value";
  target: string;
  expected: boolean | number;
  observed: boolean | number;
}

export interface NavFeedbackRecord {
  session: string;
  at: string;
  outcome: NavFeedbackOutcome;
  evidence: NavFeedbackEvidence;
}

export interface NavNoteFeedback {
  confirmed: number;
  contradicted: number;
  obsolete: number;
  status: NavFeedbackStatus;
  /** Bounded, structural evidence only; no page prose or free-text explanations. */
  history: NavFeedbackRecord[];
}

export interface NavMemoryFeedbackParams {
  id: string;
  outcome: NavFeedbackOutcome;
  evidence: NavFeedbackEvidence;
}

export interface NavMemoryFeedbackResult {
  id: string;
  recorded: boolean;
  feedback: NavNoteFeedback;
}

export interface NavEventRecord {
  ts: number;
  tool: string;
  host?: string;
  path?: string;
  pageKey?: string;
  ok: boolean;
  navigated?: boolean;
  errorCode?: string;
  locator?: string;
  relatedLocator?: string;
  keys?: string;
  waitCondition?: string;
  matchCount?: number;
  role?: string;
  snapshotUids?: number;
  snapshotTruncated?: boolean;
}

export interface NavMemoryQueryParams {
  host: string;
  path?: string;
  pageKey?: string;
  queryText?: string;
  limit?: number;
  full?: boolean;
  excludeIds?: string[];
}

export type NavNoteSummary = Pick<
  NavNote,
  "id" | "host" | "pathGlob" | "kind" | "summary" | "confidence" | "reinforced"
> & { success?: boolean; feedbackStatus?: NavFeedbackStatus };

export interface NavMemoryQueryResult {
  host: string;
  registrableDomain: string | null;
  total: number;
  notes: Array<NavNote | NavNoteSummary>;
}

export interface NavMemoryRecordEventsParams {
  events: NavEventRecord[];
}

export interface NavMemoryRecordEventsResult {
  accepted: number;
  dropped: number;
}

export interface NavMemoryStatsResult {
  notes: number;
  byHost: Record<string, number>;
  byKind: Record<string, number>;
  pending: number;
  processing: number;
  failed: number;
  done: number;
  storeBytes: number;
  embeddings: {
    present: number;
    missing: number;
    model: string;
    dimension: number;
  };
  etl: {
    created: number;
    merged: number;
    consolidated: number;
    lastEtlAt: string | null;
    lastConsolidateAt: string | null;
  };
  suppressedSeeds: number;
  pruned: number;
  droppedEvents: number;
  ollama: { available: boolean | null; lastCheckedAt: string | null };
  feedback: { confirmed: number; contradicted: number; obsolete: number; suspectNotes: number; obsoleteNotes: number };
  eligibility: { verifiedNotes: number; candidateNotes: number };
}

export interface NavMemoryForgetParams {
  id?: string;
  host?: string;
  includeRaw?: boolean;
}

export interface NavMemoryForgetResult {
  notes: number;
  pending: number;
  processing: number;
  failed: number;
  done: number;
}

export interface NavMemoryEtlNowResult {
  status: "processed" | "empty" | "failed";
  workId?: string;
  notes?: number;
}

export interface NavSessionLog {
  schemaVersion: 1;
  workId: string;
  host: string;
  registrableDomain: string | null;
  container: string | null;
  startedAt: string;
  endedAt: string;
  attempts: number;
  events: NavEventRecord[];
}
