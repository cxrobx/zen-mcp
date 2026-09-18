// End-to-end coverage for interactive_elements, wait_for(stable) and navigate_goal, through
// the real MCP server and daemon with a stub extension, a fake TypeSafe endpoint, and a fake
// `security` binary. No browser, no network, no real Keychain.
//
// What must hold, because navigate_goal sends page data OFF this machine and clicks in a
// live, logged-in browser:
//   - an unlisted host, a financial site, an absent allowlist, or a malformed one sends
//     NOTHING - not even a Keychain lookup for the key;
//   - the key reaches TypeSafe as a bearer token and never appears in a tool response, even
//     when TypeSafe echoes it back in an error;
//   - typed field values never reach TypeSafe;
//   - an upstream failure is loud and clicks nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PORT = 18775;
const FAKE_KEY = "ts-fake-key-0123456789abcdef";
const TYPED_VALUE = "typed-value-that-must-stay-local";
const ACCOUNT_EMAIL = "chris@private.example";

const HOME_URL = "https://dashboard.example.com/acct/home";
const WEBHOOKS_URL = "https://dashboard.example.com/acct/webhooks";

// Mimics `security find-generic-password -s cx-secret -a NAME -w`, and logs every lookup so
// a test can prove a refused call never reached the Keychain at all.
const fakeSecurity = (logPath, knows) => `#!/bin/sh
name=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-a" ]; then name="$arg"; fi
  prev="$arg"
done
echo "$name" >> "${logPath}"
if [ "${knows ? "1" : "0"}" = "1" ] && [ "$name" = "TYPESAFE_API_KEY" ]; then
  echo "${FAKE_KEY}"
  exit 0
fi
exit 44
`;

let uidCounter = 0;
function node(tag, props = {}, children = []) {
  return { uid: props.uid ?? `9_${uidCounter++}`, tag, children, ...props };
}

function homeTree() {
  return node("body", { uid: "9_root" }, [
    node("header", { uid: "9_banner" }, [
      node("a", {
        uid: "9_account",
        role: "button",
        href: "https://accounts.example.net/SignOutOptions",
        name: `Account: Chris (${ACCOUNT_EMAIL})`,
      }),
    ]),
    node("nav", { uid: "9_nav" }, [
      node("a", { uid: "9_home", href: HOME_URL, text: "Home" }),
      node("a", { uid: "9_hooks", href: `${WEBHOOKS_URL}?tab=all` }, [node("span", { uid: "9_hooks_t", text: "Webhooks" })]),
    ]),
    node("table", { uid: "9_tbl" }, [
      node("tr", { uid: "9_r1" }, [
        node("td", { uid: "9_r1c", text: "ACH Direct Debit" }),
        node("td", { uid: "9_r1b" }, [node("button", { uid: "9_edit1", text: "Edit" })]),
      ]),
      node("tr", { uid: "9_r2" }, [
        node("td", { uid: "9_r2c", text: "Cards" }),
        node("td", { uid: "9_r2b" }, [node("button", { uid: "9_edit2", text: "Edit" })]),
      ]),
    ]),
    node("input", { uid: "9_search", name: "Search", value: TYPED_VALUE }),
    node("button", { uid: "9_delete", text: "Delete account" }),
  ]);
}

function webhooksTree() {
  return node("body", { uid: "9_root2" }, [
    node("h1", { uid: "9_h1", text: "Webhooks" }),
    node("button", { uid: "9_add", text: "Add endpoint" }),
  ]);
}

