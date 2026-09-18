#!/usr/bin/env node
// Live timeline of what a page does AFTER a click, sampled every ~100ms: readyState, interactive
// control count, document.title, innerText length, path. Run it before tuning any wait constant.
//
//   node scripts/probe-transition.mjs --container CXVentures //     --url "https://search.google.com/search-console?resource_id=sc-domain:cxventures.io" //     --text Pages --for 5000
//
// Measured 2026-09-18 on Search Console: the URL flips on the click, the count wobbles at once
// (60 -> 58, still the old view), a loading skeleton holds a STABLE count of 84 under the old
// title for ~850ms, and the real page arrives with the title change at ~1.46s. A quiet-window
// wait reports "stable" on the old view; navigate_goal therefore waits for the title.
//
// Opens its own tab in the container and closes it. Nav memory is off.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}


class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.buf = "";
    this.pending = new Map();
    child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const line of lines) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const done = this.pending.get(parsed.id);
        if (done) {
          this.pending.delete(parsed.id);
          done(parsed);
        }
      }
    });
  }

  send(method, params, timeoutMs = 60_000) {
    const id = this.nextId++;
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectP(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveP(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async tool(name, args, timeoutMs) {
    const started = Date.now();
    const r = await this.send("tools/call", { name, arguments: args }, timeoutMs);
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    const text = r.result?.content?.find((c) => c.type === "text")?.text ?? "";
    return { text, isError: r.result?.isError === true, ms: Date.now() - started };
  }
}
const container = arg("container", "CXVentures");
const url = arg("url", "https://search.google.com/search-console?resource_id=sc-domain:cxventures.io");
const text = arg("text", "Pages");
const forMs = Number.parseInt(arg("for", "5000"), 10);
const server = spawn("node", [resolvePath(root, "server/dist/index.js")], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" } });
server.stderr.resume();
await sleep(400);
const mcp = new McpClient(server);
await mcp.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe-transition", version: "0.0.1" } });
mcp.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const PROBE = "var sel='a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=option],[role=combobox]'; return [document.readyState, document.querySelectorAll(sel).length, document.title, (document.body&&document.body.innerText||'').length, location.pathname];";
let tabId = null;
try {
  const opened = await mcp.tool("new_page_in_container", { name: container, url });
  tabId = Number.parseInt(opened.text.match(/tabId=(\d+)/)?.[1] ?? "", 10);
  await mcp.tool("wait_for", { tabId, condition: "stable", stableMs: 800, timeout: 20_000 });
  const found = await mcp.tool("find_by_text", { tabId, text });
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const uid = found.text.match(new RegExp(`uid=(\\S+) \\w+ text="${escaped}"`))?.[1];
  if (!uid) throw new Error(`no control with text "${text}":
${found.text}`);
  console.log("clicking", uid);
  const t0 = Date.now();
  const before = await mcp.tool("evaluate_script", { tabId, code: PROBE });
  console.log(`${Date.now() - t0}ms before  ${before.text.replace(/\s+/g, " ")}`);
  const clicked = await mcp.tool("click_by_uid", { tabId, uid });
  console.log(`${Date.now() - t0}ms click returned (${clicked.ms}ms) ${clicked.text.split("\n")[1]?.slice(0, 60)}`);
  let last = "";
  while (Date.now() - t0 < forMs) {
    const r = await mcp.tool("evaluate_script", { tabId, code: PROBE });
    const line = r.text.replace(/\s+/g, " ");
    if (line !== last) console.log(`${Date.now() - t0}ms ${line}`);
    last = line;
    await sleep(60);
  }
} finally {
  if (tabId !== null) await mcp.tool("close_page", { tabId }).catch(() => {});
  server.kill("SIGTERM");
}
