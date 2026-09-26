import { maskCredentials } from "@zen-mcp/shared/credential-redact";
import { ZenToolError } from "./errors.js";

export const DEFAULT_RESPONSE_BUDGET = 25_000;
const CURSOR_TTL_MS = 10 * 60 * 1000;
const CURSOR_SWEEP_INTERVAL = 50;

export interface BudgetedResult {
  text: string;
  cursor?: string;
  truncated: boolean;
}

type CursorContinuation = (maxBytes: number) => BudgetedResult;

interface CursorEntry {
  fn: CursorContinuation;
  createdAt: number;
}

const cursorRegistry = new Map<string, CursorEntry>();
let sweepCounter = 0;

function randomCursorId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sweep(): void {
  sweepCounter += 1;
  if (sweepCounter < CURSOR_SWEEP_INTERVAL) return;
  sweepCounter = 0;
  const now = Date.now();
  for (const [id, entry] of cursorRegistry.entries()) {
    if (now - entry.createdAt > CURSOR_TTL_MS) cursorRegistry.delete(id);
  }
}

export function registerCursor(fn: CursorContinuation): string {
  sweep();
  const id = randomCursorId();
  cursorRegistry.set(id, { fn, createdAt: Date.now() });
  return id;
}

export function continueCursor(cursor: string, maxBytes?: number): BudgetedResult {
  sweep();
  const entry = cursorRegistry.get(cursor);
  if (!entry || Date.now() - entry.createdAt > CURSOR_TTL_MS) {
    if (entry) cursorRegistry.delete(cursor);
    throw new ZenToolError(
      "BAD_INPUT",
      `Unknown or expired cursor: ${cursor}`,
      "Cursors expire after 10 minutes. Re-run the original tool to get a fresh cursor.",
    );
  }
  cursorRegistry.delete(cursor);
  return entry.fn(maxBytes ?? DEFAULT_RESPONSE_BUDGET);
}

export function withResponseBudget(raw: string, maxBytes?: number): BudgetedResult {
  // Mask before splitting: a key cut in two at the budget boundary would be too short on
  // either side for the response-level redaction to recognise.
  const text = maskCredentials(raw);
  const budget = maxBytes ?? DEFAULT_RESPONSE_BUDGET;
  if (text.length <= budget) return { text, truncated: false };
  return registerTextRemainder(text, budget);
}

function registerTextRemainder(text: string, budget: number): BudgetedResult {
  if (text.length <= budget) return { text, truncated: false };
  const head = text.slice(0, budget);
  const tail = text.slice(budget);
  const cursor = registerCursor((next) => registerTextRemainder(tail, next));
  const footer = `\n\n[truncated, ${tail.length} chars remaining — pass cursor="${cursor}" to continue]`;
  return { text: head + footer, cursor, truncated: true };
}

export function _resetCursorRegistry(): void {
  cursorRegistry.clear();
  sweepCounter = 0;
}
