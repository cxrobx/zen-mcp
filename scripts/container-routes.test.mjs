// Coverage for host -> container routing and tab reuse.
//
// The bug this guards: a URL's container was decided by which zen-* MCP entry happened to
// issue the call, so artistadvisory.io opened in no container from zen-ext and every call
// stacked another duplicate tab. Routing makes the DOMAIN decide the container, and open_url
// goes to the tab already on that host instead of opening a new one. Both halves have to fail
// loudly rather than quietly land a session in the wrong cookie jar.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { matchContainerRoute, reloadRouteTable, unmatchedConsoleClaim } from "../server/dist/routes.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PORT = 18768;

const CONTAINERS = [
  { cookieStoreId: "firefox-container-1", name: "Personal", color: "blue", icon: "fingerprint" },
  { cookieStoreId: "firefox-container-7", name: "Buildersbuddy", color: "orange", icon: "fence" },
  { cookieStoreId: "firefox-container-8", name: "Artist Advisory", color: "yellow", icon: "fruit" },
  { cookieStoreId: "firefox-container-9", name: "CXVentures", color: "toolbar", icon: "fingerprint" },
];

const ROUTE_FILE = {
  routes: {
    "Artist Advisory": ["artistadvisory.io", "localhost:3000"],
    CXVentures: ["cxventures.io"],
    Buildersbuddy: ["buildersbuddy.org"],
    "Ghost Container": ["ghost.example"],
  },
};

// Drives the live-tool-surface console tests: one shared host, two containers.
const CONSOLE_ROUTE_FILE = {
  containers: {
    "Artist Advisory": ["artistadvisory.io"],
    Buildersbuddy: ["buildersbuddy.org"],
  },
  consoles: ["search.google.com"],
};

function page({ tabId, index, url, title, container = null, active = false }) {
  const found = CONTAINERS.find((c) => c.name === container);
  return {
    tabId,
    windowId: 1,
    index,
    url,
    title,
    active,
    cookieStoreId: found?.cookieStoreId ?? "firefox-default",
    containerName: found?.name ?? null,
  };
}

// artistadvisory.io is open twice in its own container and once outside it; the outside tab
// is the trap - reuse must not touch a tab in the wrong cookie jar.
const TABS = () => [
  page({ tabId: 101, index: 0, url: "https://artistadvisory.io/", title: "AA", container: "Artist Advisory", active: true }),
  page({ tabId: 102, index: 1, url: "https://artistadvisory.io/artists", title: "Artists", container: "Artist Advisory" }),
  page({ tabId: 103, index: 2, url: "https://artistadvisory.io/marketing", title: "Marketing" }),
  page({ tabId: 104, index: 3, url: "https://cxventures.io/audit", title: "Audit", container: "Personal" }),
];

class StubExtension {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.tabs = TABS();
    // Tabs in OTHER Zen workspaces: absent from the plain list, reachable by id.
    this.hiddenTabs = [];
    this.requests = [];
    this.nextTabId = 500;
    // Firefox reports a brand-new tab as about:blank until its first navigation commits.
    // With this on, the stub reproduces that lag instead of resolving instantly.
    this.deferLoads = false;
  }

  reset() {
    this.tabs = TABS();
    this.hiddenTabs = [];
    this.requests = [];
    this.deferLoads = false;
  }

  /** Let a deferred tab finish loading, as the browser eventually would. */
  commit(tabId, url) {
    this.tabs = this.tabs.map((t) => (t.tabId === tabId ? { ...t, url } : t));
  }

  requestsFor(method) {
    return this.requests.filter((r) => r.method === method);
  }

  connect() {
    return new Promise((resolveP, rejectP) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => {
        this.ws.send(
          JSON.stringify({ type: "hello", protocolVersion: 1, role: "extension", token: this.token }),
        );
      });
      this.ws.on("error", rejectP);
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg.type === "welcome") return resolveP();
        if (msg.type === "unauthorized") return rejectP(new Error(`unauthorized: ${msg.reason}`));
        if (msg.type === "ping") return this.send({ type: "pong", ts: msg.ts });
        if (msg.type !== "request") return;
        this.requests.push({ method: msg.method, params: msg.params });
        this.send({ type: "response", id: msg.id, ...this.handle(msg) });
      });
    });
  }

  handle(msg) {
    switch (msg.method) {
      case "containers.list":
        return { result: { containers: CONTAINERS } };
      case "pages.list": {
        if (!msg.params?.includeHidden) return { result: { pages: this.tabs } };
        const hidden = this.hiddenTabs.map((t) => ({ ...t, inActiveWorkspace: false }));
        return { result: { pages: [...this.tabs, ...hidden] } };
      }
      case "pages.get": {
        const shown = this.tabs.find((t) => t.tabId === msg.params?.tabId);
        if (shown) return { result: { page: shown } };
        const hidden = this.hiddenTabs.find((t) => t.tabId === msg.params?.tabId);
        return { result: { page: hidden ? { ...hidden, inActiveWorkspace: false } : null } };
      }
      case "pages.new": {
        const store = msg.params?.cookieStoreId ?? "firefox-default";
        const container = CONTAINERS.find((c) => c.cookieStoreId === store);
        const tab = {
          tabId: this.nextTabId++,
          windowId: 1,
          index: this.tabs.length,
          url: this.deferLoads ? "about:blank" : msg.params.url,
          title: "",
          active: msg.params.active === true,
          cookieStoreId: store,
          containerName: container?.name ?? null,
        };
        this.tabs = [...this.tabs, tab];
        return {
          result: {
            tabId: tab.tabId,
            windowId: tab.windowId,
            url: tab.url,
            cookieStoreId: tab.cookieStoreId,
            containerName: tab.containerName,
          },
        };
      }
      case "pages.navigate": {
        const nav = (t) => (t.tabId === msg.params.tabId ? { ...t, url: msg.params.url } : t);
        this.tabs = this.tabs.map(nav);
        this.hiddenTabs = this.hiddenTabs.map(nav);
        return { result: { tabId: msg.params.tabId } };
      }
      case "pages.select":
      case "pages.close":
        return { result: { tabId: msg.params?.tabId } };
      case "info.get":
        return {
          result: {
            extensionId: "stub",
            extensionVersion: "0.0.0",
            userAgent: "stub",
            platform: "test",
            windowCount: 1,
            tabCount: this.tabs.length,
            containerCount: CONTAINERS.length,
            protocolVersion: 1,
          },
        };
      default:
        return { error: { code: -32601, message: `stub has no handler for ${msg.method}` } };
    }
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  close() {
    this.ws?.close();
  }
}

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.buf = "";
    this.pending = new Map();
    child.stdout.on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buf += chunk.toString("utf8");
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = this.pending.get(parsed.id);
      if (entry) {
        this.pending.delete(parsed.id);
        entry(parsed);
      }
    }
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`timeout: ${method}`));
      }, 15000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveP(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async callTool(name, args) {
    const r = await this.send("tools/call", { name, arguments: args ?? {} });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    const text = r.result?.content?.find?.((c) => c.type === "text")?.text ?? "";
    return { isError: r.result?.isError === true, text };
  }
}

