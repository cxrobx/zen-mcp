// Regression coverage for the Zen-workspace tab-retargeting bug.
//
// Zen Workspaces scope browser.tabs.query({}) to the ACTIVE workspace, so tabs in other
// workspaces are absent from the WebExtension API entirely. Because pageIdx is a POSITION
// in that visible list, switching workspaces mid-session silently re-points every index at
// a different tab and nothing errors. These tests drive the real MCP server over stdio
// against a stub extension whose visible tab set can be swapped, and assert that a tabId
// that has left the visible set is reached by IDENTITY (the tab still exists, in another
// workspace, and every id-addressed RPC resolves it there), that a tabId that exists nowhere
// FAILS instead of landing on an unrelated tab, and that pageIdx stays guarded.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { NavContext } from "../server/dist/nav-memory.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PORT = 18767;

// Workspace A: what list_pages sees before the switch.
const WORKSPACE_A = [
  page({ tabId: 101, index: 0, url: "https://example.com/a", title: "A", active: true }),
  page({ tabId: 202, index: 1, url: "https://example.com/target", title: "Target" }),
];
// Workspace B: a different tab now occupies index 1. tabId 202 is gone from the QUERY, but
// the extension still resolves it by id (pages.get / includeHidden) - that is the real
// Zen behavior: gBrowser.tabs is rebuilt from the active space's strip, the id map is not.
const WORKSPACE_B = [
  page({ tabId: 301, index: 0, url: "https://search.google.com/search-console", title: "GSC", active: true }),
  page({ tabId: 302, index: 1, url: "https://search.google.com/search-console/clients", title: "GSC client" }),
];

function page({ tabId, index, url, title, active = false }) {
  return {
    tabId,
    windowId: 1,
    index,
    url,
    title,
    active,
    cookieStoreId: "firefox-default",
    containerName: null,
  };
}

class StubExtension {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.tabs = WORKSPACE_A;
    this.requests = [];
    // Simulates an extension too old to answer pages.get (0.0.17 and earlier).
    this.supportsGet = true;
  }

  /** Every tab in every workspace - what the id map holds. */
  get everyTab() {
    return [...WORKSPACE_A, ...WORKSPACE_B];
  }

  flagged(tab) {
    const visible = this.tabs.some((t) => t.tabId === tab.tabId);
    return { ...tab, inActiveWorkspace: visible };
  }

  setVisibleTabs(tabs) {
    this.tabs = tabs;
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
      case "pages.list": {
        if (!msg.params?.includeHidden) return { result: { pages: this.tabs } };
        const hidden = this.everyTab
          .filter((t) => !this.tabs.some((v) => v.tabId === t.tabId))
          .map((t) => this.flagged(t));
        return { result: { pages: [...this.tabs, ...hidden] } };
      }
      case "pages.get": {
        if (!this.supportsGet) return { error: { code: -32601, message: "unknown method: pages.get" } };
        const found = this.everyTab.find((t) => t.tabId === msg.params?.tabId);
        return { result: { page: found ? this.flagged(found) : null } };
      }
      case "pages.navigate":
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
            containerCount: 0,
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

  /** Returns { isError, text } so tests can assert on failures as well as successes. */
  async callTool(name, args) {
    const r = await this.send("tools/call", { name, arguments: args ?? {} });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    const text = r.result?.content?.find?.((c) => c.type === "text")?.text ?? "";
    return { isError: r.result?.isError === true, text };
  }
}

let dir;
let daemon;
let server;
let ext;
let mcp;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "zen-tab-target-"));
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

  ext = new StubExtension(`ws://127.0.0.1:${PORT}`, token);
  await ext.connect();

  server = spawn(
    "node",
    [resolve(root, "server/dist/index.js"), "--port", String(PORT), "--token-file", tokenPath],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" } },
  );
  server.stderr.resume();
  await sleep(400);
  mcp = new McpClient(server);
  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tab-target-test", version: "0.0.1" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
});

