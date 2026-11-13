#!/usr/bin/env node
// Live T656 regression: prefilled and already-revealed passwords must stay private.
// Uses only fake credentials, disables nav memory, and closes its fixture tab.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const container = arg("container", "CXVentures");
const PORT = Number.parseInt(arg("port", "8795"), 10);

const FIXTURE = `<!doctype html><title>Password regression</title><body>
<h1>Fixture</h1><label for="password">Password</label>
<input id="password" type="password" value="fixture-password-8294">
<label for="revealed">Revealed password</label>
<input id="revealed" type="password" value="fixture-revealed-7382">
<script>document.querySelector('#revealed').type='text';</script></body>`;

class McpClient {
  constructor(child) {
    this.child = child; this.nextId = 1; this.buf = ""; this.pending = new Map();
    child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      const lines = this.buf.split("\n"); this.buf = lines.pop() ?? "";
      for (const line of lines) {
        let p; try { p = JSON.parse(line); } catch { continue; }
        const done = this.pending.get(p.id);
        if (done) { this.pending.delete(p.id); done(p); }
      }
    });
  }
  send(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async tool(name, args, timeoutMs) {
    const r = await this.send("tools/call", { name, arguments: args }, timeoutMs);
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    return { text: r.result?.content?.find((c) => c.type === "text")?.text ?? "", isError: r.result?.isError === true };
  }
}

const http = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise((r) => http.listen(PORT, "127.0.0.1", r));
const url = `http://127.0.0.1:${PORT}/fixture`;
console.log(`fixture serving on ${url}`);

const server = spawn("node", [resolve(root, "server/dist/index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" },
});
server.stderr.on("data", (c) => process.stderr.write(`[mcp] ${c}`));
await sleep(500);
const mcp = new McpClient(server);
await mcp.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe-password-live", version: "1" } });
mcp.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let tabId = null;
let failures = 0;
const check = (name, condition, detail) => {
  console.log(`${condition ? "  ok  " : "  FAIL"} ${name}${condition ? "" : ` - ${detail}`}`);
  if (!condition) failures += 1;
};

try {
  const opened = await mcp.tool("new_page_in_container", { name: container, url });
  if (opened.isError) throw new Error(`could not open the probe tab: ${opened.text}`);
  tabId = Number.parseInt(opened.text.match(/tabId=(\d+)/)?.[1] ?? "", 10);
  await mcp.tool("wait_for", { tabId, condition: "stable", stableMs: 500, timeout: 15_000 });

  const info = await mcp.tool("get_firefox_info", {});
  check("installed extension is 0.0.27", info.text.includes("extension.version: 0.0.27"), "wrong version");
  const safe = (name, result) => check(name, !result.isError && !/fixture-(password-8294|revealed-7382)/.test(result.text), "error or leaked fixture value");
  safe("snapshot default", await mcp.tool("take_snapshot", {tabId}));
  safe("snapshot includeAll", await mcp.tool("take_snapshot", {tabId, includeAll:true}));
  safe("get_page_text", await mcp.tool("get_page_text", {tabId}));
  safe("read_page", await mcp.tool("read_page", {tabId}));
  safe("find_by_text", await mcp.tool("find_by_text", {tabId, text:"Password"}));
  safe("evaluate nested values", await mcp.tool("evaluate_script", {tabId, code:'return {nested:[document.querySelector("#password").value,document.querySelector("#revealed").value]}'}));
  const error = await mcp.tool("evaluate_script", {tabId, code:'throw new Error(document.querySelector("#password").value)'});
  check("evaluation error scrubbed", error.isError && !error.text.includes("fixture-password-8294"), "error leaked fixture value");
} finally {
  if (tabId) { try { await mcp.tool("close_page", { tabId }); } catch {} }
  server.kill();
  http.close();
}

console.log(failures === 0 ? "\nPASS - password values stay private" : `\nFAIL - ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
