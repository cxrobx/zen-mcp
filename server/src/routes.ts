import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Host -> container routing. The table answers "which Firefox container owns this domain?"
// so a URL lands in the same cookie jar no matter which zen-* MCP entry issued the call.
// Nothing personal ships in this repo: the table is a user config file, absent by default.
//
// Two vocabularies compile into one rule list:
//   "routes"     - host patterns per container, the original grammar. Host+port only.
//   "containers" + "consoles" - each container declares identifying strings (its domains,
//     plus opaque "aliases" for consoles that key by account id); each console is a shared
//     multi-project host (search.google.com). The cross-product generates one rule per
//     (console, identifying string): host must match the console AND the decoded URL must
//     contain the string. That is how one host serving every project's dashboard routes
//     per-project. A console host with no matching string is CLAIMED: it errors instead of
//     falling back, because the fallback jar is exactly the wrong-login failure the table
//     exists to prevent. A plain "routes" rule on the same host acts as the explicit
//     default when that hard failure is not wanted.
//
//   "accounts"  - host -> the identity expected to be signed in there. A container may also
//     declare a default "account" for its hosts. The host's own entry wins, because one jar
//     routinely holds several signed-in accounts and the host is what picks between them.
//     ADVISORY and printed, never enforced: this decides the cookie jar, but nothing here
//     can see which row gets clicked on a provider's account chooser.
//
// Accounts live in their own top-level section, and a container's account is an extra key
// on its object, for one reason: EVERY FORM IN THIS FILE MUST BE IGNORABLE BY AN OLDER
// SERVER. Dozens of long-lived MCP processes read this file (13 sessions x 7 containers was
// normal), they load their code once, and a session can stay up for weeks - so a grammar
// only new code can parse disarms routing everywhere until the last one cycles, and the
// fallback is the silent wrong jar this table exists to prevent. An unknown top-level key
// and an unknown object key are both skipped by every past parser; a non-string inside a
// pattern list is not.

export interface CompiledRule {
  /** Pattern exactly as written in the config (or synthesized for cross-product rules). */
  pattern: string;
  /** Firefox container name. Resolved to a cookieStoreId lazily, at first use. */
  container: string;
  /** Normalized host portion of the pattern. */
  host: string;
  /** Port the pattern pins, or null when it matches any port. */
  port: string | null;
  /** "*.example.com" matches subdomains only; "example.com" also matches the apex. */
  subdomainsOnly: boolean;
  /**
   * When set, the rule only matches if the percent-decoded URL contains this string on
   * token boundaries. Set only on rules generated from a (console x container) pair.
   */
  urlContains: string | null;
  /** Expected signed-in identity for this host, or null. Advisory: printed, not enforced. */
  account: string | null;
}

/** A shared multi-project host from the "consoles" section. */
export interface CompiledConsole {
  pattern: string;
  host: string;
  port: string | null;
  subdomainsOnly: boolean;
}

/** One "containers" entry, kept for description and claim reporting. */
export interface ContainerDef {
  container: string;
  domains: string[];
  aliases: string[];
  /** Default identity for hosts in this container that declare none of their own. */
  account: string | null;
}

export interface RouteTable {
  /** Config path consulted, whether or not it exists. */
  path: string;
  /** The file existed and parsed. */
  loaded: boolean;
  /** Routing is switched on (ZEN_MCP_CONTAINER_ROUTES=0 turns it off). */
  enabled: boolean;
  rules: CompiledRule[];
  /** Hosts claimed by the "consoles" section; empty for legacy route-only files. */
  consoles: CompiledConsole[];
  /** The "containers" section as written; empty for legacy route-only files. */
  containerDefs: ContainerDef[];
  /** Load or parse failure, kept so the state is reportable instead of silently empty. */
  error: string | null;
}

export interface RouteMatch {
  container: string;
  pattern: string;
  kind: "exact" | "subdomain";
  /** The identifying string that matched, when the winning rule was a console rule. */
  token?: string;
  /** Set when another rule matched equally well but named a different container. */
  ambiguousWith?: string;
  /** Expected signed-in identity: the rule's own account, else the container's default. */
  account?: string;
}

/** A console host was hit but no container's identifying string appeared in the URL. */
export interface ConsoleClaim {
  /** The console pattern that claimed the host. */
  console: string;
  /** Containers whose strings were tried, for the error message. */
  containers: string[];
}