let dir;
let routeFile;
let daemon;
let ext;
let unscoped;
let scoped;
let consoleServer;
let consoleRouteFile;
let mcp;
let mcpScoped;
let mcpConsole;

async function startServer(tokenPath, extraArgs, env) {
  const child = spawn(
    "node",
    [resolve(root, "server/dist/index.js"), "--port", String(PORT), "--token-file", tokenPath, ...extraArgs],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0", ...env },
    },
  );
  child.stderr.resume();
  await sleep(400);
  const client = new McpClient(child);
  await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "container-routes-test", version: "0.0.1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { child, client };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "zen-container-routes-"));
  routeFile = join(dir, "containers.json");
  await writeFile(routeFile, JSON.stringify(ROUTE_FILE, null, 2), "utf8");

  const tokenPath = join(dir, "auth.token");
  daemon = spawn(
    "node",
    [
      resolve(root, "daemon/dist/index.js"),
      "--port", String(PORT),
      "--token-file", tokenPath,
      "--nav-db", join(dir, "nav-memory"),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  daemon.stderr.resume();

  let token = "";
  for (let i = 0; i < 50 && !token; i++) {
    await sleep(100);
    token = await readFile(tokenPath, "utf8").then((t) => t.trim()).catch(() => "");
  }
  assert.ok(token, "daemon never wrote an auth token");

  // The daemon writes its token file before the WebSocket port is listening, so a connect
  // immediately after the token appears can be refused. Retry rather than fail the suite.
  ext = new StubExtension(`ws://127.0.0.1:${PORT}`, token);
  for (let attempt = 1; ; attempt++) {
    try {
      await ext.connect();
      break;
    } catch (err) {
      if (attempt >= 10) throw err;
      await sleep(200);
    }
  }

  const a = await startServer(tokenPath, [], { ZEN_MCP_ROUTES: routeFile });
  unscoped = a.child;
  mcp = a.client;

  // A container-scoped server, the zen-artist shape: routes must still win over its default.
  const b = await startServer(tokenPath, ["--container", "Personal"], { ZEN_MCP_ROUTES: routeFile });
  scoped = b.child;
  mcpScoped = b.client;

  // A third server on a consoles-shaped table, container-scoped so the claim has a session
  // default available to (wrongly) fall back to - that is the failure being guarded.
  consoleRouteFile = join(dir, "containers-consoles.json");
  await writeFile(consoleRouteFile, JSON.stringify(CONSOLE_ROUTE_FILE, null, 2), "utf8");
  const c = await startServer(tokenPath, ["--container", "Personal"], {
    ZEN_MCP_ROUTES: consoleRouteFile,
  });
  consoleServer = c.child;
  mcpConsole = c.client;
});

after(async () => {
  ext?.close();
  unscoped?.kill("SIGTERM");
  scoped?.kill("SIGTERM");
  consoleServer?.kill("SIGTERM");
  daemon?.kill("SIGTERM");
  await sleep(200);
  if (dir) await rm(dir, { recursive: true, force: true });
});

// --- pure matcher -----------------------------------------------------------------------

