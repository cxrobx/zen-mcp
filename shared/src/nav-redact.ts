import { getDomain } from "tldts";
import { NAV_NOTE_CAPS } from "./nav-memory.js";

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const AWS_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const SK_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const SECRET_PAIR_RE = /\b(pass(?:word)?|token|secret|api[_-]?key|auth)\s*[:=]\s*[^\s&;,]+/gi;
const LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi;
const OPAQUE_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const LONG_DIGITS_RE = /\b\d{6,}\b/g;
const PROMPTISH_RE = /(ignore\s+(?:all\s+)?(?:previous|prior)|system\s+(?:prompt|message)|developer\s+message|assistant\s*:|follow\s+these\s+instructions)/i;

export interface NormalizedUrl {
  host: string;
  path: string;
  registrableDomain: string | null;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let out = "";
  for (const char of value) {
    if (encoder.encode(out + char).length > maxBytes) break;
    out += char;
  }
  return out;
}

export function redactText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(EMAIL_RE, "<email>")
    .replace(JWT_RE, "<jwt>")
    .replace(UUID_RE, "<uuid>")
    .replace(AWS_RE, "<aws-key>")
    .replace(SK_RE, "<secret-key>")
    .replace(SECRET_PAIR_RE, "$1=<redacted>")
    .replace(LONG_HEX_RE, "<hex>")
    .replace(OPAQUE_RE, "<token>")
    .replace(LONG_DIGITS_RE, "<digits>");
}

export function containsPromptLikeText(value: string): boolean {
  return PROMPTISH_RE.test(value) || /[\r\n]/.test(value);
}

export function normalizeHost(raw: string): string | null {
  const value = raw.trim().replace(/\.$/, "").toLowerCase();
  if (!value || value.includes("/") || value.includes("@") || value.includes(":")) return null;
  try {
    const parsed = new URL(`http://${value}`);
    return parsed.hostname.replace(/\.$/, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

function isIp(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

// Dev servers are excluded from navigation memory entirely: the host key has no
// port, so every localhost project would share one note bucket and notes learned
// on one project's dev server would inject into another's — and dev UIs change
// too fast for anything learned about them to stay true.
export function isDevHost(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.startsWith("127.")
  );
}

export function registrableDomain(host: string): string | null {
  if (host === "localhost" || isIp(host)) return null;
  return getDomain(host, { allowPrivateDomains: true }) ?? null;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizePathSegment(segment: string): string {
  const decoded = safeDecode(segment);
  if (
    /^\d+$/.test(decoded) ||
    /^[0-9a-f]{8,}$/i.test(decoded) ||
    UUID_RE.test(decoded) ||
    /^[A-Za-z0-9_-]{16,}$/.test(decoded) ||
    redactText(decoded) !== decoded ||
    containsPromptLikeText(decoded)
  ) {
    UUID_RE.lastIndex = 0;
    return "*";
  }
  UUID_RE.lastIndex = 0;
  return encodeURIComponent(decoded).replace(/%2A/gi, "*");
}

export function normalizeUrl(raw: string): NormalizedUrl | null {
  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return null;
    }
    const host = normalizeHost(url.hostname);
    if (!host) return null;
    const path =
      "/" +
      url.pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .map(normalizePathSegment)
        .join("/");
    return { host, path, registrableDomain: registrableDomain(host) };
  } catch {
    return null;
  }
}

export function sanitizeLocator(value: string): string | null {
  if (containsPromptLikeText(value)) return null;
  const stripped = value.replace(
    /\[\s*(value|href|src|data-[\w-]+)\s*([~|^$*]?=)\s*(["']).*?\3\s*\]/gi,
    "[$1$2\"*\"]",
  );
  const redacted = redactText(stripped).replace(/\s+/g, " ").trim();
  return redacted ? truncateUtf8(redacted, NAV_NOTE_CAPS.locator) : null;
}

export function validPathGlob(glob: string): boolean {
  return (
    glob.length > 0 &&
    glob.length <= NAV_NOTE_CAPS.pathGlob &&
    glob.startsWith("/") &&
    !glob.includes("**") &&
    !glob.includes("?") &&
    !glob.includes("#") &&
    /^\/[A-Za-z0-9._*/-]*$/.test(glob)
  );
}

export function matchesPathGlob(path: string, glob: string): boolean {
  if (!validPathGlob(glob)) return false;
  const escaped = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}

export function normalizeSummary(value: string): string {
  return redactText(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
}
