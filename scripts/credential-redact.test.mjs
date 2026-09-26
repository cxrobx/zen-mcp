// Coverage for credential masking: no tool hands a credential-shaped string back to the model.
//
// The leak this guards: a page can show a key truncated while the element's accessible name,
// its text or an input's value holds the whole thing. Stripe's API-keys row does, and on
// 2026-09-25 its full secret key came back through take_snapshot and through the `active=`
// line printed after a click. The server masks every tool's text on the way out
// (redactResponse in server/src/tools.ts), so this drives each page-reading tool through the
// real daemon + server against a stub extension whose page carries keys in an aria-label, in
// text and in an input value, and asserts that nothing but prefix + last 4 comes back.
//
// Fixture keys are assembled at runtime so no scanner mistakes this public file for a leak.
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
const PORT = 18779;

const { maskCredentials } = await import(resolve(root, "shared/dist/credential-redact.js"));

const BODY62 = "51Pq7ZabCDefGHijKLmnOPqrSTuvWXyz0123456789AbCdEf9x4Q";
const K = {
  stripeSecret: ["sk", "test", BODY62].join("_"),
  stripeRestricted: ["rk", "live", "Zz81AbCdEfGhIjKlMnOp7Q2w"].join("_"),
  stripePublic: ["pk", "test", "51Pq7ZpubLiCkEyPUBlickEy0123456789pUbLiC"].join("_"),
  webhook: "whsec" + "_" + "Qm3kF8zLr2Xy7VbN0pT4sW6uH1jD9cA5",
  github: "gh" + "p_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z5A",
  githubOauth: "gh" + "o_" + "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe9Dc8",
  githubPat: "github" + "_pat_" + "11ABCDEFG0aB3dE5fG7hJ9_kL1mN3pQ5rS7tU9vW1xY3z5A7bC9",
  slack: "xo" + "xb-" + "2048-9812734650-aB3dE5fG7hJ9kL",
  aws: "AK" + "IA" + "Q7RS2TUV4WXY6Z3B",
  generic: "f3a9c1e7b5d2" + "0864ace13579bdf2468ace1357",
};
const PEM = [
  "-----BEGIN " + "RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAq7ZabCDefGHijKLmnOPqrSTuvWXyz0123456789AbCdEfGhIj",
  "kLmNoPqRsTuVwXyZ0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567abcd",
  "-----END " + "RSA PRIVATE KEY-----",
].join("\n");

// Every whole secret that must never appear in any output, and the body of each one (the part
// after its prefix) - a partial leak of the body counts too.
const SECRETS = [
  K.stripeSecret, K.stripeRestricted, K.webhook, K.github, K.githubOauth, K.githubPat,
  K.slack, K.aws, K.generic,
];
const PEM_BODY_LINE = PEM.split("\n")[1];

const TAB = {
  tabId: 301,
  windowId: 1,
  index: 0,
  url: "https://dashboard.example.com/test/apikeys",
  title: "API keys",
  active: true,
  cookieStoreId: "firefox-default",
  containerName: null,
};

const PAGE_TEXT = [
  "API keys",
  `Publishable key ${K.stripePublic}`,
  `Secret key ${K.stripeSecret}`,
  `Restricted key ${K.stripeRestricted}`,
  `Signing secret ${K.webhook}`,
  `GitHub ${K.github} and ${K.githubOauth}`,
  `Fine-grained ${K.githubPat}`,
  `Slack bot ${K.slack}`,
  `AWS ${K.aws}`,
  `Service token: ${K.generic}`,
  PEM,
].join("\n");

let uidSeq = 0;
function node(tag, fields = {}, children = []) {
  return { uid: `1_${uidSeq++}`, tag, ...fields, children };
}

function snapshotTree() {
  uidSeq = 0;
  return node("body", {}, [
    node("h1", { role: "heading", name: "API keys", text: "API keys" }),
    // The Stripe case: the screen shows it cut short, the accessible name holds all of it.
    node("button", { role: "button", name: `Reveal ${K.stripeSecret}`, text: "sk_test_51Pq…9x4Q" }),
    node("span", { text: `Signing secret ${K.webhook}` }),
    node("input", { role: "textbox", name: "GitHub token", value: K.github }),
    node("input", { role: "textbox", name: "Slack token", value: K.slack }),
    node("td", { text: `AWS ${K.aws}` }),
    node("textarea", { role: "textbox", name: "Private key", value: PEM }),
    node("div", { text: `Service token: ${K.generic}` }),
    node("span", { text: `Publishable key ${K.stripePublic}` }),
  ]);
}

