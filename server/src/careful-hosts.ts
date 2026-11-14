// Careful hosts: sites where the browser is signed in to the user's real account and whose
// terms ban automated access (X, LinkedIn, Instagram, ...). Reading them through Zen looks like
// the user browsing, so the risk is not detection of the tool but the *pattern*: volume, scroll
// loops, repeated runs, and any write action. Nothing here blocks a call. It puts a fixed rule in
// front of the agent the first time it touches such a site in a session, then a one-line
// reminder with a running count on every page load or scroll, so a long loop can't drift past it.
//
// The list is ~/.config/zen-mcp/careful-hosts.json ({"domains": ["x.com", ...]}), which REPLACES
// the defaults below; a missing file means the defaults, a malformed one falls back to them.
// ZEN_MCP_CAREFUL_HOSTS_FILE points at another file (tests), ZEN_MCP_CAREFUL_HOSTS=0 turns it off.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registrableDomain } from "@zen-mcp/shared/nav-redact";

export const DEFAULT_CAREFUL_DOMAINS = [
  "x.com",
  "twitter.com",
  "linkedin.com",
  "instagram.com",
  "facebook.com",
  "threads.net",
  "threads.com",
  "tiktok.com",
  "reddit.com",
] as const;

/** Tools that load a page or more content, i.e. the volume a platform's bot detection counts. */
const LOADS = new Set(["open_url", "navigate_page", "navigate_history", "new_page", "new_page_in_container"]);
const SCROLLS = new Set(["scroll"]);

/** Past this many loads + scrolls on one site in a session, the reminder tells the agent to wrap up. */
export const HEAVY_SESSION_THRESHOLD = 20;

export function configPath(): string {
  return process.env.ZEN_MCP_CAREFUL_HOSTS_FILE || join(homedir(), ".config", "zen-mcp", "careful-hosts.json");
}

function normalizeDomain(value: string): string | null {
  const d = value.trim().toLowerCase().replace(/^\*\./, "").replace(/^www\./, "").replace(/\.$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

export class CarefulHosts {
  private readonly domains: Set<string>;
  private readonly seen = new Map<string, { loads: number; scrolls: number }>();

  constructor(domains: Iterable<string>, readonly source: string = "built-in defaults") {
    this.domains = new Set([...domains].map(normalizeDomain).filter((d): d is string => d !== null));
  }

  static load(log: (msg: string) => void = () => {}): CarefulHosts | null {
    if (process.env.ZEN_MCP_CAREFUL_HOSTS === "0") return null;
    const path = configPath();
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return new CarefulHosts(DEFAULT_CAREFUL_DOMAINS);
    }
    try {
      const parsed = JSON.parse(raw) as { domains?: unknown };
      if (!Array.isArray(parsed.domains) || !parsed.domains.every((d) => typeof d === "string")) {
        throw new Error('expected {"domains": ["x.com", ...]}');
      }
      return new CarefulHosts(parsed.domains as string[], path);
    } catch (err) {
      log(`careful-hosts: ${path} is malformed (${(err as Error).message}); using built-in defaults`);
      return new CarefulHosts(DEFAULT_CAREFUL_DOMAINS);
    }
  }

  /** The configured domain a host falls under (subdomains included), or null. */
  match(host: string): string | null {
    const h = host.toLowerCase().replace(/^www\./, "");
    if (this.domains.has(h)) return h;
    const reg = registrableDomain(h);
    if (reg && this.domains.has(reg)) return reg;
    // An entry may itself be a subdomain-scoped host (e.g. "old.reddit.com"); match its subtree.
    for (const d of this.domains) if (h.endsWith(`.${d}`)) return d;
    return null;
  }

  /** The text to put in front of this tool's result, or null when nothing applies. */
  notice(tool: string, host: string): string | null {
    const domain = this.match(host);
    if (!domain) return null;
    const first = !this.seen.has(domain);
    const counts = this.seen.get(domain) ?? { loads: 0, scrolls: 0 };
    if (LOADS.has(tool)) counts.loads += 1;
    if (SCROLLS.has(tool)) counts.scrolls += 1;
    this.seen.set(domain, counts);
    if (first) return fullNotice(domain, this.source);
    if (!LOADS.has(tool) && !SCROLLS.has(tool)) return null;
    return reminder(domain, counts);
  }
}

function fullNotice(domain: string, source: string): string {
  return [
    `[careful-site] ${domain}: this browser is signed in to the user's real account here, and the site's terms ban automated access. The risk to that account comes from how it is used:`,
    "• Read only. Never like, follow, reply, post, repost, DM, vote or change a setting.",
    "• A person's pace and volume: a few searches or pages, no scroll loops to load more, no repeated or scheduled runs.",
    "• If the site shows a rate limit, a captcha, \"this request looks like it might be automated\" or a locked-account page, stop and tell the user. Do not retry or work around it.",
    `(Careful-site list: ${source}.)`,
  ].join("\n");
}

function reminder(domain: string, c: { loads: number; scrolls: number }): string {
  const tally = `${c.loads} page load${c.loads === 1 ? "" : "s"}, ${c.scrolls} scroll${c.scrolls === 1 ? "" : "s"} on ${domain} this session`;
  if (c.loads + c.scrolls > HEAVY_SESSION_THRESHOLD) {
    return `[careful-site] ${tally}. That is more than a person browses; finish with what you have and stop. Read only.`;
  }
  return `[careful-site] ${tally}. Read only, person's pace; stop at any rate-limit or "automated" warning.`;
}
