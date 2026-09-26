#!/usr/bin/env node
// Live probe: credential-shaped strings never come back from a tool, screenshots included.
//
//   node scripts/probe-redact.mjs [--container CXVentures] [--port 8794] [--save <dir>]
//
// Serves a local page that holds fake keys the ways real dashboards do: a full key in an
// aria-label behind a truncated label (Stripe's API-keys row), a key printed in full (Stripe's
// older layout), a token in an input value, a key split across two spans, a PEM block, and a
// "Copy and close" button that moves focus onto a field named by the key. Then drives every
// page-reading tool at it through the real server + extension and asserts only prefix + last 4
// comes back. For screenshot_page it asserts the extension masked the page for the capture and
// put every node back afterwards; pass --save to write the PNG out and look at it.
//
// Needs live Zen + the daemon; the screenshot checks need extension >= 0.0.22. Nav memory off:
// fixture traffic must never reach the real store. Fixture keys are assembled at runtime so
// no scanner mistakes this public file for a leak.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const container = arg("container", "CXVentures");
const PORT = Number.parseInt(arg("port", "8794"), 10);
const saveDir = arg("save", "");

const K = {
  named: ["sk", "test", "51Pq7ZabCDefGHijKLmnOPqrSTuvWXyz0123456789AbCdEf9x4Q"].join("_"),
  shown: ["sk", "test", "51Rr8YxwVUtsRQpoNMlkJIhgFEdc9876543210ZyXwVu7Kp2"].join("_"),
  github: "gh" + "p_" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3z5A",
  splitPrefix: ["sk", "live", ""].join("_"),
  splitBody: "Zz81AbCdEfGhIjKlMnOp7Q2wXx",
  webhook: "whsec" + "_" + "Qm3kF8zLr2Xy7VbN0pT4sW6uH1jD9cA5",
};
const PEM_LINE = "MIIEowIBAAKCAQEAq7ZabCDefGHijKLmnOPqrSTuvWXyz0123456789AbCdEfGhIj";
const PEM = ["-----BEGIN " + "RSA PRIVATE KEY-----", PEM_LINE, "-----END " + "RSA PRIVATE KEY-----"].join("\n");
const LEAKS = [K.named, K.shown, K.github, K.splitPrefix + K.splitBody, K.webhook, PEM_LINE];
const BODIES = LEAKS.map((s) => s.slice(-20, -4));

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>API keys (probe)</title>
<style>body{font:16px system-ui;margin:24px} code,pre{font-size:15px}</style></head><body>
<h1>API keys</h1>
<p>Secret key <button id="reveal" aria-label="Reveal ${esc(K.named)}">sk_test_51Pq…9x4Q</button></p>
<p id="shown">Standard key <code>${esc(K.shown)}</code></p>
<p id="split">Restricted key <span class="p">${esc(K.splitPrefix)}</span><span class="b">${esc(K.splitBody)}</span></p>
<p>Signing secret <span id="webhook">${esc(K.webhook)}</span></p>
<label>GitHub token <input id="gh" size="48" value="${esc(K.github)}"></label>
<p><input id="keyfield" readonly size="60" aria-label="${esc(K.named)}" value="${esc(K.named)}">
<button id="copy" onclick="document.getElementById('keyfield').focus()">Copy and close</button></p>
<pre id="pem">${esc(PEM)}</pre>
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
    const content = r.result?.content ?? [];
    return {
      text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      image: content.find((c) => c.type === "image"),
      isError: r.result?.isError === true,
    };
  }
}

const http = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise((r) => http.listen(PORT, "127.0.0.1", r));
const url = `http://127.0.0.1:${PORT}/apikeys`;
console.log(`fixture serving on ${url}`);