test("a rule matches its host and its subdomains, and pins ports when asked", async (t) => {
  const previous = process.env.ZEN_MCP_ROUTES;
  process.env.ZEN_MCP_ROUTES = routeFile;
  const table = reloadRouteTable();
  t.after(() => {
    if (previous === undefined) delete process.env.ZEN_MCP_ROUTES;
    else process.env.ZEN_MCP_ROUTES = previous;
    reloadRouteTable();
  });

  assert.equal(matchContainerRoute(table, "https://artistadvisory.io/artists")?.container, "Artist Advisory");
  assert.equal(matchContainerRoute(table, "https://www.artistadvisory.io/")?.container, "Artist Advisory");
  assert.equal(matchContainerRoute(table, "https://qes-deck.cxventures.io/")?.container, "CXVentures");
  assert.equal(matchContainerRoute(table, "http://localhost:3000/admin")?.container, "Artist Advisory");
  // The port-pinned rule must not swallow every other localhost port.
  assert.equal(matchContainerRoute(table, "http://localhost:3900/"), null);
  assert.equal(matchContainerRoute(table, "https://example.com/"), null);
  assert.equal(matchContainerRoute(table, "about:blank"), null);
  // A lookalike domain must not inherit the rule.
  assert.equal(matchContainerRoute(table, "https://notartistadvisory.io/"), null);
});

test("a more specific rule wins, and *. excludes the apex", async (t) => {
  const previous = process.env.ZEN_MCP_ROUTES;
  const file = join(dir, "specificity.json");
  await writeFile(
    file,
    JSON.stringify({
      routes: [
        { container: "Personal", match: ["example.com"] },
        { container: "CXVentures", match: ["docs.example.com"] },
        { container: "Buildersbuddy", match: ["*.only-subs.example"] },
      ],
    }),
    "utf8",
  );
  process.env.ZEN_MCP_ROUTES = file;
  const table = reloadRouteTable();
  t.after(() => {
    if (previous === undefined) delete process.env.ZEN_MCP_ROUTES;
    else process.env.ZEN_MCP_ROUTES = previous;
    reloadRouteTable();
  });

  assert.equal(matchContainerRoute(table, "https://docs.example.com/x")?.container, "CXVentures");
  assert.equal(matchContainerRoute(table, "https://other.example.com/x")?.container, "Personal");
  assert.equal(matchContainerRoute(table, "https://sub.only-subs.example/")?.container, "Buildersbuddy");
  assert.equal(matchContainerRoute(table, "https://only-subs.example/"), null);
});

test("a broken or absent route file reports itself instead of looking empty", async (t) => {
  const previous = process.env.ZEN_MCP_ROUTES;
  const broken = join(dir, "broken.json");
  await writeFile(broken, "{ not json", "utf8");
  t.after(() => {
    if (previous === undefined) delete process.env.ZEN_MCP_ROUTES;
    else process.env.ZEN_MCP_ROUTES = previous;
    reloadRouteTable();
  });

  process.env.ZEN_MCP_ROUTES = broken;
  const bad = reloadRouteTable();
  assert.equal(bad.rules.length, 0);
  assert.match(bad.error, /invalid JSON/);

  process.env.ZEN_MCP_ROUTES = join(dir, "does-not-exist.json");
  const missing = reloadRouteTable();
  assert.equal(missing.loaded, false);
  assert.equal(missing.error, null, "an absent file is the default state, not an error");

  process.env.ZEN_MCP_ROUTES = routeFile;
  process.env.ZEN_MCP_CONTAINER_ROUTES = "0";
  const off = reloadRouteTable();
  delete process.env.ZEN_MCP_CONTAINER_ROUTES;
  assert.equal(off.enabled, false);
  assert.equal(matchContainerRoute(off, "https://artistadvisory.io/"), null);
});

// --- containers + consoles: shared multi-project hosts -----------------------------------

/** Write a table to a fresh file, point the loader at it, restore afterwards. */
async function withTable(t, name, table) {
  const previous = process.env.ZEN_MCP_ROUTES;
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(table), "utf8");
  process.env.ZEN_MCP_ROUTES = file;
  t.after(() => {
    if (previous === undefined) delete process.env.ZEN_MCP_ROUTES;
    else process.env.ZEN_MCP_ROUTES = previous;
    reloadRouteTable();
  });
  return reloadRouteTable();
}

const CONSOLE_TABLE = {
  containers: {
    Geek: { domains: ["pocketbuddy.org", "teacherhero.org"] },
    // Shorthand: a bare list means domains only.
    "Artist Advisory": ["artistadvisory.io"],
  },
  consoles: ["search.google.com"],
};

test("a console URL routes by which container's domain it mentions", async (t) => {
  const table = await withTable(t, "consoles.json", CONSOLE_TABLE);
  assert.equal(table.error, null);

  // GSC's two property forms: percent-encoded sc-domain and URL-prefix.
  const scDomain =
    "https://search.google.com/search-console/index?resource_id=sc-domain%3Apocketbuddy.org";
  const urlPrefix =
    "https://search.google.com/search-console?resource_id=https%3A%2F%2Fartistadvisory.io%2F";
  assert.equal(matchContainerRoute(table, scDomain)?.container, "Geek");
  assert.equal(matchContainerRoute(table, scDomain)?.token, "pocketbuddy.org");
  assert.equal(matchContainerRoute(table, urlPrefix)?.container, "Artist Advisory");
  // Raw (already-decoded) form and a second domain of the same container.
  assert.equal(
    matchContainerRoute(table, "https://search.google.com/x?resource_id=sc-domain:teacherhero.org")
      ?.container,
    "Geek",
  );
  // Multi-account path segments do not matter; only host + mention do.
  assert.equal(
    matchContainerRoute(table, "https://search.google.com/u/1/search-console?resource_id=sc-domain%3Apocketbuddy.org")
      ?.container,
    "Geek",
  );
});

