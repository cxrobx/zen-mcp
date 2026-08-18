// Coverage for fill_secret: a Keychain secret reaches a form field without its value ever
// appearing in the MCP transcript.
//
// The gap this guards: fill's `value` parameter is the only door into a form field, and
// everything in a tool call is transcript — so an agent either put a credential in the
// conversation or gave up on the browser. fill_secret resolves the value inside the server
// process and hands it straight to the fill RPC. Three properties have to hold, each tested
// here: the value never appears in any tool response (success OR error, even when the
// extension echoes it back), an unbound host is an error and no fill is attempted, and a
// malformed config is a loud failure that never reads as an empty one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PORT = 18771;

const SECRET_VALUE = "hunter2-fake-value-9000";

const SECRETS_FILE = {
  _readme: "test fixture",
  secrets: {
    MILLIONVERIFIER_PASSWORD: ["app.millionverifier.com"],
    MISSING_SECRET: ["app.millionverifier.com"],
  },
};

// Mimics `security find-generic-password -s cx-secret -a NAME -w`: prints the value for the
// one name it knows, exits 44 (errSecItemNotFound) otherwise.
const FAKE_SECURITY = `#!/bin/sh
name=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-a" ]; then name="$arg"; fi
  prev="$arg"
done
if [ "$name" = "MILLIONVERIFIER_PASSWORD" ]; then
  echo "${SECRET_VALUE}"
  exit 0
fi
exit 44
`;

const TABS = () => [
  {
    tabId: 201,
    windowId: 1,
    index: 0,
    url: "https://app.millionverifier.com/login",
    title: "Login",
    active: true,
    cookieStoreId: "firefox-default",
    containerName: null,
  },
  {
    tabId: 202,
    windowId: 1,
    index: 1,
    url: "https://evil.example/login",
    title: "Lookalike",
    active: false,
    cookieStoreId: "firefox-default",
    containerName: null,
  },
];

class StubExtension {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.tabs = TABS();
    this.requests = [];
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
        return { result: { containers: [] } };
      case "pages.list":
        return { result: { pages: this.tabs } };
      case "dom.fillByLocator": {
        // "#echo" simulates a hostile/future handler that reflects the value into its error
        // text — the server-side scrub is what must keep it out of the transcript.
        if (msg.params?.locator?.selector === "#echo") {
          return { error: { code: -32000, message: `element rejected value "${msg.params.value}"` } };
        }
        const tab = this.tabs.find((t) => t.tabId === msg.params.tabId);
        return {
          result: {
            tabId: msg.params.tabId,
            feedback: { url: tab?.url ?? "", title: tab?.title ?? "", navigated: false },
          },
        };
      }
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

  async callTool(name, args) {
    const r = await this.send("tools/call", { name, arguments: args ?? {} });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    const text = r.result?.content?.find?.((c) => c.type === "text")?.text ?? "";
    return { isError: r.result?.isError === true, text };
  }
}

let dir;
let daemon;
let ext;
let servers = [];
let mcp;
let mcpBadConfig;
let mcpNoConfig;

async function startServer(tokenPath, env) {
  const child = spawn(
    "node",
    [resolve(root, "server/dist/index.js"), "--port", String(PORT), "--token-file", tokenPath],
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
    clientInfo: { name: "fill-secret-test", version: "0.0.1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  servers.push(child);
  return client;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "zen-fill-secret-"));
  const secretsFile = join(dir, "secrets.json");
  await writeFile(secretsFile, JSON.stringify(SECRETS_FILE, null, 2), "utf8");
  const badSecretsFile = join(dir, "secrets-broken.json");
  await writeFile(badSecretsFile, '{"secrets": {', "utf8");
  const fakeSecurity = join(dir, "fake-security.sh");
  await writeFile(fakeSecurity, FAKE_SECURITY, "utf8");
  await chmod(fakeSecurity, 0o755);

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
  for (let attempt = 1; ; attempt++) {
    try {
      await ext.connect();
      break;
    } catch (err) {
      if (attempt >= 10) throw err;
      await sleep(200);
    }
  }

  const secretEnv = { ZEN_MCP_SECRET_BIN: fakeSecurity };
  mcp = await startServer(tokenPath, { ...secretEnv, ZEN_MCP_SECRETS: secretsFile });
  mcpBadConfig = await startServer(tokenPath, { ...secretEnv, ZEN_MCP_SECRETS: badSecretsFile });
  mcpNoConfig = await startServer(tokenPath, { ...secretEnv, ZEN_MCP_SECRETS: join(dir, "absent.json") });
});

