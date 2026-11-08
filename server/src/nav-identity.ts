import { createHmac } from "node:crypto";
import { normalizeUrl } from "@zen-mcp/shared/nav-redact";

// Keep sensitive path segments out of telemetry without making unrelated pages
// share an identity. Authentication-key rotation safely invalidates old proofs.
// Queries/fragments never affect this key and are never persisted.
export function pageFingerprint(raw: string, key: string): string | null {
  const normalized = normalizeUrl(raw);
  if (!normalized) return null;
  const url = new URL(raw);
  const segments = url.pathname.split("/").filter(Boolean).map(segment => {
    try { return decodeURIComponent(segment); } catch { return segment; }
  });
  return createHmac("sha256", key).update("zen-nav-page-v1\0").update(JSON.stringify([url.origin, normalized.host, segments])).digest("hex");
}