function uidMapOf(tree) {
  const out = [];
  const walk = (n) => {
    out.push({ uid: n.uid, css: n.tag });
    n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

const initialTabs = () => [
  { tabId: 301, windowId: 1, index: 0, url: HOME_URL, title: "Home", active: true, cookieStoreId: "firefox-default", containerName: null },
  { tabId: 302, windowId: 1, index: 1, url: "https://mail.example.com/inbox", title: "Inbox", active: false, cookieStoreId: "firefox-default", containerName: null },
  { tabId: 303, windowId: 1, index: 2, url: "https://dashboard.example.com/live", title: "Live", active: false, cookieStoreId: "firefox-default", containerName: null },
  { tabId: 304, windowId: 1, index: 3, url: "https://dashboard.stripe.com/acct_1/payments", title: "Payments", active: false, cookieStoreId: "firefox-default", containerName: null },
];

class StubExtension {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.reset();
  }

  reset() {
    this.tabs = initialTabs();
    this.requests = [];
    this.churn = 0;
  }

  requestsFor(method) {
    return this.requests.filter((r) => r.method === method);
  }

  connect() {
    return new Promise((resolveP, rejectP) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, role: "extension", token: this.token }));
      });
      this.ws.on("error", rejectP);
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg.type === "welcome") return resolveP();
        if (msg.type === "unauthorized") return rejectP(new Error(`unauthorized: ${msg.reason}`));
        if (msg.type === "ping") return this.ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
        if (msg.type !== "request") return;
        this.requests.push({ method: msg.method, params: msg.params });
        this.ws.send(JSON.stringify({ type: "response", id: msg.id, ...this.handle(msg) }));
      });
    });
  }

  tab(tabId) {
    return this.tabs.find((t) => t.tabId === tabId);
  }

  handle(msg) {
    const p = msg.params ?? {};
    switch (msg.method) {
      case "containers.list":
        return { result: { containers: [] } };
      case "pages.list":
        return { result: { pages: this.tabs } };
      case "pages.get":
        return { result: { page: this.tab(p.tabId) ?? null } };
      case "dom.evaluate": {
        // The stable probe. Tab 303 never stops re-rendering.
        const count = p.tabId === 303 ? ++this.churn : this.tab(p.tabId)?.url === WEBHOOKS_URL ? 2 : 6;
        return { result: { result: ["complete", count] } };
      }
      case "dom.takeSnapshot": {
        const tree = this.tab(p.tabId)?.url === WEBHOOKS_URL ? webhooksTree() : homeTree();
        return { result: { tabId: p.tabId, snapshotId: 1, tree, uidMap: uidMapOf(tree), truncated: false } };
      }
      case "dom.click": {
        const tab = this.tab(p.tabId);
        const navigated = p.uid === "9_hooks";
        if (navigated) {
          tab.url = WEBHOOKS_URL;
          tab.title = "Webhooks";
        }
        return { result: { tabId: p.tabId, feedback: { url: tab.url, title: tab.title, navigated } } };
      }
      default:
        return { error: { code: -32601, message: `stub has no handler for ${msg.method}` } };
    }
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
      }, 30000);
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

// --- fake TypeSafe -------------------------------------------------------------------

const jev = { requests: [], replies: [], warmups: [] };

function noul(p) {
  return { type: "noul", noul: p };
}

function jevBody(answers) {
  return { status: 200, body: { model: "jev-test", answers, usage: { input_tokens: 120, output_tokens: 12 } } };
}

let dir;
let daemon;
let ext;
let fakeJev;
let jevUrl;
const servers = [];
const clients = {};

async function startServer(tokenPath, env) {
  const child = spawn("node", [resolve(root, "server/dist/index.js"), "--port", String(PORT), "--token-file", tokenPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0", ZEN_MCP_TYPESAFE_URL: jevUrl, ...env },
  });
  child.stderr.resume();
  await sleep(400);
  const client = new McpClient(child);
  await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "navigate-goal-test", version: "0.0.1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  servers.push(child);
  return client;
}

async function keychainLookups(name) {
  return (await readFile(join(dir, `${name}.log`), "utf8").catch(() => "")).split("\n").filter(Boolean);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "zen-navigate-goal-"));

  fakeJev = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method !== "POST") {
        // The connection warm-up: no body, no page data, and it must not consume a scripted reply.
        jev.warmups.push({ method: req.method, auth: req.headers.authorization, raw });
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end("{}");
        return;
      }
      jev.requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      const next = jev.replies.shift() ?? { status: 500, body: { detail: "test scripted no reply" } };
      res.writeHead(next.status, { "Content-Type": "application/json" });
      res.end(typeof next.body === "string" ? next.body : JSON.stringify(next.body));
    });
  });
  await new Promise((r) => fakeJev.listen(0, "127.0.0.1", r));
  jevUrl = `http://127.0.0.1:${fakeJev.address().port}/v1/systemone`;

  const allowlist = join(dir, "jev.json");
  await writeFile(allowlist, JSON.stringify({ hosts: ["dashboard.example.com"] }), "utf8");
  const broken = join(dir, "jev-broken.json");
  await writeFile(broken, '{"hosts": ["https://dashboard.example.com/"]}', "utf8");

  const withKey = join(dir, "security-with-key.sh");
  await writeFile(withKey, fakeSecurity(join(dir, "with-key.log"), true), "utf8");
  await chmod(withKey, 0o755);
  const noKey = join(dir, "security-no-key.sh");
  await writeFile(noKey, fakeSecurity(join(dir, "no-key.log"), false), "utf8");
  await chmod(noKey, 0o755);

  const tokenPath = join(dir, "auth.token");
  daemon = spawn(
    "node",
    [resolve(root, "daemon/dist/index.js"), "--port", String(PORT), "--token-file", tokenPath, "--nav-db", join(dir, "nav-memory")],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  daemon.stderr.resume();
  let token = "";
  for (let i = 0; i < 50 && !token; i++) {
    await sleep(100);
    token = await readFile(tokenPath, "utf8").then((t) => t.trim()).catch(() => "");
  }
  assert.ok(token, "daemon never wrote an auth token");

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

  clients.main = await startServer(tokenPath, { ZEN_MCP_JEV_CONFIG: allowlist, ZEN_MCP_SECRET_BIN: withKey });
  clients.noConfig = await startServer(tokenPath, { ZEN_MCP_JEV_CONFIG: join(dir, "absent.json"), ZEN_MCP_SECRET_BIN: withKey });
  clients.badConfig = await startServer(tokenPath, { ZEN_MCP_JEV_CONFIG: broken, ZEN_MCP_SECRET_BIN: withKey });
  clients.noKey = await startServer(tokenPath, { ZEN_MCP_JEV_CONFIG: allowlist, ZEN_MCP_SECRET_BIN: noKey });
});

