import type { NavNote } from "@zen-mcp/shared";

// Similar text does not establish that two observations apply to the same page
// or describe the same outcome. Require exact scope, kind and polarity first.
export function mergeCompatible(left: NavNote, right: NavNote): boolean {
  return left.host === right.host && left.kind === right.kind &&
    left.pathGlob === right.pathGlob && left.success === right.success &&
    left.pageKey === right.pageKey &&
    JSON.stringify(left.observation ?? null) === JSON.stringify(right.observation ?? null);
}