after(async () => {
  ext?.close();
  for (const child of servers) child.kill("SIGTERM");
  daemon?.kill("SIGTERM");
  await sleep(200);
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("bound host: value reaches the extension but never the transcript", async () => {
  const r = await mcp.callTool("fill_secret", {
    tabId: 201,
    selector: "css:#password",
    secret: "MILLIONVERIFIER_PASSWORD",
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /filled css:#password with secret MILLIONVERIFIER_PASSWORD \(23 chars\)/);
  assert.equal(r.text.includes(SECRET_VALUE), false, "secret value leaked into tool response");
  const fills = ext.requestsFor("dom.fillByLocator");
  assert.equal(fills.length, 1);
  assert.equal(fills[0].params.value, SECRET_VALUE, "value must reach the fill RPC intact");
});

test("unbound host is an error and no fill is attempted", async () => {
  const beforeCount = ext.requestsFor("dom.fillByLocator").length;
  const r = await mcp.callTool("fill_secret", {
    tabId: 202,
    selector: "css:#password",
    secret: "MILLIONVERIFIER_PASSWORD",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /not bound to host "evil\.example"/);
  assert.match(r.text, /app\.millionverifier\.com/);
  assert.equal(ext.requestsFor("dom.fillByLocator").length, beforeCount, "fill must not be attempted");
});

test("unknown secret name names the config path and attempts nothing", async () => {
  const beforeCount = ext.requestsFor("dom.fillByLocator").length;
  const r = await mcp.callTool("fill_secret", {
    tabId: 201,
    selector: "css:#password",
    secret: "NOT_A_SECRET",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /"NOT_A_SECRET" is not configured/);
  assert.match(r.text, /secrets\.json/);
  assert.equal(ext.requestsFor("dom.fillByLocator").length, beforeCount);
});

test("bound but absent from the Keychain points at sk NAME", async () => {
  const beforeCount = ext.requestsFor("dom.fillByLocator").length;
  const r = await mcp.callTool("fill_secret", {
    tabId: 201,
    selector: "css:#password",
    secret: "MISSING_SECRET",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /not found in the login Keychain/);
  assert.match(r.text, /sk NAME/);
  assert.equal(ext.requestsFor("dom.fillByLocator").length, beforeCount);
});

test("a fill error that echoes the value is scrubbed before it reaches the transcript", async () => {
  const r = await mcp.callTool("fill_secret", {
    tabId: 201,
    selector: "css:#echo",
    secret: "MILLIONVERIFIER_PASSWORD",
  });
  assert.equal(r.isError, true);
  assert.equal(r.text.includes(SECRET_VALUE), false, "extension-echoed value leaked into transcript");
  assert.match(r.text, /<secret>/);
});

test("malformed config is a loud error, never an empty one", async () => {
  const beforeCount = ext.requestsFor("dom.fillByLocator").length;
  const r = await mcpBadConfig.callTool("fill_secret", {
    tabId: 201,
    selector: "css:#password",
    secret: "MILLIONVERIFIER_PASSWORD",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /secrets config failed to load/);
  assert.match(r.text, /invalid JSON/);
  assert.equal(ext.requestsFor("dom.fillByLocator").length, beforeCount);
});

test("absent config reads as zero secrets configured", async () => {
  const r = await mcpNoConfig.callTool("fill_secret", {
    tabId: 201,
    selector: "css:#password",
    secret: "MILLIONVERIFIER_PASSWORD",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /0 secrets configured/);
});