class StubExtension {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.screenshotMasked = undefined;
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
        if (msg.type === "ping") return this.send({ type: "pong", ts: msg.ts });
        if (msg.type !== "request") return;
        this.send({ type: "response", id: msg.id, ...this.handle(msg) });
      });
    });
  }

  handle(msg) {
    const feedback = {
      url: TAB.url,
      title: TAB.title,
      // What Stripe's "Copy and close" did: focus lands on an element named by the full key.
      activeElement: { tag: "input", name: K.stripeSecret },
      navigated: false,
    };
    switch (msg.method) {
      case "containers.list":
        return { result: { containers: [] } };
      case "pages.list":
        return { result: { pages: [TAB] } };
      case "pages.get":
        return { result: { page: TAB } };
      case "dom.takeSnapshot":
        return {
          result: {
            tabId: TAB.tabId,
            snapshotId: 1,
            tree: snapshotTree(),
            uidMap: [],
            truncated: false,
          },
        };
      case "dom.getPageText":
        return { result: { text: PAGE_TEXT } };
      case "dom.readPage":
        return {
          result: {
            ok: true,
            title: "API keys",
            byline: `rotated by ${K.stripeRestricted}`,
            excerpt: `Secret key ${K.stripeSecret}`,
            length: PAGE_TEXT.length,
            markdown: `# API keys\n\n${PAGE_TEXT}`,
          },
        };
      case "dom.clickByLocator":
      case "dom.fillByLocator":
        return { result: { tabId: TAB.tabId, matchedTag: "button", feedback } };
      case "pages.navigate":
        return { result: { tabId: TAB.tabId } };
      case "dom.evaluate":
        return { result: { result: { key: K.stripeSecret, webhook: K.webhook } } };
      case "pages.screenshot":
        return {
          result: {
            tabId: TAB.tabId,
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            ...(this.screenshotMasked === undefined ? {} : { masked: this.screenshotMasked }),
          },
        };
      default:
        // An error message is page-derived too: echo a key back to prove fail() is masked.
        return { error: { code: -32000, message: `stub has no handler for ${msg.method} (${K.stripeSecret})` } };
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
    const text = (r.result?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return { isError: r.result?.isError === true, text };
  }
}

function assertNoSecrets(label, text) {
  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false, `${label}: full secret leaked: ${secret.slice(0, 10)}…`);
    const body = secret.slice(-20, -4);
    assert.equal(text.includes(body), false, `${label}: secret body leaked from ${secret.slice(0, 10)}…`);
  }
  assert.equal(text.includes(PEM_BODY_LINE), false, `${label}: PEM body leaked`);
}

let dir;
let daemon;
let ext;
let server;
let mcp;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "zen-credential-redact-"));
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

  server = spawn("node", [resolve(root, "server/dist/index.js"), "--port", String(PORT), "--token-file", tokenPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" },
  });
  server.stderr.resume();
  await sleep(400);
  mcp = new McpClient(server);
  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "credential-redact-test", version: "0.0.1" },
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

test("masker: each pattern keeps its prefix and last 4, publishable keys stay", () => {
  const out = maskCredentials(PAGE_TEXT);
  assertNoSecrets("maskCredentials", out);
  assert.match(out, /sk_test_…9x4Q/);
  assert.match(out, /rk_live_…7Q2w/);
  assert.match(out, /whsec_…9cA5/);
  assert.match(out, /ghp_…3z5A/);
  assert.match(out, /gho_…9Dc8/);
  assert.match(out, /github_pat_…7bC9/);
  assert.match(out, /xoxb-…J9kL/);
  assert.match(out, /AKIA…6Z3B/);
  assert.match(out, /Service token: …1357/);
  assert.match(out, /-----BEGIN RSA PRIVATE KEY-----…\[redacted\]…-----END RSA PRIVATE KEY-----/);
  assert.ok(out.includes(K.stripePublic), "publishable key is public and must be left alone");
  assert.equal(maskCredentials(out), out, "masking must be idempotent");
});

test("masker: ordinary text is untouched", () => {
  for (const s of [
    "Rotate key",
    "the key to supercalifragilisticexpialidociousnessness",
    "commit 0123456789abcdef0123456789abcdef with no keyword near it",
    "docs mention -----BEGIN PRIVATE KEY----- as a header",
    "task_test_runner and desk_live_view are not keys",
  ]) {
    assert.equal(maskCredentials(s), s, s);
  }
});

test("masker: a PEM block cut off before its END line is still masked", () => {
  const cut = PEM.split("\n").slice(0, 2).join("\n") + "\nnext line of prose";
  const out = maskCredentials(cut);
  assert.equal(out.includes(PEM_BODY_LINE), false);
  assert.match(out, /next line of prose/);
});