const server = spawn("node", [resolve(root, "server/dist/index.js")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" },
});
server.stderr.on("data", (c) => process.stderr.write(`[mcp] ${c}`));
await sleep(500);
const mcp = new McpClient(server);
await mcp.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe-redact", version: "1" } });
mcp.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let tabId = null;
let failures = 0;
const check = (name, condition, detail) => {
  console.log(`${condition ? "  ok  " : "  FAIL"} ${name}${condition ? "" : ` - ${detail}`}`);
  if (!condition) failures += 1;
};
const leakIn = (text) => {
  for (let i = 0; i < LEAKS.length; i++) {
    if (text.includes(LEAKS[i]) || text.includes(BODIES[i])) return LEAKS[i].slice(0, 12) + "…";
  }
  return null;
};
const noLeak = (label, r) => {
  const leak = leakIn(r.text);
  check(`${label}: no key comes back`, !r.isError && !leak, r.isError ? r.text.slice(0, 200) : `leaked ${leak}`);
};

try {
  const opened = await mcp.tool("new_page_in_container", { name: container, url });
  if (opened.isError) throw new Error(`could not open the probe tab: ${opened.text}`);
  tabId = Number.parseInt(opened.text.match(/tabId=(\d+)/)?.[1] ?? "", 10);
  await mcp.tool("wait_for", { tabId, condition: "stable", stableMs: 500, timeout: 15_000 });

  const snap = await mcp.tool("take_snapshot", { tabId });
  noLeak("take_snapshot", snap);
  check("take_snapshot still names the aria-label key by prefix + last 4", snap.text.includes("sk_test_…9x4Q"), "masked form missing");
  noLeak("find_by_text", await mcp.tool("find_by_text", { tabId, text: "sk_" }));
  noLeak("interactive_elements", await mcp.tool("interactive_elements", { tabId }));
  noLeak("get_page_text", await mcp.tool("get_page_text", { tabId }));
  noLeak("read_page", await mcp.tool("read_page", { tabId }));
  noLeak("evaluate_script", await mcp.tool("evaluate_script", { tabId, code: "return document.body.innerText" }));

  const click = await mcp.tool("click", { tabId, selector: "css:#copy" });
  noLeak("click (active= after focus lands on the key field)", click);
  check("click still reports the focused field", /active=input name="sk_test_…9x4Q"/.test(click.text), click.text.slice(-200));

  const shot = await mcp.tool("screenshot_page", { tabId, format: "png" });
  noLeak("screenshot_page text", shot);
  const masked = Number.parseInt(shot.text.match(/(\d+) credential-shaped strings? masked/)?.[1] ?? "-1", 10);
  if (/predates the screenshot credential mask/.test(shot.text)) {
    check("extension masks the page before a screenshot", false, "installed extension is older than 0.0.22");
  } else {
    // #reveal holds its key only in an attribute, which is not painted; the other five are.
    check("screenshot masked every painted key (>= 5)", masked >= 5, `masked=${masked}: ${shot.text}`);
  }
  if (saveDir && shot.image) {
    const out = join(saveDir, "probe-redact.png");
    await writeFile(out, Buffer.from(shot.image.data, "base64"));
    console.log(`  saved ${out}`);
  }

  // Every node must be back as the page wrote it. Compared inside the page so the result is a
  // boolean, not the key.
  const restored = await mcp.tool("evaluate_script", {
    tabId,
    code: `
      const expect = ${JSON.stringify({ shown: K.shown, split: K.splitPrefix + K.splitBody, webhook: K.webhook, gh: K.github, key: K.named, pem: PEM })};
      const bad = [];
      if (!document.getElementById("shown").textContent.includes(expect.shown)) bad.push("shown");
      if (!document.getElementById("split").textContent.includes(expect.split)) bad.push("split");
      if (document.getElementById("split").getAttribute("style")) bad.push("split style");
      if (document.getElementById("webhook").textContent !== expect.webhook) bad.push("webhook");
      if (document.getElementById("gh").value !== expect.gh) bad.push("gh value");
      if (document.getElementById("keyfield").value !== expect.key) bad.push("keyfield value");
      if (document.getElementById("pem").textContent !== expect.pem) bad.push("pem");
      return bad.join(",") || "restored";`,
  });
  check("the page is restored after the capture", restored.text.includes("restored"), restored.text);
} finally {
  if (tabId) { try { await mcp.tool("close_page", { tabId }); } catch {} }
  server.kill();
  http.close();
}

console.log(failures === 0 ? "\nPASS - no credential came back from any tool" : `\nFAIL - ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
