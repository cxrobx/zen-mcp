// Masks credential-shaped strings in text a tool is about to hand back to the model.
//
// The leak this closes: a page can SHOW a key truncated while the element's accessible name,
// text node or input value holds the whole thing. Stripe's API-keys row does exactly that, and
// its full `sk_test_…` came back through take_snapshot and the `active=` line after a click
// (2026-09-25). Whatever a tool returns is transcript, so the mask is applied on the way out.
//
// A match keeps its recognisable prefix and last four characters (`sk_test_…9x4Q`), which is
// enough to tell two keys apart and confirm the right one is on screen without being usable.
// The masked form contains `…`, which none of the patterns accept inside a secret body, so
// running this twice changes nothing.
//
// Publishable keys (`pk_live_`/`pk_test_`) are public by design and are left alone. Prefixes
// accept a backslash before each `_`, because read_page's Markdown escapes them (`sk\_live\_`).

export const MASK = "…";

function tail(secret: string): string {
  return secret.slice(-4);
}

interface Rule {
  re: RegExp;
  mask: (match: string, ...groups: string[]) => string;
}

// Order matters: specific shapes first, so a Stripe key followed by the word "key" is masked
// as a Stripe key before the generic rule sees it.
const RULES: Rule[] = [
  // PEM private keys, complete blocks. Nothing of the body is kept.
  {
    re: /-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*?PRIVATE KEY-----/g,
    mask: (_m, kind) => `-----BEGIN ${kind}PRIVATE KEY-----${MASK}[redacted]${MASK}-----END ${kind}PRIVATE KEY-----`,
  },
  // A BEGIN line whose END was cut off (a truncated snapshot, a text budget boundary): mask the
  // base64 lines that follow it. PEM lines are 64 characters; prose words are not 16+.
  {
    re: /-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----(?!…)(?:(?:\s|\\n)*[A-Za-z0-9+/=]{16,})+/g,
    mask: (_m, kind) => `-----BEGIN ${kind}PRIVATE KEY-----${MASK}[redacted]`,
  },
  // Stripe secret and restricted keys.
  {
    re: /\b((?:sk|rk)\\?_(?:live|test)\\?_)([A-Za-z0-9]{8,})(?![A-Za-z0-9])/g,
    mask: (_m, prefix, body) => `${prefix}${MASK}${tail(body)}`,
  },
  // Stripe webhook signing secrets.
  {
    re: /\b(whsec\\?_)([A-Za-z0-9+/=]{8,})(?![A-Za-z0-9+/=])/g,
    mask: (_m, prefix, body) => `${prefix}${MASK}${tail(body)}`,
  },
  // GitHub fine-grained and classic tokens (personal, OAuth, user-to-server, server, refresh).
  {
    re: /\b(github\\?_pat\\?_)([A-Za-z0-9_\\]{20,})(?![A-Za-z0-9_\\])/g,
    mask: (_m, prefix, body) => `${prefix}${MASK}${tail(body)}`,
  },
  {
    re: /\b(gh[pousr]\\?_)([A-Za-z0-9]{20,})(?![A-Za-z0-9])/g,
    mask: (_m, prefix, body) => `${prefix}${MASK}${tail(body)}`,
  },
  // Slack tokens.
  {
    re: /\b(xox[abpr]-)([A-Za-z0-9-]{10,})(?![A-Za-z0-9-])/g,
    mask: (_m, prefix, body) => `${prefix}${MASK}${tail(body)}`,
  },
  // AWS access key ids.
  {
    re: /\b(AKIA)([0-9A-Z]{16})(?![0-9A-Za-z])/g,
    mask: (_m, prefix, body) => `${prefix}${MASK}${tail(body)}`,
  },
  // A key split across elements (`<span>sk_live_</span><span>51H…</span>`) reaches a snapshot
  // as two strings: a bare prefix, then its body on a later line. Mask a digit-bearing 16+
  // character run that follows a bare prefix closely. A prefix followed by `…` is one this
  // function already masked, and is left alone.
  {
    re: /\b((?:sk|rk)\\?_(?:live|test)\\?_|whsec\\?_|gh[pousr]\\?_|github\\?_pat\\?_|xox[abpr]-)(?![A-Za-z0-9…])([^…]{1,120}?)(?<![A-Za-z0-9_-])([A-Za-z0-9]{16,})(?![A-Za-z0-9_-])/g,
    mask: (m, prefix, between, body) =>
      /[0-9]/.test(body) ? `${prefix}${between}${MASK}${tail(body)}` : m,
  },
  // Anything else: a 32+ character base62 run on the same line after "secret", "token" or
  // "key" (any case, so "API key", "apiKey", "Signing secret", "access_token"). The run must
  // hold a digit, which random keys do and long words don't. It must also stand alone: a run
  // glued to `_` or `-` is the tail of a prefixed id (a publishable `pk_test_…`, a slug), and
  // every prefixed secret worth masking has its own rule above.
  {
    re: /(secret|token|key)([^\n]{0,40}?)(?<![A-Za-z0-9_-])([A-Za-z0-9]{32,})(?![A-Za-z0-9_-])/gi,
    mask: (m, word, between, body) =>
      /[0-9]/.test(body) ? `${word}${between}${MASK}${tail(body)}` : m,
  },
];

/** Returns `text` with every credential-shaped substring masked to prefix + `…` + last 4. */
export function maskCredentials(text: string): string {
  if (!text) return text;
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, rule.mask as (substring: string, ...args: any[]) => string);
  }
  return out;
}

/** True when `text` holds at least one string maskCredentials would change. */
export function hasCredentials(text: string): boolean {
  return maskCredentials(text) !== text;
}