test("container domains are also plain host rules - no duplication in routes needed", async (t) => {
  const table = await withTable(t, "consoles-hosts.json", CONSOLE_TABLE);
  assert.equal(matchContainerRoute(table, "https://pocketbuddy.org/dashboard")?.container, "Geek");
  assert.equal(matchContainerRoute(table, "https://www.artistadvisory.io/")?.container, "Artist Advisory");
  assert.equal(matchContainerRoute(table, "https://example.com/"), null);
});

test("identifying strings match on token boundaries, not as bare substrings", async (t) => {
  const table = await withTable(t, "consoles-boundary.json", CONSOLE_TABLE);
  // The lookalike-domain trap, console edition.
  assert.equal(
    matchContainerRoute(table, "https://search.google.com/x?resource_id=sc-domain%3Anotpocketbuddy.org"),
    null,
  );
  // A registered domain that continues after the token is a different domain.
  assert.equal(
    matchContainerRoute(table, "https://search.google.com/x?resource_id=sc-domain%3Apocketbuddy.org.evil.com"),
    null,
  );
  // A leading dot is a subdomain of the same site and must match.
  assert.equal(
    matchContainerRoute(table, "https://search.google.com/x?resource_id=https%3A%2F%2Fwww.pocketbuddy.org%2F")
      ?.container,
    "Geek",
  );
});

test("the identifying string is searched in path+query+fragment only, never the host", async (t) => {
  // The bug this guards: a container owning a console's parent domain made every URL on
  // that console match its own hostname, so the claim never fired and one client's account
  // page opened in another's cookie jar.
  const table = await withTable(t, "consoles-hostspace.json", {
    containers: {
      CXVentures: { domains: ["stripe.com", "cxventures.io"] },
      QES: { aliases: ["acct_9z00"] },
    },
    consoles: ["dashboard.stripe.com"],
  });
  // An account page must reach its own container, not the one that happens to own the
  // provider's domain - the token must not be found inside "dashboard.stripe.com".
  const acct = matchContainerRoute(table, "https://dashboard.stripe.com/acct_9z00/payments");
  assert.equal(acct?.container, "QES");
  assert.equal(acct?.token, "acct_9z00");
  // The generic page has no account in it, so only the plain host rule from "stripe.com"
  // answers - a deliberate default, never a console-token match.
  const generic = matchContainerRoute(table, "https://dashboard.stripe.com/settings/account");
  assert.equal(generic?.container, "CXVentures");
  assert.equal(generic?.token, undefined, "must be the host rule, not an identity match");
});

test("userinfo cannot forge an identifying string", async (t) => {
  const table = await withTable(t, "consoles-userinfo.json", CONSOLE_TABLE);
  assert.equal(
    matchContainerRoute(table, "https://pocketbuddy.org@search.google.com/search-console/welcome"),
    null,
    "the token lives in the credentials segment, not in the page identity",
  );
  assert.ok(
    unmatchedConsoleClaim(table, "https://pocketbuddy.org@search.google.com/search-console/welcome"),
  );
});

test("a *. domain's console token means the same thing as its host rule", async (t) => {
  const table = await withTable(t, "consoles-wildcard.json", {
    containers: { "Artist Advisory": ["*.artistadvisory.io"] },
    consoles: ["search.google.com"],
  });
  const gsc = (prop) => `https://search.google.com/x?resource_id=https%3A%2F%2F${prop}%2F`;
  // Subdomains match in both mechanisms...
  assert.equal(matchContainerRoute(table, "https://www.artistadvisory.io/")?.container, "Artist Advisory");
  assert.equal(matchContainerRoute(table, gsc("www.artistadvisory.io"))?.container, "Artist Advisory");
  // ...and the apex is excluded in both. Before the fix the token was the bare apex, so the
  // console matched the very URL the host rule refuses.
  assert.equal(matchContainerRoute(table, "https://artistadvisory.io/"), null);
  assert.equal(matchContainerRoute(table, gsc("artistadvisory.io")), null);
  // The lookalike trap still holds for a dot-prefixed token.
  assert.equal(matchContainerRoute(table, gsc("evil.artistadvisory.io.evil.com")), null);
});

test("a console host with no mention is claimed: no match, loud claim, no fallback", async (t) => {
  const table = await withTable(t, "consoles-claim.json", CONSOLE_TABLE);
  const picker = "https://search.google.com/search-console/welcome";
  assert.equal(matchContainerRoute(table, picker), null);
  const claim = unmatchedConsoleClaim(table, picker);
  assert.equal(claim?.console, "search.google.com");
  assert.deepEqual(claim?.containers, ["Geek", "Artist Advisory"]);
  // Ordinary unmatched hosts are not claimed - they still fall through quietly.
  assert.equal(unmatchedConsoleClaim(table, "https://example.com/"), null);
});