test("masker: read_page's Markdown-escaped underscores don't hide a key", () => {
  const escaped = `Secret key ${K.stripeSecret.replaceAll("_", "\\_")} and ${K.github.replace("_", "\\_")}`;
  const out = maskCredentials(escaped);
  assertNoSecrets("escaped", out.replaceAll("\\_", "_"));
  assert.match(out, /sk\\_test\\_…9x4Q/);
});

test("masker: a key split across elements is masked on its second line", () => {
  const [prefix, body] = [K.stripeRestricted.slice(0, 8), K.stripeRestricted.slice(8)];
  const snapshotText = `p#1_2 text="Restricted key"\n    span#1_3 text="${prefix}"\n    span#1_4 text="${body}"\n    button#1_5 text="Roll key"`;
  const out = maskCredentials(snapshotText);
  assert.equal(out.includes(body), false, "split body leaked");
  assert.match(out, /text="…7Q2w"/);
  assert.match(out, /Roll key/);
  assert.equal(maskCredentials(out), out, "masking must be idempotent");
});

test("take_snapshot: accessible name, text and input value are masked", async () => {
  const r = await mcp.callTool("take_snapshot", { tabId: TAB.tabId });
  assert.equal(r.isError, false, r.text);
  assertNoSecrets("take_snapshot", r.text);
  assert.match(r.text, /sk_test_…9x4Q/);
  assert.match(r.text, /ghp_…3z5A/);
  assert.ok(r.text.includes(K.stripePublic), "publishable key survives");
});

test("find_by_text: matches come back masked", async () => {
  // Searching by the prefix is exactly how an agent would go looking for the key.
  const r = await mcp.callTool("find_by_text", { tabId: TAB.tabId, text: "sk_test" });
  assert.equal(r.isError, false, r.text);
  assertNoSecrets("find_by_text", r.text);
  assert.match(r.text, /sk_test_…9x4Q/);
});

test("interactive_elements: control names and values are masked", async () => {
  const r = await mcp.callTool("interactive_elements", { tabId: TAB.tabId });
  assert.equal(r.isError, false, r.text);
  assertNoSecrets("interactive_elements", r.text);
});

test("get_page_text: page text is masked", async () => {
  const r = await mcp.callTool("get_page_text", { tabId: TAB.tabId });
  assert.equal(r.isError, false, r.text);
  assertNoSecrets("get_page_text", r.text);
  assert.match(r.text, /AKIA…6Z3B/);
});

test("get_page_text: a key straddling the response budget is still masked", async () => {
  const r = await mcp.callTool("get_page_text", { tabId: TAB.tabId, maxBytes: 60 });
  assert.equal(r.isError, false, r.text);
  assertNoSecrets("get_page_text (budgeted)", r.text);
});

test("read_page: markdown, byline and excerpt are masked", async () => {
  const r = await mcp.callTool("read_page", { tabId: TAB.tabId });
  assert.equal(r.isError, false, r.text);
  assertNoSecrets("read_page", r.text);
});

test("click and fill: the active= name is masked", async () => {
  for (const [tool, args] of [
    ["click", { tabId: TAB.tabId, selector: "text:Copy and close" }],
    ["fill", { tabId: TAB.tabId, selector: "css:#name", value: "Rotation note" }],
  ]) {
    const r = await mcp.callTool(tool, args);
    assert.equal(r.isError, false, `${tool}: ${r.text}`);
    assert.match(r.text, /active=input name="sk_test_…/, `${tool} should still print the active element`);
    assertNoSecrets(tool, r.text);
  }
});

test("evaluate_script: a returned key is masked", async () => {
  const r = await mcp.callTool("evaluate_script", { tabId: TAB.tabId, code: "return 1" });
  assert.equal(r.isError, false, r.text);
  assertNoSecrets("evaluate_script", r.text);
});

test("errors are masked too", async () => {
  const r = await mcp.callTool("hover", { tabId: TAB.tabId, selector: "css:#x" });
  assert.equal(r.isError, true);
  assert.match(r.text, /stub has no handler/);
  assertNoSecrets("error path", r.text);
});

test("screenshot_page: says what the page mask did, and warns on an extension without it", async () => {
  ext.screenshotMasked = undefined;
  let r = await mcp.callTool("screenshot_page", { tabId: TAB.tabId });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /WARNING: this extension predates the screenshot credential mask/);

  ext.screenshotMasked = 3;
  r = await mcp.callTool("screenshot_page", { tabId: TAB.tabId });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /3 credential-shaped strings masked in the page for the capture/);

  ext.screenshotMasked = 0;
  r = await mcp.callTool("screenshot_page", { tabId: TAB.tabId });
  assert.doesNotMatch(r.text, /masked|WARNING/);
});
