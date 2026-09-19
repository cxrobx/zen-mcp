#!/usr/bin/env node
// Regression probe: a hostile element id must not empty the snapshot.
//
//   node scripts/probe-snapshot-ids.mjs [--container CXVentures]
//
// An element id is author-controlled TEXT. getElementName once interpolated it straight into
// `label[for="<id>"]`, so Wikipedia's id='Construction_of_a_statement_about_"provability"'
// closed the selector string, querySelector threw, the throw unwound the whole walk, and
// inject.ts turned it into a silent empty tree: ZERO controls for a 2,465-control page, with
// nothing to say why. Fixed in extension 0.0.19 (CSS.escape + try/catch, and the swallowed
// error is now reported as snapshotError).
//
// Serves a local fixture whose ids carry quotes, backslashes, brackets, newlines and CSS
// metacharacters, then asserts every control is still found. Needs live Zen + the daemon.
// Nav memory off: fixture traffic must never reach the real store.
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
const PORT = Number.parseInt(arg("port", "8793"), 10);

// Each entry is an id that has broken, or could break, a selector built by string concatenation.
const HOSTILE_IDS = [
  'quote_"inside"_id',
  "apostrophe_'inside'_id",
  "back\\slash_id",
  "bracket[0]_id",
  "colon:and.dot_id",
  "space in id",
  "comma,and>combinator_id",
  "hash#inside_id",
];

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>hostile ids</title></head><body>
<h1>Hostile id fixture</h1>
${HOSTILE_IDS.map(
  (id, i) => `<div><label for="${id.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}">Label ${i}</label>
<input id="${id.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")}" type="text"></div>`,
).join("\n")}
<a id="plain_link" href="https://example.com/">A plain link</a>
<button id="plain_button">A plain button</button>
</body></html>`;

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
console.log(`fixture serving on ${url} (${HOSTILE_IDS.length} hostile ids)`);

const server = spawn("node", [resolve(root, "server/dist/index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" },
});
server.stderr.on("data", (c) => process.stderr.write(`[mcp] ${c}`));
await sleep(500);
const mcp = new McpClient(server);
await mcp.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe-snapshot-ids", version: "1" } });
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

  const snap = await mcp.tool("take_snapshot", { tabId });
  const uids = Number.parseInt(snap.text.match(/\((\d+) UIDs/)?.[1] ?? "-1", 10);
  check("take_snapshot does not error", !snap.isError, snap.text.slice(0, 200));
  check("take_snapshot returns a populated tree", uids > 0, `got ${uids} UIDs - a hostile id emptied the walk`);

  const listing = await mcp.tool("interactive_elements", { tabId });
  check("interactive_elements does not error", !listing.isError, listing.text.slice(0, 200));
  // One input per hostile id, plus the plain link and button.
  const expected = HOSTILE_IDS.length + 2;
  const found = Number.parseInt(listing.text.match(/: (\d+) of (\d+)/)?.[2] ?? "-1", 10);
  check(`all ${expected} controls are listed`, found >= expected, `found ${found}`);
  check("the plain link survived the hostile ids", listing.text.includes("A plain link"), "missing");
  check("the plain button survived the hostile ids", listing.text.includes("A plain button"), "missing");
  if (failures) console.log(`\n--- listing ---\n${listing.text.slice(0, 900)}`);
} finally {
  if (tabId) { try { await mcp.tool("close_page", { tabId }); } catch {} }
  server.kill();
  http.close();
}

console.log(failures === 0 ? "\nPASS - hostile ids do not empty the snapshot" : `\nFAIL - ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