test("a plain routes rule on a console host is the explicit default, disabling the claim", async (t) => {
  const table = await withTable(t, "consoles-default.json", {
    ...CONSOLE_TABLE,
    routes: { Geek: ["search.google.com"] },
  });
  // The bare picker now lands somewhere deliberate instead of erroring...
  const picker = "https://search.google.com/search-console/welcome";
  assert.equal(matchContainerRoute(table, picker)?.container, "Geek");
  assert.equal(unmatchedConsoleClaim(table, picker), null, "claim only applies when nothing matched");
  // ...while property URLs still outrank it and route per-project.
  assert.equal(
    matchContainerRoute(table, "https://search.google.com/x?resource_id=sc-domain%3Aartistadvisory.io")
      ?.container,
    "Artist Advisory",
  );
});

test("aliases route console URLs that carry account ids instead of domains", async (t) => {
  const table = await withTable(t, "consoles-alias.json", {
    containers: {
      CXVentures: { domains: ["cxventures.io"], aliases: ["acct_1abc99"] },
      Geek: ["pocketbuddy.org"],
    },
    consoles: ["dashboard.stripe.com"],
  });
  assert.equal(
    matchContainerRoute(table, "https://dashboard.stripe.com/acct_1abc99/payments")?.container,
    "CXVentures",
  );
  // Alias boundaries: a longer id sharing the prefix is a different account.
  assert.equal(matchContainerRoute(table, "https://dashboard.stripe.com/acct_1abc99x/payments"), null);
  // An alias is an identifying string, never a host rule of its own.
  assert.equal(matchContainerRoute(table, "https://acct_1abc99/"), null);
  assert.equal(unmatchedConsoleClaim(table, "https://acct_1abc99/"), null);
});

test("two containers mentioned at equal specificity: first wins and says so", async (t) => {
  const table = await withTable(t, "consoles-ambiguous.json", {
    containers: { Personal: ["aaaa.com"], Geek: ["bbbb.com"] },
    consoles: ["console.example"],
  });
  const both = "https://console.example/compare?left=aaaa.com&right=bbbb.com";
  const match = matchContainerRoute(table, both);
  assert.equal(match?.container, "Personal");
  assert.equal(match?.ambiguousWith, "Geek");
});

test("a URL that cannot be percent-decoded still matches on its raw text", async (t) => {
  const table = await withTable(t, "consoles-decode.json", CONSOLE_TABLE);
  // %E0%A4%A is a malformed escape: decodeURIComponent throws, the matcher falls back raw.
  assert.equal(
    matchContainerRoute(table, "https://search.google.com/x?bad=%E0%A4%A&resource_id=sc-domain:pocketbuddy.org")
      ?.container,
    "Geek",
  );
});

test("containers/consoles misconfigurations report themselves instead of misrouting", async (t) => {
  const shortAlias = await withTable(t, "consoles-bad-alias.json", {
    containers: { Geek: { domains: ["pocketbuddy.org"], aliases: ["ab"] } },
    consoles: ["search.google.com"],
  });
  assert.match(shortAlias.error, /shorter than/);
  assert.equal(shortAlias.rules.length, 0);

  const wildcardAlias = await withTable(t, "consoles-bad-wildcard.json", {
    containers: { Geek: { domains: ["pocketbuddy.org"], aliases: ["acct_*"] } },
    consoles: ["search.google.com"],
  });
  assert.match(wildcardAlias.error, /no wildcards/);

  const orphanConsoles = await withTable(t, "consoles-orphan.json", {
    routes: { Geek: ["pocketbuddy.org"] },
    consoles: ["search.google.com"],
  });
  assert.match(orphanConsoles.error, /"containers" section/);
});

// --- routing through the live tool surface -----------------------------------------------

test("open_url reuses the open tab on that host in the owning container", async () => {
  ext.reset();
  const created = ext.requestsFor("pages.new").length;
  const { isError, text } = await mcp.callTool("open_url", { url: "https://artistadvisory.io/marketing" });

  assert.equal(isError, false, text);
  assert.match(text, /^reused tabId=101 /);
  assert.match(text, /container: Artist Advisory \(firefox-container-8\) via route "artistadvisory\.io"/);
  const nav = ext.requestsFor("pages.navigate").at(-1);
  assert.equal(nav.params.tabId, 101, "must land on the active tab in the routed container");
  assert.equal(ext.requestsFor("pages.new").length, created, "no duplicate tab may be opened");
});

test("open_url never reuses a same-host tab that sits in the wrong container", async () => {
  ext.reset();
  // tabId 103 is on artistadvisory.io but in no container; 104 is cxventures.io in Personal.
  const { isError, text } = await mcp.callTool("open_url", { url: "https://cxventures.io/proposals" });

  assert.equal(isError, false, text);
  assert.match(text, /^new page tabId=\d+ /);
  assert.match(text, /container: CXVentures \(firefox-container-9\)/);
  const created = ext.requestsFor("pages.new").at(-1);
  assert.equal(created.params.cookieStoreId, "firefox-container-9");
  assert.equal(
    ext.requestsFor("pages.navigate").filter((r) => r.params.tabId === 104).length,
    0,
    "the Personal-container cxventures tab must be left alone",
  );
});

