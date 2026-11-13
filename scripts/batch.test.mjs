// batch: several tools in one call. Drives the real MCP server over stdio against a stub
// extension and asserts steps run in order through each tool's own schema and handler, the
// batch-level tabId fills in for steps that name none, the first failure stops the rest (and
// names what was skipped), continueOnError keeps going, and batch refuses unknown tools,
// bad arguments and itself.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PORT = 18768;

const TABS = [
  page({ tabId: 101, index: 0, url: "https://example.com/a", title: "A", active: true }),
  page({ tabId: 202, index: 1, url: "https://example.com/b", title: "B" }),
];
const WORKSPACE_A = TABS;
const WORKSPACE_B = [];

function page({ tabId, index, url, title, active = false }) {
  return { tabId, windowId: 1, index, url, title, active, cookieStoreId: "firefox-default", containerName: null };
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

let dir, daemon, server, ext, mcp;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "zen-batch-"));
  const tokenPath = join(dir, "auth.token");
  daemon = spawn("node", [resolve(root, "daemon/dist/index.js"), "--port", String(PORT), "--token-file", tokenPath, "--nav-db", join(dir, "nav-memory")], { stdio: ["ignore", "ignore", "pipe"] });
  daemon.stderr.resume();
  let token = "";
  for (let i = 0; i < 50 && !token; i++) {
    await sleep(100);
    token = await readFile(tokenPath, "utf8").then((t) => t.trim()).catch(() => "");
  }
  assert.ok(token, "daemon never wrote an auth token");
  ext = new StubExtension(`ws://127.0.0.1:${PORT}`, token);
  await ext.connect();
  server = spawn("node", [resolve(root, "server/dist/index.js"), "--port", String(PORT), "--token-file", tokenPath], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" } });
  server.stderr.resume();
  await sleep(400);
  mcp = new McpClient(server);
  await mcp.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "batch-test", version: "0.0.1" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
});

after(async () => {
  ext?.close();
  server?.kill("SIGTERM");
  daemon?.kill("SIGTERM");
  await sleep(200);
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function callAll(name, args) {
  const r = await mcp.send("tools/call", { name, arguments: args ?? {} });
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  return { isError: r.result?.isError === true, texts: (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text) };
}

test("batch is listed", async () => {
  const r = await mcp.send("tools/list", {});
  assert.ok(r.result.tools.some((t) => t.name === "batch"));
});

test("steps run in order; batch tabId fills in for steps that name none", async () => {
  ext.requests = [];
  const { isError, texts } = await callAll("batch", {
    tabId: 202,
    steps: [
      { tool: "navigate_page", args: { url: "https://example.com/one" } },
      { tool: "navigate_page", args: { url: "https://example.com/two", tabId: 101 } },
      { tool: "list_pages" },
    ],
  });
  assert.equal(isError, false, texts.join("\n"));
  assert.match(texts[0], /^\[1\/3\] navigate_page: tabId=202 -> https:\/\/example\.com\/one/);
  assert.match(texts[1], /^\[2\/3\] navigate_page: tabId=101 -> https:\/\/example\.com\/two/);
  assert.match(texts[2], /^\[3\/3\] list_pages: /);
  const navs = ext.requestsFor("pages.navigate").map((r) => [r.params.tabId, r.params.url]);
  assert.deepEqual(navs, [[202, "https://example.com/one"], [101, "https://example.com/two"]]);
});

test("the first failure stops the batch and names the skipped steps", async () => {
  ext.requests = [];
  const { isError, texts } = await callAll("batch", {
    steps: [
      { tool: "navigate_page", args: { tabId: 999, url: "https://example.com/x" } },
      { tool: "navigate_page", args: { tabId: 101, url: "https://example.com/never" } },
      { tool: "list_pages" },
    ],
  });
  assert.equal(isError, true);
  assert.match(texts[0], /^\[1\/3\] navigate_page FAILED: /);
  assert.match(texts.at(-1), /stopped: 2 step\(s\) not run \(navigate_page, list_pages\)/);
  assert.equal(ext.requestsFor("pages.navigate").length, 0, "nothing after the failure may run");
});

test("continueOnError runs the rest and succeeds when something worked", async () => {
  ext.requests = [];
  const { isError, texts } = await callAll("batch", {
    continueOnError: true,
    steps: [
      { tool: "no_such_tool" },
      { tool: "navigate_page", args: { tabId: 101, url: "https://example.com/after" } },
    ],
  });
  assert.equal(isError, false);
  assert.match(texts[0], /FAILED: .*unknown tool "no_such_tool"/);
  assert.match(texts[1], /^\[2\/2\] navigate_page: tabId=101/);
});

test("bad arguments fail validation before any RPC; batch cannot nest", async () => {
  ext.requests = [];
  const bad = await callAll("batch", { steps: [{ tool: "navigate_page", args: { tabId: 101 } }] });
  assert.equal(bad.isError, true);
  assert.match(bad.texts[0], /invalid arguments for navigate_page: url:/);
  assert.equal(ext.requestsFor("pages.navigate").length, 0);
  const nested = await callAll("batch", { steps: [{ tool: "batch", args: { steps: [] } }] });
  assert.equal(nested.isError, true);
  assert.match(nested.texts[0], /batch cannot contain batch/);
});
