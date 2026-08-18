import type { NavNote, NavNoteKind } from "@zen-mcp/shared";
import { matchesPathGlob } from "@zen-mcp/shared/nav-redact";

// Actionable kinds get the scarce injection slots. workflow/timing notes mostly
// restate how past sessions behaved, and because every later session looks the
// same they are the easiest notes to reinforce — an unweighted rank lets them
// crowd out the tool-tips and anti-patterns that actually change behavior.
const KIND_WEIGHT: Record<NavNoteKind, number> = {
  "tool-tip": 1.25,
  "anti-pattern": 1.25,
  "iframe-quirk": 1.25,
  selector: 1.15,
  "auth-flow": 1.15,
  "url-pattern": 1,
  workflow: 0.7,
  timing: 0.7,
};

export interface RankContext {
  host: string;
  registrableDomain: string | null;
  path?: string;
  includeOutOfScope?: boolean;
  now?: number;
}

export function scoreNote(note: NavNote, ctx: RankContext): number {
  const now = ctx.now ?? Date.now();
  const ageDays = Math.max(0, (now - Date.parse(note.lastSeenAt)) / 86_400_000);
  const recency = Math.max(0.25, 0.5 ** (ageDays / 90));
  const reinforcement = 1 + Math.min(2, Math.log2(Math.max(1, note.reinforced)));
  const hostFactor = note.host === ctx.host ? 1 : 0.35;
  const pathFactor = note.pathGlob && ctx.path && matchesPathGlob(ctx.path, note.pathGlob) ? 1.25 : 1;
  return note.confidence * recency * reinforcement * hostFactor * pathFactor * (KIND_WEIGHT[note.kind] ?? 1);
}

export function rankNotes(notes: NavNote[], ctx: RankContext, limit: number): NavNote[] {
  return notes
    .filter((note) => {
      const related =
        note.host === ctx.host ||
        (ctx.registrableDomain !== null && note.registrableDomain === ctx.registrableDomain);
      if (!related) return false;
      if (!ctx.includeOutOfScope && note.pathGlob) {
        return Boolean(ctx.path && matchesPathGlob(ctx.path, note.pathGlob));
      }
      return true;
    })
    .sort((a, b) => {
      if ((a.host === ctx.host) !== (b.host === ctx.host)) return a.host === ctx.host ? -1 : 1;
      const score = scoreNote(b, ctx) - scoreNote(a, ctx);
      if (score !== 0) return score;
      if (a.confidence !== b.confidence) return b.confidence - a.confidence;
      const seen = Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
      return seen || a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}