test("open_url on a URL already open just reports the tab and navigates nothing", async () => {
  ext.reset();
  const navs = ext.requestsFor("pages.navigate").length;
  const news = ext.requestsFor("pages.new").length;
  const selects = ext.requestsFor("pages.select").length;

  const { isError, text } = await mcp.callTool("open_url", { url: "https://artistadvisory.io/artists" });

  assert.equal(isError, false, text);
  assert.match(text, /^found tabId=102 /);
  assert.match(text, /already open at this URL/);
  assert.equal(ext.requestsFor("pages.navigate").length, navs);
  assert.equal(ext.requestsFor("pages.new").length, news);
  assert.equal(ext.requestsFor("pages.select").length, selects, "background by default");
});

// --- other Zen workspaces --------------------------------------------------------------------
// The 2026-09-02 incident: a logged-in resend.com tab sat in the Artist Advisory container
// but in another workspace; open_url could not see it and opened a fresh tab that landed on
// the login page. Reuse now looks in the other workspaces after the visible one.

test("open_url reuses a logged-in tab in another workspace instead of opening a login page", async () => {
  ext.reset();
  ext.hiddenTabs = [
    page({ tabId: 597, index: 0, url: "https://artistadvisory.io/settings", title: "Settings", container: "Artist Advisory" }),
  ];
  const news = ext.requestsFor("pages.new").length;
  const selects = ext.requestsFor("pages.select").length;

  const { isError, text } = await mcp.callTool("open_url", {
    url: "https://artistadvisory.io/settings",
    reuse: "exact",
  });

  assert.equal(isError, false, text);
  assert.match(text, /^found tabId=597 .*\[in another Zen workspace\]/);
  assert.match(text, /already open at this URL in another Zen workspace - left in place/);
  assert.equal(ext.requestsFor("pages.new").length, news, "no login-page tab may be opened");
  assert.equal(ext.requestsFor("pages.select").length, selects, "background: no workspace switch");

  const focused = await mcp.callTool("open_url", {
    url: "https://artistadvisory.io/settings",
    reuse: "exact",
    active: true,
  });
  assert.equal(focused.isError, false, focused.text);
  assert.match(focused.text, /Zen switched workspace/);
  assert.equal(ext.requestsFor("pages.select").at(-1).params.tabId, 597);
});

test("open_url navigates an other-workspace host tab in place when the active workspace has none", async () => {
  ext.reset();
  ext.hiddenTabs = [
    page({ tabId: 598, index: 0, url: "https://buildersbuddy.org/deals", title: "Deals", container: "Buildersbuddy" }),
  ];
  const news = ext.requestsFor("pages.new").length;

  const { isError, text } = await mcp.callTool("open_url", { url: "https://buildersbuddy.org/deals/new" });

  assert.equal(isError, false, text);
  assert.match(text, /^reused tabId=598 .*\[in another Zen workspace\]/);
  assert.match(text, /in another Zen workspace \(1 matched; was https:\/\/buildersbuddy\.org\/deals\)/);
  assert.equal(ext.requestsFor("pages.navigate").at(-1).params.tabId, 598);
  assert.equal(ext.requestsFor("pages.new").length, news);
});

test("a tab in the active workspace always outranks one in another workspace", async () => {
  ext.reset();
  ext.hiddenTabs = [
    page({ tabId: 599, index: 0, url: "https://artistadvisory.io/marketing", title: "Exact", container: "Artist Advisory" }),
  ];
  const { isError, text } = await mcp.callTool("open_url", { url: "https://artistadvisory.io/marketing" });
  assert.equal(isError, false, text);
  assert.match(text, /^reused tabId=101 /, "host mode: the visible tab is navigated, the hidden exact match is not consulted");
  assert.equal(ext.requestsFor("pages.navigate").filter((r) => r.params.tabId === 599).length, 0);
});

test("wrong-container tabs in other workspaces are never reused either", async () => {
  ext.reset();
  ext.hiddenTabs = [
    page({ tabId: 600, index: 0, url: "https://cxventures.io/proposals", title: "Wrong jar", container: "Personal" }),
  ];
  const { isError, text } = await mcp.callTool("open_url", { url: "https://cxventures.io/proposals" });
  assert.equal(isError, false, text);
  assert.match(text, /^new page tabId=\d+ /);
  assert.match(text, /in any Zen workspace - opened a new one/);
  assert.equal(ext.requestsFor("pages.navigate").filter((r) => r.params.tabId === 600).length, 0);
});

test("active=true focuses the tab it landed on", async () => {
  ext.reset();
  const { isError, text } = await mcp.callTool("open_url", {
    url: "https://artistadvisory.io/artists",
    active: true,
  });
  assert.equal(isError, false, text);
  assert.equal(ext.requestsFor("pages.select").at(-1).params.tabId, 102);
});

test("reuse modes: exact declines a host-only match, never always opens", async () => {
  ext.reset();
  const exact = await mcp.callTool("open_url", {
    url: "https://artistadvisory.io/reports",
    reuse: "exact",
  });
  assert.equal(exact.isError, false, exact.text);
  assert.match(exact.text, /^new page tabId=\d+ /);
  assert.match(exact.text, /no tab at that exact URL/);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-8");

  ext.reset();
  const never = await mcp.callTool("open_url", {
    url: "https://artistadvisory.io/artists",
    reuse: "never",
  });
  assert.equal(never.isError, false, never.text);
  assert.match(never.text, /^new page tabId=\d+ /);
  assert.equal(ext.requestsFor("pages.navigate").length, 0);
});