after(async () => {
  ext?.close();
  for (const child of servers) child.kill("SIGTERM");
  daemon?.kill("SIGTERM");
  fakeJev?.close();
  await sleep(200);
  if (dir) await rm(dir, { recursive: true, force: true });
});

function resetWorld() {
  ext.reset();
  jev.requests.length = 0;
  jev.replies.length = 0;
  jev.warmups.length = 0;
}

test("interactive_elements lists controls with labels, destinations and row context, never values", async () => {
  resetWorld();
  const r = await clients.main.callTool("interactive_elements", { tabId: 301 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /9_hooks link "Webhooks" -> \/acct\/webhooks in nav/);
  assert.match(r.text, /9_edit1 button "Edit" in row "ACH Direct Debit" \(same label elsewhere\)/);
  assert.match(r.text, /9_edit2 button "Edit" in row "Cards"/);
  assert.match(r.text, /9_search input "Search"/);
  assert.equal(r.text.includes(TYPED_VALUE), false, "a typed field value leaked into the listing");
  assert.equal(r.text.includes("tab=all"), false, "query strings are dropped from destinations");
  assert.equal(ext.requestsFor("dom.takeSnapshot").length, 1);
});

test("wait_for stable resolves once the control count holds", async () => {
  resetWorld();
  const r = await clients.main.callTool("wait_for", { tabId: 301, condition: "stable", stableMs: 300 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Stable after \d+ms \(6 interactive controls unchanged for 300ms\)/);
});

test("wait_for stable times out loudly on a page that never settles", async () => {
  resetWorld();
  const r = await clients.main.callTool("wait_for", { tabId: 303, condition: "stable", stableMs: 300, timeout: 1200 });
  assert.equal(r.isError, true);
  assert.match(r.text, /TIMEOUT.*never held for 300ms/);
  assert.match(r.text, /selector_visible or text instead/);
});

test("navigate_goal on an unlisted host sends nothing and never reads the key", async () => {
  resetWorld();
  const before = (await keychainLookups("with-key")).length;
  const r = await clients.main.callTool("navigate_goal", { tabId: 302, goal: "open the archive" });
  assert.equal(r.isError, true);
  assert.match(r.text, /BAD_PERMS.*"mail\.example\.com" is not in the Jev allowlist/);
  assert.match(r.text, /Allowed: dashboard\.example\.com/);
  assert.equal(jev.requests.length, 0);
  assert.equal((await keychainLookups("with-key")).length, before, "Keychain was read for a refused host");
  assert.equal(ext.requestsFor("dom.click").length, 0);
});

test("navigate_goal on a financial site sends nothing and never reads the key", async () => {
  resetWorld();
  const before = (await keychainLookups("with-key")).length;
  const r = await clients.main.callTool("navigate_goal", { tabId: 304, goal: "open the payouts page" });
  assert.equal(r.isError, true);
  assert.match(r.text, /BAD_PERMS.*"dashboard\.stripe\.com" is a financial site/);
  assert.equal(jev.requests.length, 0);
  assert.equal((await keychainLookups("with-key")).length, before, "Keychain was read for a financial site");
  assert.equal(ext.requestsFor("dom.takeSnapshot").length, 0, "a financial page was snapshotted for Jev");
});

test("navigate_goal with no allowlist file is not enabled, and sends nothing", async () => {
  resetWorld();
  const r = await clients.noConfig.callTool("navigate_goal", { tabId: 301, goal: "open webhooks" });
  assert.equal(r.isError, true);
  assert.match(r.text, /navigate_goal is not enabled: .*absent\.json does not exist/);
  assert.equal(jev.requests.length, 0);
});

test("navigate_goal with a malformed allowlist is a loud error, never allow-all", async () => {
  resetWorld();
  const r = await clients.badConfig.callTool("navigate_goal", { tabId: 301, goal: "open webhooks" });
  assert.equal(r.isError, true);
  assert.match(r.text, /malformed: .*is not a bare host/);
  assert.equal(jev.requests.length, 0);
});

test("navigate_goal without a stored key says how to store it, and sends nothing", async () => {
  resetWorld();
  const r = await clients.noKey.callTool("navigate_goal", { tabId: 301, goal: "open webhooks" });
  assert.equal(r.isError, true);
  assert.match(r.text, /TYPESAFE_API_KEY/);
  assert.match(r.text, /sk TYPESAFE_API_KEY/);
  assert.equal(r.text.includes("Nothing was filled"), false, "fill_secret's hint leaked into navigate_goal");
  assert.equal(jev.requests.length, 0);
});

test("navigate_goal reaches the goal: pick, mutation check, click, done", async () => {
  resetWorld();
  jev.replies.push(
    jevBody({
      done: noul(0.03),
      auth_wall: noul(0.01),
      next: { type: "choice", choice: "9_hooks", probabilities: { "9_hooks": 0.94, "9_home": 0.04, none: 0.02 }, confidence: 0.9 },
    }),
    jevBody({ mutates: noul(0.02) }),
    jevBody({
      done: noul(0.92),
      auth_wall: noul(0.01),
      next: { type: "choice", choice: "none", probabilities: { none: 1 }, confidence: 1 },
    }),
  );
  const r = await clients.main.callTool("navigate_goal", { tabId: 301, goal: "open the webhooks page" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^navigate_goal DONE \(unverified\)/);
  assert.match(r.text, /1 click, .* 3 requests, 396 tokens; waiting on the page \d+ms\) - now at \/acct\/webhooks/);
  // The first observation waits a full quiet window; after the navigating click only ~100ms.
  const waited = [...r.text.matchAll(/waited (\d+)ms/g)].map((m) => Number(m[1]));
  assert.equal(waited.length, 2);
  assert.ok(waited[0] >= 500, `first wait ${waited[0]}ms`);
  assert.ok(waited[1] < 400, `post-click wait ${waited[1]}ms`);
  assert.match(r.text, /pick=9_hooks link "Webhooks" p=0\.94 in nav mutates=0\.02 -> clicked, navigated/);

  const clicks = ext.requestsFor("dom.click");
  assert.deepEqual(clicks.map((c) => c.params.uid), ["9_hooks"]);

  assert.equal(jev.requests.length, 3);
  // The TLS warm-up went out during the first settle, carried nothing, and used the key.
  assert.equal(jev.warmups.length, 1);
  assert.deepEqual(jev.warmups[0], { method: "GET", auth: `Bearer ${FAKE_KEY}`, raw: "" });
  for (const req of jev.requests) {
    assert.equal(req.auth, `Bearer ${FAKE_KEY}`);
    assert.equal(req.body.model, "jev-latest");
    assert.equal(JSON.stringify(req.body).includes(TYPED_VALUE), false, "a typed value was sent to TypeSafe");
    assert.equal(JSON.stringify(req.body).includes(ACCOUNT_EMAIL), false, "an account email was sent to TypeSafe");
  }
  const options = Object.keys(jev.requests[0].body.questions.next.criteria);
  assert.ok(options.includes("none"));
  assert.ok(options.includes("9_edit1"));
  for (const withheld of ["9_search", "9_delete", "9_account"]) assert.equal(options.includes(withheld), false, withheld);
  assert.deepEqual(jev.requests[2].body.state.arrived_via, { control: 'link "Webhooks"', destination: "/acct/webhooks" });
  assert.deepEqual(jev.requests[2].body.state.recent_actions, [
    { control: 'link "Webhooks"', destination: "/acct/webhooks", page_changed: true },
  ]);
  assert.equal(jev.requests[0].body.state.page.path, "/acct/home");
  assert.match(jev.requests[2].body.state.page.text, /Webhooks Add endpoint/);
  assert.equal(r.text.includes(FAKE_KEY), false);
});

test("navigate_goal: a persistent 429 is retried once, then fails loudly without clicking", async () => {
  resetWorld();
  jev.replies.push({ status: 429, body: { detail: "slow down" } }, { status: 429, body: { detail: "slow down" } });
  const r = await clients.main.callTool("navigate_goal", { tabId: 301, goal: "open webhooks" });
  assert.equal(r.isError, true);
  assert.match(r.text, /UPSTREAM.*HTTP 429/);
  assert.match(r.text, /rate limiting or overloaded/);
  assert.equal(jev.requests.length, 2);
  assert.equal(ext.requestsFor("dom.click").length, 0);
});

test("navigate_goal scrubs the key even when TypeSafe echoes it back", async () => {
  resetWorld();
  jev.replies.push({ status: 401, body: { detail: `invalid key ${FAKE_KEY}` } });
  const r = await clients.main.callTool("navigate_goal", { tabId: 301, goal: "open webhooks" });
  assert.equal(r.isError, true);
  assert.match(r.text, /HTTP 401/);
  assert.equal(r.text.includes(FAKE_KEY), false, "the API key leaked into the tool response");
  assert.match(r.text, /<secret>/);
});
