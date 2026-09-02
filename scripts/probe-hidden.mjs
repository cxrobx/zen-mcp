#!/usr/bin/env node
// Live-Zen probe for tabs in NON-ACTIVE Zen workspaces (T164). Read-only: it never opens,
// navigates, closes, or selects a tab, and it never switches your workspace. It proves that
//   1. list_pages includeHidden=true enumerates tabs the plain list cannot see,
//   2. a read (get_page_text) reaches such a tab by tabId, in place,
//   3. open_url with reuse="exact" lands on that tab instead of opening a new one,
// and that the visible tab set and the active tab are untouched afterwards.
// Needs extension >= 0.0.18 installed in Zen, and at least one tab in another workspace.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

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
      }, 20000);
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
    return {
      isError: r.result?.isError === true,
      text: r.result?.content?.find?.((c) => c.type === "text")?.text ?? "",
    };
  }
}

function expectOk(label, r) {
  if (r.isError) throw new Error(`${label} unexpectedly failed: ${r.text}`);
  console.log(`  ok: ${r.text.split("\n")[0]}`);
  return r;
}

const HIDDEN_LINE = /^\s+\[-\] tabId=(\d+) (\S+)(?: "(.*)")? \((.+?)\)( \[unloaded\])?$/;

function parseHidden(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = HIDDEN_LINE.exec(line);
    if (m) out.push({ tabId: Number(m[1]), url: m[2], title: m[3] ?? "", container: m[4], unloaded: !!m[5] });
  }
  return out;
}

function visibleHeader(text) {
  const m = /^(\d+) tabs? visible in the active Zen workspace · tabSet=([0-9a-f]{8})/.exec(text);
  if (!m) throw new Error(`list_pages header not recognised: ${text.split("\n")[0]}`);
  return { count: Number(m[1]), fingerprint: m[2] };
}

function activeLine(text) {
  return text.split("\n").find((l) => l.startsWith("* [")) ?? "(none)";
}

async function main() {
  const server = spawn("node", [resolve(root, "server/dist/index.js"), "--port", "8766"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" },
  });
  server.stderr.on("data", (c) => process.stderr.write(`[mcp] ${c}`));
  await sleep(400);
  const mcp = new McpClient(server);
  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe-hidden", version: "0.0.1" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("\n--- extension version ---");
  const info = expectOk("get_firefox_info", await mcp.callTool("get_firefox_info"));
  const version = /extension(?:Version|\.version)?:?\s*v?(\d+\.\d+\.\d+)/i.exec(info.text)?.[1];
  console.log(`> extension ${version ?? "(version not parsed)"}`);
  if (version) {
    const [a, b, c] = version.split(".").map(Number);
    if (a === 0 && b === 0 && c < 18) {
      throw new Error(`extension ${version} predates pages.get / includeHidden - install the 0.0.18 XPI first`);
    }
  }

  console.log("\n--- visible list vs includeHidden ---");
  const plain = expectOk("list_pages", await mcp.callTool("list_pages"));
  const before = visibleHeader(plain.text);
  const activeBefore = activeLine(plain.text);
  const full = expectOk("list_pages includeHidden", await mcp.callTool("list_pages", { includeHidden: true }));
  const hidden = parseHidden(full.text);
  const more = /(\d+) more tabs? in other Zen workspaces/.exec(full.text);
  console.log(`> visible=${before.count} hidden=${hidden.length} (header says ${more?.[1] ?? "none"})`);
  if (visibleHeader(full.text).fingerprint !== before.fingerprint) {
    throw new Error("includeHidden changed the tabSet fingerprint - it must describe the visible set only");
  }
  if (hidden.length === 0) {
    throw new Error("no tabs in other Zen workspaces - open one in another space and re-run");
  }
  for (const h of plain.text.split("\n")) {
    if (h.includes("[-] tabId=")) throw new Error("plain list_pages leaked a hidden tab");
  }
  const resend = hidden.find((h) => h.url.includes("resend.com"));
  if (resend) console.log(`> the T164 tab itself is reachable: tabId=${resend.tabId} ${resend.url} (${resend.container})`);

  const pick =
    hidden.find((h) => /^https?:/.test(h.url) && !h.unloaded) ?? hidden.find((h) => /^https?:/.test(h.url));
  if (!pick) throw new Error("no http(s) tab among the hidden ones to probe with");
  console.log(`> probing tabId=${pick.tabId} ${pick.url} (${pick.container})${pick.unloaded ? " [unloaded]" : ""}`);

  console.log("\n--- read in place by tabId (no workspace switch) ---");
  if (pick.unloaded) {
    console.log("  skipped: tab is unloaded; a read would need a navigate/select first");
  } else {
    const read = await mcp.callTool("get_page_text", { tabId: pick.tabId });
    if (read.isError) throw new Error(`get_page_text on the hidden tab failed: ${read.text}`);
    console.log(`  ok: ${read.text.replace(/\s+/g, " ").slice(0, 100)}`);
  }

  console.log("\n--- open_url reuse=exact must land on the hidden tab, not open one ---");
  const args = { url: pick.url, reuse: "exact" };
  if (pick.container !== "no container") args.container = pick.container;
  const opened = expectOk("open_url", await mcp.callTool("open_url", args));
  if (!new RegExp(`^found tabId=${pick.tabId} `).test(opened.text)) {
    throw new Error(`open_url did not land on tabId=${pick.tabId}: ${opened.text}`);
  }
  if (!opened.text.includes("[in another Zen workspace]")) {
    throw new Error(`open_url did not report the workspace: ${opened.text}`);
  }

  console.log("\n--- nothing visible may have changed ---");
  await sleep(300);
  const after = visibleHeader(expectOk("list_pages", await mcp.callTool("list_pages")).text);
  if (after.count !== before.count) throw new Error(`visible tab count changed ${before.count} -> ${after.count}`);
  const activeAfter = activeLine((await mcp.callTool("list_pages")).text);
  if (activeAfter !== activeBefore) throw new Error(`active tab changed:\n  ${activeBefore}\n  ${activeAfter}`);
  console.log(`  ok: still ${after.count} visible, same active tab`);

  console.log("\n[probe-hidden] PASS");
  console.log(
    "\nManual check (optional, switches your workspace): select_page({ tabId: " +
      `${pick.tabId} }) should make Zen jump to that tab's workspace and report it.`,
  );
  server.kill("SIGTERM");
  await sleep(200);
  process.exit(0);
}

main().catch((err) => {
  console.error("[probe-hidden] FAIL:", err.message);
  process.exit(1);
});