test("a second open_url before the first tab has loaded does not duplicate it", async () => {
  // Regression: a new tab reports about:blank until its navigation commits, so the follow-up
  // call saw no tab on that host and opened another one. Caught by the live probe, not the
  // stub, because the stub used to resolve loads instantly.
  ext.reset();
  ext.deferLoads = true;
  const url = "https://buildersbuddy.org/deals/42";

  const first = await mcp.callTool("open_url", { url });
  assert.equal(first.isError, false, first.text);
  assert.match(first.text, new RegExp(`^new page tabId=\\d+ -> ${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), "must report the URL it asked for, not about:blank");
  const tabId = Number(/tabId=(\d+)/.exec(first.text)[1]);
  const created = ext.requestsFor("pages.new").length;

  const second = await mcp.callTool("open_url", { url });
  assert.equal(second.isError, false, second.text);
  assert.match(second.text, new RegExp(`^found tabId=${tabId} `));
  assert.match(second.text, /still loading/);
  assert.equal(ext.requestsFor("pages.new").length, created, "no duplicate while the first tab loads");

  // Same host, different path, still mid-load: navigate that tab rather than opening another.
  const third = await mcp.callTool("open_url", { url: "https://buildersbuddy.org/deals/43" });
  assert.match(third.text, new RegExp(`^reused tabId=${tabId} `));
  assert.equal(ext.requestsFor("pages.new").length, created);

  // Once the browser catches up, the tab's own URL takes over again.
  ext.commit(tabId, "https://buildersbuddy.org/deals/43");
  const fourth = await mcp.callTool("open_url", { url: "https://buildersbuddy.org/deals/43" });
  assert.match(fourth.text, new RegExp(`^found tabId=${tabId} `));
  assert.doesNotMatch(fourth.text, /still loading/);
});

test("a host rule outranks the session default container", async () => {
  ext.reset();
  // This server was started with --container Personal.
  const routed = await mcpScoped.callTool("open_url", { url: "https://buildersbuddy.org/deals" });
  assert.equal(routed.isError, false, routed.text);
  assert.match(routed.text, /container: Buildersbuddy \(firefox-container-7\) via route "buildersbuddy\.org"/);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-7");

  // An unrouted host still falls back to the session default.
  const fallback = await mcpScoped.callTool("open_url", { url: "https://unmapped.example/x" });
  assert.equal(fallback.isError, false, fallback.text);
  assert.match(fallback.text, /container: Personal \(firefox-container-1\) via the session default container/);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-1");
});

test("new_page follows the same table, and new_page_in_container overrides it out loud", async () => {
  ext.reset();
  const routed = await mcp.callTool("new_page", { url: "https://artistadvisory.io/pricing" });
  assert.equal(routed.isError, false, routed.text);
  assert.match(routed.text, /^new page tabId=\d+ -> https:\/\/artistadvisory\.io\/pricing \(Artist Advisory\)/);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-8");

  const forced = await mcp.callTool("new_page_in_container", {
    name: "Personal",
    url: "https://artistadvisory.io/pricing",
  });
  assert.equal(forced.isError, false, forced.text);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-1");
  assert.match(forced.text, /route "artistadvisory\.io" maps this URL to "Artist Advisory"/);
});

test("navigate_page says so when it is about to load a URL into the wrong container", async () => {
  ext.reset();
  const { isError, text } = await mcp.callTool("navigate_page", {
    tabId: 104,
    url: "https://artistadvisory.io/artists",
  });
  assert.equal(isError, false, text);
  assert.match(text, /cannot be moved/);
  assert.match(text, /Use open_url/);
});

test("a route naming a container that does not exist fails loudly and opens nothing", async () => {
  ext.reset();
  const news = ext.requestsFor("pages.new").length;
  const { isError, text } = await mcp.callTool("open_url", { url: "https://ghost.example/" });

  assert.equal(isError, true, "a typo in the table must not silently fall back to another jar");
  assert.match(text, /Ghost Container/);
  assert.match(text, /does not exist/);
  assert.equal(ext.requestsFor("pages.new").length, news, "nothing may be opened");
});

// --- consoles through the live tool surface ----------------------------------------------
// These run against mcpConsole (CONSOLE_ROUTE_FILE, --container Personal). The session
// default exists precisely so a silent fallback would be possible - and must not happen.

test("open_url routes a console URL by the property named in it", async () => {
  ext.reset();
  const aa = await mcpConsole.callTool("open_url", {
    url: "https://search.google.com/search-console?resource_id=sc-domain%3Aartistadvisory.io",
  });
  assert.equal(aa.isError, false, aa.text);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-8");
  assert.match(aa.text, /console "search\.google\.com" \+ "artistadvisory\.io"/);
  // The advisory text must not be double-quoted into gibberish.
  assert.doesNotMatch(aa.text, /route "console /);

  // Same host, different property -> the other container, never the session default.
  const bb = await mcpConsole.callTool("open_url", {
    url: "https://search.google.com/search-console?resource_id=sc-domain%3Abuildersbuddy.org",
  });
  assert.equal(bb.isError, false, bb.text);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-7");
});

test("a claimed console URL that names nothing fails loudly and opens nothing", async () => {
  ext.reset();
  const news = ext.requestsFor("pages.new").length;
  const { isError, text } = await mcpConsole.callTool("open_url", {
    url: "https://search.google.com/search-console/welcome",
  });

  assert.equal(isError, true, "must not fall back to the session default container");
  assert.match(text, /search\.google\.com/);
  assert.match(text, /Artist Advisory, Buildersbuddy/, "says which containers were tried");
  assert.match(text, /container explicitly/, "names the escape hatch");
  assert.equal(ext.requestsFor("pages.new").length, news, "nothing may be opened");
  assert.doesNotMatch(text, /Personal/, "the session default must not be reached at all");

  // new_page shares decideContainer, so it must refuse identically.
  const viaNew = await mcpConsole.callTool("new_page", {
    url: "https://search.google.com/search-console/welcome",
  });
  assert.equal(viaNew.isError, true, viaNew.text);
  assert.equal(ext.requestsFor("pages.new").length, news, "still nothing opened");
});

test("an explicit container argument bypasses the claim", async () => {
  ext.reset();
  const { isError, text } = await mcpConsole.callTool("open_url", {
    url: "https://search.google.com/search-console/welcome",
    container: "Artist Advisory",
  });
  assert.equal(isError, false, text);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-8");
  assert.match(text, /the container argument/);
});

test("new_page_in_container's disagreement note stays readable for a console rule", async () => {
  ext.reset();
  const { isError, text } = await mcpConsole.callTool("new_page_in_container", {
    name: "Buildersbuddy",
    url: "https://search.google.com/search-console?resource_id=sc-domain%3Aartistadvisory.io",
  });
  assert.equal(isError, false, text);
  assert.equal(ext.requestsFor("pages.new").at(-1).params.cookieStoreId, "firefox-container-7");
  assert.match(text, /note: console "search\.google\.com" \+ "artistadvisory\.io" maps this URL to "Artist Advisory"/);
  assert.doesNotMatch(text, /route "console /, "a console pattern must not be quoted twice");
});

test("container_routes explains a claim instead of promising a fallback", async () => {
  const claimed = await mcpConsole.callTool("container_routes", {
    url: "https://search.google.com/search-console/welcome",
  });
  assert.equal(claimed.isError, false, claimed.text);
  assert.match(claimed.text, /CLAIMED by console host "search\.google\.com"/);
  assert.doesNotMatch(claimed.text, /falls back to/);

  const routed = await mcpConsole.callTool("container_routes", {
    url: "https://search.google.com/x?resource_id=sc-domain%3Abuildersbuddy.org",
  });
  assert.match(routed.text, /via console "search\.google\.com" \+ "buildersbuddy\.org"/);
  assert.match(routed.text, /container exists: Buildersbuddy/);
  assert.match(routed.text, /consoles \(shared hosts/, "the table view names the console section");
});

test("container_routes reports the table and resolves one URL", async () => {
  const listed = await mcp.callTool("container_routes");
  assert.equal(listed.isError, false, listed.text);
  assert.match(listed.text, /Artist Advisory: artistadvisory\.io, localhost:3000/);
  assert.match(listed.text, /5 rules from /);

  const resolved = await mcp.callTool("container_routes", { url: "https://cxventures.io/audit" });
  assert.match(resolved.text, /-> "CXVentures" via rule "cxventures\.io"/);
  assert.match(resolved.text, /container exists: CXVentures \(firefox-container-9\)/);

  const unmapped = await mcp.callTool("container_routes", { url: "https://example.org/" });
  assert.match(unmapped.text, /no matching rule/);
});

test("list_pages can filter by container without renumbering positions", async () => {
  ext.reset();
  const all = await mcp.callTool("list_pages");
  const fingerprint = /tabSet=([0-9a-f]{8})/.exec(all.text)[1];

  const filtered = await mcp.callTool("list_pages", { container: "Artist Advisory" });
  assert.equal(filtered.isError, false, filtered.text);
  assert.match(filtered.text, new RegExp(`tabSet=${fingerprint}`), "fingerprint covers the full set");
  assert.match(filtered.text, /Showing 2 of 4/);
  assert.match(filtered.text, /\[0\] tabId=101/);
  assert.match(filtered.text, /\[1\] tabId=102/);
  assert.doesNotMatch(filtered.text, /tabId=103/);

  const none = await mcp.callTool("list_pages", { container: "none" });
  assert.match(none.text, /\[2\] tabId=103/, "positions stay anchored to the full listing");
  assert.doesNotMatch(none.text, /tabId=101/);
});

test("select_page uses the container to break a url tie", async () => {
  ext.reset();
  const ambiguous = await mcp.callTool("select_page", { url: "artistadvisory.io" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /pages match url/);

  const disambiguated = await mcp.callTool("select_page", {
    url: "artistadvisory.io/marketing",
    container: "none",
  });
  assert.equal(disambiguated.isError, false, disambiguated.text);
  assert.match(disambiguated.text, /selected tabId=103/);
});

test("get_firefox_info reports the route table state", async () => {
  const { isError, text } = await mcp.callTool("get_firefox_info");
  assert.equal(isError, false, text);
  assert.match(text, /mcp\.containerRoutes: 5 rules from /);
});
