#!/usr/bin/env node
// Live-Zen probe for durable tab addressing. Creates its own background tab, drives it by
// tabId, checks that a tabId outside the visible set and a stale tabSet fingerprint both
// fail without acting, then cleans up. Touches no pre-existing tab.
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

function expectError(label, r, pattern) {
  if (!r.isError) throw new Error(`${label} should have failed but returned: ${r.text}`);
  if (!pattern.test(r.text)) throw new Error(`${label} wrong error: ${r.text}`);
  console.log(`  ok (failed as required): ${r.text.split("\n")[0]}`);
  return r;
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
    clientInfo: { name: "probe-tabid", version: "0.0.1" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  console.log("\n--- baseline list_pages ---");
  const baseline = expectOk("list_pages", await mcp.callTool("list_pages"));
  const staleFingerprint = /tabSet=([0-9a-f]{8})/.exec(baseline.text)?.[1];
  if (!staleFingerprint) throw new Error("list_pages header is missing the tabSet fingerprint");
  console.log(`> baseline tabSet=${staleFingerprint}`);

  console.log("\n--- new background tab ---");
  const created = expectOk(
    "new_page",
    await mcp.callTool("new_page", { url: "https://example.com/zen-tabid-probe" }),
  );
  const tabId = Number.parseInt(/tabId=(\d+)/.exec(created.text)?.[1] ?? "", 10);
  if (!Number.isFinite(tabId)) throw new Error(`could not parse tabId from: ${created.text}`);
  console.log(`> probe tab is tabId=${tabId}`);
  await sleep(800);

  console.log("\n--- read by tabId ---");
  expectOk("get_page_text by tabId", await mcp.callTool("get_page_text", { tabId }));

  console.log("\n--- stale tabSet must fail closed ---");
  expectError(
    "get_page_text with the pre-creation fingerprint",
    await mcp.callTool("get_page_text", { tabId, expectTabSet: staleFingerprint }),
    /tab set changed/,
  );

  console.log("\n--- tabId that exists in no workspace must fail loudly ---");
  expectError(
    "get_page_text with an absent tabId",
    await mcp.callTool("get_page_text", { tabId: 999999999 }),
    /not found in (the active|any Zen) workspace/,
  );

  console.log("\n--- mutually exclusive params ---");
  expectError(
    "both pageIdx and tabId",
    await mcp.callTool("get_page_text", { tabId, pageIdx: 0 }),
    /exactly one of pageIdx or tabId/,
  );

  console.log("\n--- navigate + close by tabId ---");
  expectOk(
    "navigate_page by tabId",
    await mcp.callTool("navigate_page", { tabId, url: "https://example.com/zen-tabid-probe-2" }),
  );
  await sleep(600);
  expectOk("close_page by tabId", await mcp.callTool("close_page", { tabId }));

  const after = expectOk("list_pages after cleanup", await mcp.callTool("list_pages"));
  if (after.text.includes(`tabId=${tabId}`)) throw new Error("probe tab was not closed");

  console.log("\n[probe-tabid] PASS");
  console.log(
    "\nManual workspace check (optional): note a tabId in workspace A, switch Zen to\n" +
      "workspace B, then re-run a tool with that tabId. Expect it to act on THAT tab in\n" +
      "place (see scripts/probe-hidden.mjs), never on whatever now sits at its old index.",
  );
  server.kill("SIGTERM");
  await sleep(200);
  process.exit(0);
}

main().catch((err) => {
  console.error("[probe-tabid] FAIL:", err.message);
  process.exit(1);
});
