import { createHash } from "node:crypto";
import type { NavNote, NavNoteKind } from "@zen-mcp/shared";
import { registrableDomain } from "@zen-mcp/shared/nav-redact";
import type { JsonNavStore } from "./store.js";

export const SEED_VERSION = 1;
const HOST = "console.cloud.google.com";

const SEEDS: Array<{
  kind: NavNoteKind;
  summary: string;
  detail: string;
  example?: string;
  tools: string[];
  success: boolean;
  pathGlob?: string;
}> = [
  {
    kind: "timing",
    summary: "Page indexes drift as tabs open and close.",
    detail: "A pageIdx from list_pages is session-local and may change as tabs move. Resolve the target by URL again before sensitive multi-step actions, or guard evaluate_script with a location check.",
    tools: ["list_pages", "evaluate_script"],
    success: true,
  },
  {
    kind: "iframe-quirk",
    summary: "Angular Material content can evade text search and UID snapshots.",
    detail: "Google Cloud console tables may require evaluate_script DOM queries. Any iframe recursion needs both a depth cap and a visited-frame guard because console frames may self-reference.",
    tools: ["find_by_text", "take_snapshot", "evaluate_script"],
    success: true,
  },
  {
    kind: "tool-tip",
    summary: "evaluate_script uses a non-async function body.",
    detail: "Top-level await is unavailable. Multi-step flows such as click, render, and fill work as separate tool calls.",
    tools: ["evaluate_script"],
    success: true,
  },
  {
    kind: "selector",
    summary: "Angular reactive inputs require native value-setter events.",
    detail: "Setting an Angular Material input through script requires the native HTMLInputElement value setter followed by input, change, and blur events so the reactive form observes the change.",
    example: "native setter; dispatch input, change, blur",
    tools: ["evaluate_script", "fill"],
    success: true,
  },
  {
    kind: "workflow",
    summary: "The OAuth client editor uses the Google Auth Platform route.",
    detail: "Legacy credentials URLs redirect to /auth/clients/*. Adding a redirect URI creates a new placeholder input; saving returns to the credentials route.",
    example: "Add URI -> fill new placeholder input -> Save",
    tools: ["navigate_page", "click", "fill"],
    success: true,
    pathGlob: "/auth/clients/*",
  },
  {
    kind: "anti-pattern",
    summary: "The client form is scriptable from the top document.",
    detail: "The OAuth client form is same-origin. Chasing sandbox wrapper frames produces low-value snapshots; a scoped top-document query is more reliable.",
    tools: ["take_snapshot", "evaluate_script"],
    success: false,
  },
];

export function noteId(host: string, kind: string, summary: string, scope?: { pathGlob: string | null; success: boolean; pageKey?: string }): string {
  const key = `${host}\0${kind}\0${summary.trim()}`;
  // Keep seed ids stable, including existing forget tombstones. Newly learned
  // facts also identify their scope and polarity so distinct facts cannot clash.
  return createHash("sha256").update(scope ? `${key}\0${scope.pathGlob ?? ""}\0${scope.success}${scope.pageKey ? `\0${scope.pageKey}` : ""}` : key).digest("hex");
}

export async function applySeeds(store: JsonNavStore, now = new Date()): Promise<void> {
  const timestamp = now.toISOString();
  for (const seed of SEEDS) {
    const note: NavNote = {
      id: noteId(HOST, seed.kind, seed.summary),
      host: HOST,
      registrableDomain: registrableDomain(HOST),
      pathGlob: seed.pathGlob ?? null,
      kind: seed.kind,
      summary: seed.summary,
      detail: seed.detail,
      example: seed.example ?? null,
      tools: seed.tools,
      success: seed.success,
      confidence: 0.8,
      reinforced: 1,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      source: { seed: true, seedVersion: SEED_VERSION },
      embedding: null,
    };
    await store.upsertSeed(note);
  }
  await store.setSeedVersion(SEED_VERSION);
}
