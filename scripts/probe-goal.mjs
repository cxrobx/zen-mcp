#!/usr/bin/env node
// Live probe for interactive_elements + navigate_goal against real Zen and the real
// TypeSafe API. Opens its OWN background tab in the given container (never reuses one of
// yours), runs the goal, prints the trace, and closes the tab unless --keep.
//
//   node scripts/probe-goal.mjs \
//     --container CXVentures \
//     --url "https://search.google.com/search-console?resource_id=sc-domain:cxventures.io" \
//     --goal "open the Pages indexing report"
//
// Needs: the host in ~/.config/zen-mcp/jev.json, TYPESAFE_API_KEY in the Keychain (sk), and
// the container logged in to the site. Sends that page's control labels to api.typesafe.ai.
// Nav memory is off (probe traffic must not be distilled into the real store).
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const container = arg("container", "CXVentures");
const url = arg("url", "https://search.google.com/search-console?resource_id=sc-domain:cxventures.io");
const goal = arg("goal", "open the Pages indexing report");
const maxSteps = Number.parseInt(arg("max-steps", "5"), 10);
const keep = process.argv.includes("--keep");

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

const server = spawn("node", [resolve(root, "server/dist/index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" },
});
server.stderr.on("data", (c) => process.stderr.write(`[mcp] ${c}`));
await sleep(400);
const mcp = new McpClient(server);
await mcp.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe-goal", version: "0.0.1" } });
mcp.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let tabId = null;
try {
  const opened = await mcp.tool("new_page_in_container", { name: container, url });
  console.log(opened.text);
  if (opened.isError) throw new Error("could not open the probe tab");
  tabId = Number.parseInt(opened.text.match(/tabId=(\d+)/)?.[1] ?? "", 10);
  if (!Number.isFinite(tabId)) throw new Error("no tabId in new_page_in_container output");

  const settled = await mcp.tool("wait_for", { tabId, condition: "stable", stableMs: 800, timeout: 20_000 });
  console.log(`\n--- wait_for stable (${settled.ms}ms) ---\n${settled.text}`);

  const snapshot = await mcp.tool("take_snapshot", { tabId });
  const listing = await mcp.tool("interactive_elements", { tabId });
  console.log(`\n--- size: take_snapshot ${snapshot.text.length} chars vs interactive_elements ${listing.text.length} chars ---`);
  console.log(listing.text.split("\n").slice(0, 25).join("\n"));
  if (listing.text.split("\n").length > 25) console.log("...");

  const result = await mcp.tool("navigate_goal", { tabId, goal, maxSteps }, 180_000);
  console.log(`\n--- navigate_goal (${result.ms}ms wall) ---\n${result.text}`);
} finally {
  if (tabId !== null && !keep) {
    const closed = await mcp.tool("close_page", { tabId }).catch((e) => ({ text: String(e) }));
    console.log(`\n${closed.text}`);
  }
  server.kill("SIGTERM");
}