after(async () => {
  ext?.close();
  server?.kill("SIGTERM");
  daemon?.kill("SIGTERM");
  await sleep(200);
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("list_pages exposes durable tabIds and a tab-set fingerprint", async () => {
  ext.setVisibleTabs(WORKSPACE_A);
  const { isError, text } = await mcp.callTool("list_pages");
  assert.equal(isError, false);
  assert.match(text, /tabId=202/);
  assert.match(text, /tabSet=[0-9a-f]{8}/);
  assert.match(text, /active Zen workspace/);
});

test("tabId addresses the intended tab while it is visible", async () => {
  ext.setVisibleTabs(WORKSPACE_A);
  const { isError, text } = await mcp.callTool("navigate_page", {
    tabId: 202,
    url: "https://example.com/target-2",
  });
  assert.equal(isError, false);
  assert.match(text, /tabId=202/);
  const last = ext.requestsFor("pages.navigate").at(-1);
  assert.equal(last.params.tabId, 202);
});

test("a tabId that left the visible workspace is still reached by identity, in place", async () => {
  // After a workspace switch the captured tab is absent from the query but not from the
  // browser. A tabId is an identity, so the tool resolves it via pages.get and acts on THAT
  // tab - never on whatever now sits at its old position.
  ext.supportsGet = true;
  ext.setVisibleTabs(WORKSPACE_B);

  const { isError, text } = await mcp.callTool("navigate_page", {
    tabId: 202,
    url: "https://example.com/target-3",
  });

  assert.equal(isError, false, text);
  assert.match(text, /tabId=202/);
  assert.equal(ext.requestsFor("pages.navigate").at(-1).params.tabId, 202);
  assert.equal(
    ext.requestsFor("pages.navigate").filter((r) => r.params.tabId === 302).length,
    0,
    "the tab now occupying index 1 must never be touched",
  );
});

test("a tabId that exists in no workspace errors instead of acting", async () => {
  ext.setVisibleTabs(WORKSPACE_B);
  const before = ext.requestsFor("pages.navigate").length;

  const { isError, text } = await mcp.callTool("navigate_page", {
    tabId: 999,
    url: "https://example.com/should-not-happen",
  });

  assert.equal(isError, true, "expected an error, not a silent retarget");
  assert.match(text, /tabId 999 not found in any Zen workspace/);
  assert.match(text, /Nothing was done/);
  assert.equal(
    ext.requestsFor("pages.navigate").length,
    before,
    "no navigation may reach the browser when the target tab is gone",
  );
});

test("an extension without pages.get keeps the old loud failure", async () => {
  ext.supportsGet = false;
  ext.setVisibleTabs(WORKSPACE_B);
  const before = ext.requestsFor("pages.navigate").length;
  try {
    const { isError, text } = await mcp.callTool("navigate_page", {
      tabId: 202,
      url: "https://example.com/should-not-happen",
    });
    assert.equal(isError, true);
    assert.match(text, /tabId 202 not found in the active workspace/);
    assert.match(text, /too old/);
    assert.equal(ext.requestsFor("pages.navigate").length, before);
  } finally {
    ext.supportsGet = true;
  }
});

test("list_pages hides other workspaces by default and lists them positionless on request", async () => {
  ext.setVisibleTabs(WORKSPACE_A);
  const plain = await mcp.callTool("list_pages");
  assert.equal(plain.isError, false);
  assert.doesNotMatch(plain.text, /tabId=301/);

  const withHidden = await mcp.callTool("list_pages", { includeHidden: true });
  assert.equal(withHidden.isError, false, withHidden.text);
  assert.match(withHidden.text, /2 tabs visible in the active Zen workspace/);
  assert.match(withHidden.text, /2 more tabs in other Zen workspaces/);
  assert.match(withHidden.text, /\[-\] tabId=301 /);
  assert.doesNotMatch(withHidden.text, /\[\d+\] tabId=301/, "hidden tabs get no position");
  const fp = (t) => /tabSet=([0-9a-f]{8})/.exec(t)[1];
  assert.equal(fp(withHidden.text), fp(plain.text), "the fingerprint describes the visible set only");
});

test("select_page finds a tab in another workspace by url and switches to it", async () => {
  ext.setVisibleTabs(WORKSPACE_A);
  const { isError, text } = await mcp.callTool("select_page", { url: "search-console/clients" });
  assert.equal(isError, false, text);
  assert.match(text, /selected tabId=302 /);
  assert.match(text, /Zen switched to it/);
  assert.equal(ext.requestsFor("pages.select").at(-1).params.tabId, 302);
});

test("every pageIdx-addressed tool inherits the same tabId guard", async () => {
  ext.setVisibleTabs(WORKSPACE_B);
  const mark = ext.requests.length;
  const cases = [
    ["take_snapshot", {}],
    ["get_page_text", {}],
    ["click", { selector: "css:#go" }],
    ["fill", { selector: "css:#email", value: "x" }],
    ["evaluate_script", { code: "return 1;" }],
    ["screenshot_page", {}],
    ["close_page", {}],
    ["select_page", {}],
    ["get_storage", { kind: "local" }],
    ["wait_for", { condition: "selector_visible", selector: "css:#go", timeout: 1000 }],
  ];
  for (const [name, args] of cases) {
    const { isError, text } = await mcp.callTool(name, { tabId: 999, ...args });
    assert.equal(isError, true, `${name} should reject a tabId that exists in no workspace`);
    assert.match(text, /tabId 999 not found in any Zen workspace/, `${name}: ${text}`);
  }
  // Nothing above should have reached the browser for the missing tab - only the lookup.
  assert.equal(
    ext.requests.slice(mark).filter((r) => r.params?.tabId === 999 && r.method !== "pages.get").length,
    0,
    "no RPC may be issued against a tab that exists nowhere",
  );
});

test("pageIdx still silently re-points after a workspace switch, and expectTabSet stops it", async () => {
  // This is the hazard tabId exists to avoid: index 1 now names an unrelated tab, and the
  // positional call cannot tell. Backward compatibility means it still works, so the guard
  // has to be the caller's opt-in.
  ext.setVisibleTabs(WORKSPACE_A);
  const listed = await mcp.callTool("list_pages");
  const staleFingerprint = /tabSet=([0-9a-f]{8})/.exec(listed.text)[1];

  ext.setVisibleTabs(WORKSPACE_B);
  const loose = await mcp.callTool("navigate_page", { pageIdx: 1, url: "https://example.com/x" });
  assert.equal(loose.isError, false);
  assert.equal(
    ext.requestsFor("pages.navigate").at(-1).params.tabId,
    302,
    "pageIdx is positional: it lands on whatever tab now sits at that index",
  );

  const before = ext.requestsFor("pages.navigate").length;
  const guarded = await mcp.callTool("navigate_page", {
    pageIdx: 1,
    expectTabSet: staleFingerprint,
    url: "https://example.com/x",
  });
  assert.equal(guarded.isError, true);
  assert.match(guarded.text, /tab set changed/);
  assert.match(guarded.text, /Nothing was done/);
  assert.equal(ext.requestsFor("pages.navigate").length, before, "guarded call must not act");
});

test("pageIdx and tabId are mutually exclusive and one is required", async () => {
  ext.setVisibleTabs(WORKSPACE_A);
  const both = await mcp.callTool("navigate_page", { pageIdx: 0, tabId: 101, url: "https://x.test/" });
  assert.equal(both.isError, true);
  assert.match(both.text, /exactly one of pageIdx or tabId/);

  const neither = await mcp.callTool("navigate_page", { url: "https://x.test/" });
  assert.equal(neither.isError, true);
  assert.match(neither.text, /provide one of pageIdx or tabId/);

  const legacy = await mcp.callTool("navigate_page", { pageIdx: 0, url: "https://x.test/" });
  assert.equal(legacy.isError, false, "existing pageIdx callers must keep working");
});

test("get_firefox_info reports the visible count, a fingerprint, and no invented workspace id", async () => {
  ext.setVisibleTabs(WORKSPACE_B);
  const { isError, text } = await mcp.callTool("get_firefox_info");
  assert.equal(isError, false);
  assert.match(text, /tabs\.visible: 2 \(active Zen workspace only\)/);
  assert.match(text, /tabs\.fingerprint: [0-9a-f]{8}/);
  assert.match(text, /tabs\.workspaceId: \(not exposed by Zen to WebExtensions\)/);
});

test("nav-memory attributes notes by tabId, not by list position", async () => {
  const calls = [];
  const daemonStub = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "navMemory.query") {
        return { host: "example.com", registrableDomain: "example.com", total: 0, notes: [] };
      }
      return { accepted: params.events.length, dropped: 0 };
    },
  };
  const nav = new NavContext(daemonStub, true);
  nav.observePages([
    page({ tabId: 101, index: 0, url: "https://wrong.example/", title: "wrong", active: true }),
    page({ tabId: 202, index: 1, url: "https://right.example/form", title: "right" }),
  ]);
  const wrapped = nav.wrap("fill", async () => ({ content: [{ type: "text", text: "filled" }] }));
  await wrapped({ tabId: 202, selector: "css:input[name=email]", value: "v" });
  await new Promise((r) => setImmediate(r));

  const events = calls
    .filter((c) => c.method === "navMemory.recordEvents")
    .flatMap((c) => c.params.events);
  assert.equal(events.length, 1);
  assert.equal(events[0].host, "right.example");
});