export interface UrlTarget {
  host: string;
  /** "" for a scheme's default port. */
  port: string;
  /**
   * Where a console encodes WHICH project a URL is for: path + query + fragment, decoded
   * and lowercased. Deliberately excludes scheme, userinfo, host and port - see
   * containsToken.
   */
  identity: string;
}

const MAX_RULES = 500;
const MAX_PATTERN_LEN = 253;
/** Below this an identifying string matches half the web; refuse rather than misroute. */
const MIN_TOKEN_LEN = 4;
/** An address longer than this is a paste accident, not an identity. */
const MAX_ACCOUNT_LEN = 254;

let cached: RouteTable | null = null;

export function routeConfigPath(): string {
  const override = process.env.ZEN_MCP_ROUTES;
  if (override && override.length > 0) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "zen-mcp", "containers.json");
}

function routingEnabled(): boolean {
  return process.env.ZEN_MCP_CONTAINER_ROUTES !== "0";
}

/** Loaded once per process; call reloadRouteTable() to pick up an edited file. */
export function loadRouteTable(): RouteTable {
  if (!cached) cached = readRouteTable();
  return cached;
}

export function reloadRouteTable(): RouteTable {
  cached = readRouteTable();
  return cached;
}

function readRouteTable(): RouteTable {
  const path = routeConfigPath();
  const enabled = routingEnabled();
  const empty: RouteTable = {
    path,
    loaded: false,
    enabled,
    rules: [],
    consoles: [],
    containerDefs: [],
    error: null,
  };
  if (!enabled) return empty;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // An absent file is the default state, not a failure.
    if (code === "ENOENT") return empty;
    return { ...empty, error: `could not read ${path}: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ...empty, error: `invalid JSON in ${path}: ${(err as Error).message}` };
  }

  try {
    const compiled = compileTable(parsed);
    return { path, loaded: true, enabled, ...compiled, error: null };
  } catch (err) {
    return { ...empty, error: `invalid route table in ${path}: ${(err as Error).message}` };
  }
}

function asPatternList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string") throw new Error("pattern entries must be strings");
      return item;
    });
  }
  throw new Error("each container maps to a host pattern or an array of host patterns");
}

/** Accounts are printed, never sent anywhere; validate shape only, and loudly. */
function asAccount(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`"account" must be a string (${where})`);
  const account = value.trim();
  if (account.length === 0) throw new Error(`"account" cannot be empty (${where})`);
  if (account.length > MAX_ACCOUNT_LEN) throw new Error(`"account" too long (${where})`);
  if (/\s/.test(account)) throw new Error(`"account" cannot contain whitespace (${where})`);
  if (!account.includes("@")) {
    throw new Error(`"account" should be the full signed-in address, e.g. name@example.com (${where})`);
  }
  return account;
}

/** The key a rule and an "accounts" entry agree on: normalized host, plus :port if pinned. */
function accountKey(host: string, port: string | null): string {
  return port ? `${host}:${port}` : host;
}

/** "accounts": { "decodo.com": "you@example.com" } -> normalized host -> account. */
function compileAccounts(source: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (source === undefined) return map;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error('"accounts" must be an object mapping a host to an account');
  }
  for (const [host, value] of Object.entries(source as Record<string, unknown>)) {
    const trimmed = host.trim();
    if (trimmed.length === 0) throw new Error('"accounts" hosts cannot be empty');
    const parsed = parseHostPattern(trimmed);
    map.set(accountKey(parsed.host, parsed.port), asAccount(value, `accounts."${trimmed}"`));
  }
  return map;
}

interface CompiledSections {
  rules: CompiledRule[];
  consoles: CompiledConsole[];
  containerDefs: ContainerDef[];
}

function compileTable(parsed: unknown): CompiledSections {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  // Structured shape: any of "routes", "containers", "consoles" at the top level. A bare
  // { "Container": [patterns] } object still works too, for a minimal hand-written file.
  const structured =
    "routes" in record || "containers" in record || "consoles" in record || "accounts" in record;

  const rules: CompiledRule[] = [];
  const push = (rule: CompiledRule) => {
    rules.push(rule);
    if (rules.length > MAX_RULES) throw new Error(`too many rules (max ${MAX_RULES})`);
  };

  const routesSource = structured ? record.routes : record;
  if (routesSource !== undefined) {
    for (const { container, patterns } of routePairs(routesSource)) {
      for (const pattern of patterns) push(compilePattern(pattern, container));
    }
  }

  const containerDefs = structured ? compileContainerDefs(record.containers) : [];
  const consoles = structured ? compileConsoles(record.consoles) : [];
  if (consoles.length > 0 && containerDefs.length === 0) {
    throw new Error('"consoles" needs a "containers" section to route to');
  }

  // Every domain is also a plain host rule - "containers" replaces "routes" for the
  // simple case, it does not require duplicating each domain in both sections.
  for (const def of containerDefs) {
    for (const domain of def.domains) push(compilePattern(domain, def.container));
  }

  // The cross-product: one rule per (console, identifying string). The rule matches only
  // when the URL is on the console host AND mentions the string on token boundaries.
  for (const console of consoles) {
    for (const def of containerDefs) {
      const tokens = [
        ...def.domains.map((d) => domainToken(d, def.container)),
        ...def.aliases.map((a) => normalizeToken(a, def.container)),
      ];
      for (const token of tokens) {
        push({
          pattern: `console "${console.pattern}" + "${token}"`,
          container: def.container,
          host: console.host,
          port: console.port,
          subdomainsOnly: console.subdomainsOnly,
          urlContains: token,
          account: null,
        });
      }
    }
  }

  // Stamp identities last, so one pass covers rules from every section. A host entry wins
  // over its container's default; an "accounts" host that routes nowhere is a typo that
  // would otherwise sit there doing nothing, so it fails the file like any other bad rule.
  const accounts = compileAccounts(structured ? record.accounts : undefined);
  const byContainer = new Map(containerDefs.map((d) => [d.container, d.account]));
  const claimed = new Set<string>();
  for (const rule of rules) {
    const key = accountKey(rule.host, rule.port);
    const own = accounts.get(key);
    if (own !== undefined) claimed.add(key);
    rule.account = own ?? byContainer.get(rule.container) ?? null;
  }
  for (const key of accounts.keys()) {
    if (!claimed.has(key)) {
      throw new Error(`"accounts" names "${key}", which no container or route maps to`);
    }
  }

  return { rules, consoles, containerDefs };
}

function routePairs(source: unknown): Array<{ container: string; patterns: string[] }> {
  const pairs: Array<{ container: string; patterns: string[] }> = [];
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (!entry || typeof entry !== "object") throw new Error("route entries must be objects");
      const e = entry as { container?: unknown; match?: unknown; hosts?: unknown };
      if (typeof e.container !== "string" || e.container.trim().length === 0) {
        throw new Error('each route entry needs a non-empty "container"');
      }
      pairs.push({ container: e.container.trim(), patterns: asPatternList(e.match ?? e.hosts) });
    }
  } else if (source && typeof source === "object") {
    for (const [container, value] of Object.entries(source as Record<string, unknown>)) {
      if (container.trim().length === 0) throw new Error("container names cannot be empty");
      pairs.push({ container: container.trim(), patterns: asPatternList(value) });
    }
  } else {
    throw new Error('"routes" must be an object or an array');
  }
  return pairs;
}

function compileContainerDefs(source: unknown): ContainerDef[] {
  if (source === undefined) return [];
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error('"containers" must be an object mapping container names to definitions');
  }
  const defs: ContainerDef[] = [];
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    const container = name.trim();
    if (container.length === 0) throw new Error("container names cannot be empty");
    // Shorthand: "Geek": ["a.com"] or "Geek": "a.com" means domains only.
    if (typeof value === "string" || Array.isArray(value)) {
      defs.push({ container, domains: asPatternList(value), aliases: [], account: null });
      continue;
    }
    if (!value || typeof value !== "object") {
      throw new Error(`container "${container}" must map to a domain list or {domains, aliases}`);
    }
    const v = value as { domains?: unknown; aliases?: unknown; account?: unknown };
    const domains = v.domains === undefined ? [] : asPatternList(v.domains);
    const aliases = v.aliases === undefined ? [] : asPatternList(v.aliases);
    const account = v.account === undefined ? null : asAccount(v.account, `container "${container}"`);
    if (domains.length === 0 && aliases.length === 0) {
      throw new Error(`container "${container}" has neither domains nor aliases`);
    }
    defs.push({ container, domains, aliases, account });
  }
  return defs;
}

function compileConsoles(source: unknown): CompiledConsole[] {
  if (source === undefined) return [];
  const patterns = asPatternList(source);
  return patterns.map((pattern) => {
    const original = pattern.trim();
    if (original.length === 0) throw new Error("empty console host pattern");
    return { pattern: original, ...parseHostPattern(original) };
  });
}

/**
 * Identifying strings are matched literally against the decoded URL; refuse anything so
 * short or wildcarded that it would match by accident instead of by identity.
 */
function normalizeToken(token: string, container: string): string {
  const value = token.trim().toLowerCase();
  if (value.includes("*")) {
    throw new Error(`identifying strings are literal, no wildcards: "${token}" (${container})`);
  }
  if (value.length < MIN_TOKEN_LEN) {
    throw new Error(
      `identifying string "${token}" (${container}) is shorter than ${MIN_TOKEN_LEN} chars - too easy to match by accident`,
    );
  }
  if (value.length > MAX_PATTERN_LEN) throw new Error(`identifying string too long: "${token}"`);
  return value;
}

function parseHostPattern(original: string): {
  host: string;
  port: string | null;
  subdomainsOnly: boolean;
} {
  if (original.length > MAX_PATTERN_LEN) throw new Error(`host pattern too long: ${original}`);

  // Tolerate a pasted URL: strip scheme, path, query, and fragment.
  let value = original.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split(/[/?#]/)[0] ?? "";
  if (value.length === 0) throw new Error(`host pattern has no host: ${original}`);

  let subdomainsOnly = false;
  if (value.startsWith("*.")) {
    subdomainsOnly = true;
    value = value.slice(2);
  }
  if (value.includes("*")) {
    throw new Error(`wildcards are only supported as a leading "*." label: ${original}`);
  }

  let host = value;
  let port: string | null = null;
  if (host.startsWith("[")) {
    // Bracketed IPv6 literal, optionally with :port after the closing bracket.
    const close = host.indexOf("]");
    if (close === -1) throw new Error(`unterminated IPv6 literal: ${original}`);
    const rest = host.slice(close + 1);
    if (rest.startsWith(":")) port = rest.slice(1);
    host = host.slice(1, close);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) {
      port = host.slice(colon + 1);
      host = host.slice(0, colon);
    }
  }
  host = host.replace(/\.$/, "");
  if (host.length === 0) throw new Error(`host pattern has no host: ${original}`);
  if (port !== null && !/^\d{1,5}$/.test(port)) throw new Error(`invalid port in ${original}`);
  if (subdomainsOnly && host.split(".").length < 2) {
    throw new Error(`"*." needs a parent domain: ${original}`);
  }

  return { host, port, subdomainsOnly };
}

function compilePattern(pattern: string, container: string): CompiledRule {
  const original = pattern.trim();
  if (original.length === 0) throw new Error("empty host pattern");
  return { pattern: original, container, ...parseHostPattern(original), urlContains: null, account: null };
}

/**
 * The searchable identity of a domain entry. Must mean the same thing as the host rule the
 * same config line generates: "*.example.com" excludes the apex there, so its token is
 * ".example.com" (containsToken treats a leading dot as a subdomain marker) rather than the
 * bare apex, which would match the very URL the host rule refuses.
 */
function domainToken(domain: string, container: string): string {
  const parsed = parseHostPattern(domain.trim());
  const host = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
  return normalizeToken(parsed.subdomainsOnly ? `.${host}` : host, container);
}

/** Host + port + identity text of a URL, or null for scheme-only URLs (about:, file:, data:). */
export function parseUrlTarget(url: string): UrlTarget | null {
  const attempt = (value: string): URL | null => {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  };
  const parsed = attempt(url) ?? attempt(`https://${url}`);
  if (!parsed) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host.length === 0) return null;
  return { host, port: parsed.port, identity: decodeLower(`${parsed.pathname}${parsed.search}${parsed.hash}`) };
}

/**
 * Percent-decoded and lowercased - GSC writes a property as sc-domain%3Apocketbuddy.org or
 * https%3A%2F%2Fpocketbuddy.org%2F. A malformed escape falls back to the raw text; a single
 * decoding pass can only cause a failed match (which surfaces as the loud claim error),
 * never a false one.
 */
function decodeLower(value: string): string {
  try {
    return decodeURIComponent(value).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function ruleScore(rule: CompiledRule, kind: "exact" | "subdomain"): number {
  // A console rule (host AND identifying string) is more specific than any host-only rule.
  // Within a tier: longer patterns are more specific; an exact host beats a parent-domain
  // suffix; a rule that pins a port beats one that ignores it (localhost:3000 vs localhost).
  // The token-length tiebreak is capped below the port bonus so it never crosses tiers.
  const tokenTier = rule.urlContains !== null ? 100_000 + rule.urlContains.length : 0;
  return tokenTier + (kind === "exact" ? 10_000 : 0) + (rule.port !== null ? 5_000 : 0) + rule.host.length;
}

const TOKEN_EDGE = /[a-z0-9_-]/;

/**
 * True when `token` occurs in `identity` on token boundaries.
 *
 * Two constraints, both load-bearing:
 *
 * `identity` is path+query+fragment ONLY (parseUrlTarget). Searching the whole URL let the
 * console's own host answer for it: with a container owning "stripe.com" and a console
 * "dashboard.stripe.com", every URL on that console contained the token inside its own
 * hostname, so the claim never fired and one client's account page opened in another's jar.
 * Userinfo did the same trick deliberately ("https://victim.org@console.example/").
 *
 * Boundaries: a bare substring test would let "pocketbuddy.org" claim "notpocketbuddy.org"
 * (identifier char before) and "pocketbuddy.org.evil.com" (registered domain continues
 * after) - the lookalike trap the host matcher already refuses. A token that starts with
 * "." is a subdomain-only marker and skips the before-check, since the character preceding
 * it is exactly the subdomain label that makes it match.
 */
function containsToken(identity: string, token: string): boolean {
  const subdomainMarker = token.startsWith(".");
  let from = 0;
  for (;;) {
    const at = identity.indexOf(token, from);
    if (at === -1) return false;
    const before = at > 0 ? identity[at - 1]! : "";
    const after = at + token.length < identity.length ? identity[at + token.length]! : "";
    const beforeOk = subdomainMarker || before === "" || !TOKEN_EDGE.test(before);
    const afterOk = after === "" || (!TOKEN_EDGE.test(after) && after !== ".");
    if (beforeOk && afterOk) return true;
    from = at + 1;
  }
}

function hostMatches(
  rule: { host: string; port: string | null; subdomainsOnly: boolean },
  target: UrlTarget,
): "exact" | "subdomain" | null {
  if (rule.port !== null && rule.port !== target.port) return null;
  if (target.host === rule.host) return rule.subdomainsOnly ? null : "exact";
  if (target.host.endsWith(`.${rule.host}`)) return "subdomain";
  return null;
}

function matchRule(rule: CompiledRule, target: UrlTarget): "exact" | "subdomain" | null {
  const kind = hostMatches(rule, target);
  if (!kind) return null;
  if (rule.urlContains !== null && !containsToken(target.identity, rule.urlContains)) return null;
  return kind;
}

export function matchContainerRoute(table: RouteTable, url: string): RouteMatch | null {
  if (!table.enabled || table.rules.length === 0) return null;
  const target = parseUrlTarget(url);
  if (!target) return null;

  let best: RouteMatch | null = null;
  let bestScore = -1;
  let ambiguousWith: string | undefined;
  for (const rule of table.rules) {
    const kind = matchRule(rule, target);
    if (!kind) continue;
    const score = ruleScore(rule, kind);
    if (score > bestScore) {
      bestScore = score;
      best = { container: rule.container, pattern: rule.pattern, kind };
      if (rule.urlContains !== null) best.token = rule.urlContains;
      const account = rule.account ?? accountForContainer(table, rule.container);
      if (account) best.account = account;
      ambiguousWith = undefined;
    } else if (score === bestScore && best && rule.container !== best.container) {
      // Equal-specificity rules naming different containers: first wins, but say so.
      ambiguousWith = rule.container;
    }
  }
  if (best && ambiguousWith) best.ambiguousWith = ambiguousWith;
  return best;
}

/**
 * A container's declared default identity, for calls that pick a jar without matching a
 * host rule (an explicit container argument, or the session default).
 */
export function accountForContainer(table: RouteTable, container: string): string | null {
  return table.containerDefs.find((d) => d.container === container)?.account ?? null;
}

/**
 * Call after matchContainerRoute returns null: is this URL on a console host that no
 * identifying string matched? A claimed host must fail loudly instead of falling back to
 * the session default - the fallback jar is the wrong-login failure the consoles section
 * exists to prevent. A plain "routes" rule on the console host opts out of the hard
 * failure by matching first (as the explicit default), so this never fires for it.
 */
export function unmatchedConsoleClaim(table: RouteTable, url: string): ConsoleClaim | null {
  if (!table.enabled || table.consoles.length === 0) return null;
  const target = parseUrlTarget(url);
  if (!target) return null;
  const claimed = table.consoles.find((c) => hostMatches(c, target) !== null);
  if (!claimed) return null;
  // Self-contained on purpose: a URL some rule matches is not unmatched, whoever asks.
  if (matchContainerRoute(table, url) !== null) return null;
  return {
    console: claimed.pattern,
    containers: table.containerDefs.map((d) => d.container),
  };
}

/** One-line state summary for get_firefox_info. */
export function routeSummaryLine(table: RouteTable): string {
  if (!table.enabled) return "disabled (ZEN_MCP_CONTAINER_ROUTES=0)";
  if (table.error) return `error: ${table.error}`;
  if (!table.loaded) return `(no route file at ${table.path})`;
  const consoles =
    table.consoles.length > 0
      ? `, ${table.consoles.length} console host${table.consoles.length === 1 ? "" : "s"}`
      : "";
  return `${table.rules.length} rule${table.rules.length === 1 ? "" : "s"}${consoles} from ${table.path}`;
}

/** Full table for the container_routes tool. */
export function describeRouteTable(table: RouteTable): string {
  const lines = [`routes: ${routeSummaryLine(table)}`];
  if (table.rules.length === 0) {
    lines.push(
      "",
      "No host is mapped to a container, so new tabs fall back to the session default",
      `(--container / set_default_container). Create ${table.path} to map domains:`,
      "",
      '{ "containers": { "Artist Advisory": ["artistadvisory.io"] }, "consoles": ["search.google.com"] }',
      "",
      'An "accounts" section maps a host to the identity expected there, and a container may',
      'carry a default "account" - printed as an expectation, never enforced.',
      "Each container lists its domains (and opaque \"aliases\" for consoles that key by",
      "account id). A domain matches its host and subdomains; \"*.example.com\" matches",
      'subdomains only, "localhost:3000" pins a port. A console is a shared host routed by',
      "which container's domain/alias appears in the URL - and it fails loudly when none",
      'does. The older { "routes": { "Container": ["host"] } } shape still works.',
    );
    return lines.join("\n");
  }

  if (table.containerDefs.length > 0) {
    lines.push("", "containers:");
    for (const def of table.containerDefs) {
      const aliases = def.aliases.length > 0 ? ` (aliases: ${def.aliases.join(", ")})` : "";
      const account = def.account ? ` [account: ${def.account}]` : "";
      lines.push(`- ${def.container}: ${def.domains.join(", ")}${aliases}${account}`);
    }
    if (table.consoles.length > 0) {
      lines.push(
        "",
        `consoles (shared hosts, routed by which container's domain/alias the URL mentions;`,
        `no mention -> loud failure, not a fallback):`,
      );
      for (const c of table.consoles) lines.push(`- ${c.pattern}`);
    }
  }

  // Rules that came from the "routes" section (cross-product rules are already shown
  // above in containers/consoles form, which is the readable view of the same table).
  // Patterns are trimmed at compile time but config domains are not, so compare trimmed -
  // otherwise a domain written with stray whitespace is listed twice.
  const fromContainers = new Set(
    table.containerDefs.flatMap((d) => d.domains.map((domain) => domain.trim())),
  );
  const plain = table.rules.filter((r) => r.urlContains === null && !fromContainers.has(r.pattern));
  if (plain.length > 0) {
    const byContainer = new Map<string, string[]>();
    for (const rule of plain) {
      const list = byContainer.get(rule.container) ?? [];
      list.push(rule.account ? `${rule.pattern} [account: ${rule.account}]` : rule.pattern);
      byContainer.set(rule.container, list);
    }
    lines.push("", table.containerDefs.length > 0 ? "host rules:" : "");
    for (const [container, patterns] of byContainer) {
      lines.push(`- ${container}: ${patterns.join(", ")}`);
    }
  }
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
