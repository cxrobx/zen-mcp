#!/usr/bin/env node
// Regression probe for the "ambiguous selector -> wrong-element action" class (T315).
//
//   node scripts/probe-uid-selectors.mjs [--container CXVentures] [--port 8794]
//
// Every uid action re-queries the uid's snapshot CSS and acts on the match. The generator used
// to drop :nth-of-type at any step built from a repeated [data-testid], so on Impact's billing
// form (a same-origin iframe) City and Street Address 1 got the SAME selector, and fill_by_uid
// wrote both into Street 1. Fixed in extension 0.0.26: a repeated attribute step gets a
// sibling index, the finished selector must select exactly its element (else a positional
// one is used), and every uid action refuses a selector that now matches several elements.
//
// The fixture mirrors that form: six sibling div[data-testid="field-pair"] rows, each holding
// label[data-testid="text-input"] > input[data-testid="input"], once in the top frame and once
// in a same-origin iframe. Asserts that
//   1. every input uid resolves to a distinct selector that matches exactly that input;
//   2. fill_by_uid on the 2nd and 5th input (both frames) writes there and nowhere else;
//   3. fill_form_by_uid does the same for the 3rd and 6th;
//   4. a uid whose selector stops being unique (a clone added after the snapshot) is refused
//      and nothing is written.
// Needs live Zen + the daemon. Nav memory off: fixture traffic must never reach the real store.
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
const PORT = Number.parseInt(arg("port", "8794"), 10);
const ROWS = 6;

const rows = (prefix) =>
  Array.from(
    { length: ROWS },
    (_, i) => `<div data-testid="field-pair"><div>${prefix} ${i + 1}</div><div>
  <label data-testid="text-input"><input data-testid="input" type="text" aria-label="${prefix} ${i + 1}"></label></div></div>`,
  ).join("\n");

const form = (prefix, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${prefix}</title></head><body>
<div id="app"><div><div>${rows(prefix)}</div></div></div>
<input data-testid="zip" type="text" aria-label="${prefix} zip">
${extra}
</body></html>`;

const PAGES = {
  "/fixture": form("top", `<iframe id="screenIframe" src="/frame" style="width:600px;height:400px"></iframe>`),
  "/frame": form("frame"),
};

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

const http = createServer((req, res) => {
  const body = PAGES[req.url ?? ""];
  res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  res.end(body ?? "not found");
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
await mcp.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe-uid-selectors", version: "1" } });
mcp.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

let tabId = null;
let failures = 0;
const check = (name, condition, detail) => {
  console.log(`${condition ? "  ok  " : "  FAIL"} ${name}${condition ? "" : ` - ${detail}`}`);
  if (!condition) failures += 1;
};

// evaluate_script runs in the top frame; the iframe is same-origin, so reach it from there.
const docExpr = (frame) =>
  frame === "frame" ? `document.getElementById("screenIframe").contentDocument` : "document";
const evalJson = async (code) => {
  const r = await mcp.tool("evaluate_script", { tabId, code });
  if (r.isError) throw new Error(`evaluate_script: ${r.text}`);
  const m = r.text.match(/[[{][\s\S]*[\]}]/);
  return JSON.parse(m ? m[0] : r.text);
};
const values = (frame) =>
  evalJson(`return Array.from(${docExpr(frame)}.querySelectorAll('input[data-testid="input"]')).map(e => e.value);`);
const clear = () =>
  evalJson(`for (const d of [${docExpr("top")}, ${docExpr("frame")}]) for (const e of d.querySelectorAll("input")) e.value = ""; return [];`);
const snapshotUids = async () => {
  const snap = await mcp.tool("take_snapshot", { tabId });
  if (snap.isError) throw new Error(`take_snapshot: ${snap.text}`);
  const uidFor = (label) => snap.text.match(new RegExp(`input#(\\S+)[^\\n]*name="${label}"`))?.[1] ?? null;
  return { text: snap.text, uidFor };
};

try {
  const opened = await mcp.tool("new_page_in_container", { name: container, url });
  if (opened.isError) throw new Error(`could not open the probe tab: ${opened.text}`);
  tabId = Number.parseInt(opened.text.match(/tabId=(\d+)/)?.[1] ?? "", 10);
  await mcp.tool("wait_for", { tabId, condition: "stable", stableMs: 500, timeout: 15_000 });

  const { text, uidFor } = await snapshotUids();
  const inputs = [];
  for (const frame of ["top", "frame"]) {
    for (let i = 1; i <= ROWS; i++) inputs.push({ frame, i, uid: uidFor(`${frame} ${i}`) });
  }
  const missing = inputs.filter((x) => !x.uid);
  check(`snapshot lists all ${inputs.length} inputs in both frames`, missing.length === 0,
    `missing ${missing.map((x) => `${x.frame} ${x.i}`).join(", ")}\n${text.slice(0, 1500)}`);
  if (missing.length) throw new Error("cannot continue without uids");

  // 1. distinct selectors, each matching exactly its own input.
  for (const x of inputs) {
    const r = await mcp.tool("resolve_uid_to_selector", { tabId, uid: x.uid });
    x.css = r.text.match(/^css=(.*)$/m)?.[1] ?? "";
  }
  for (const frame of ["top", "frame"]) {
    const mine = inputs.filter((x) => x.frame === frame);
    check(`${frame}: ${ROWS} inputs get ${ROWS} distinct selectors`, new Set(mine.map((x) => x.css)).size === ROWS,
      mine.map((x) => `${x.i}: ${x.css}`).join("\n"));
    const resolved = await evalJson(`const d = ${docExpr(frame)};
      const all = Array.from(d.querySelectorAll('input[data-testid="input"]'));
      return ${JSON.stringify(mine.map((x) => x.css))}.map(s => { const m = d.querySelectorAll(s); return [m.length, all.indexOf(m[0]) + 1]; });`);
    resolved.forEach(([count, index], k) => {
      check(`${frame} ${k + 1}: selector matches exactly input ${k + 1}`, count === 1 && index === k + 1,
        `matched ${count} element(s), first is input ${index}: ${mine[k].css}`);
    });
  }

  // 2. fill_by_uid on the 2nd and 5th inputs.
  await clear();
  for (const x of inputs.filter((x) => x.i === 2 || x.i === 5)) {
    const r = await mcp.tool("fill_by_uid", { tabId, uid: x.uid, value: `${x.frame}-${x.i}` });
    check(`fill_by_uid ${x.frame} ${x.i} succeeds`, !r.isError, r.text);
  }
  for (const frame of ["top", "frame"]) {
    const got = await values(frame);
    const want = Array.from({ length: ROWS }, (_, k) => (k === 1 || k === 4 ? `${frame}-${k + 1}` : ""));
    check(`${frame}: fill_by_uid wrote only inputs 2 and 5`, JSON.stringify(got) === JSON.stringify(want),
      `got ${JSON.stringify(got)}`);
  }

  // 3. fill_form_by_uid on the 3rd and 6th inputs, both frames in one call.
  await clear();
  const formFields = inputs.filter((x) => x.i === 3 || x.i === 6).map((x) => ({ uid: x.uid, value: `${x.frame}-${x.i}` }));
  const filled = await mcp.tool("fill_form_by_uid", { tabId, fields: formFields });
  check("fill_form_by_uid succeeds", !filled.isError, filled.text);
  for (const frame of ["top", "frame"]) {
    const got = await values(frame);
    const want = Array.from({ length: ROWS }, (_, k) => (k === 2 || k === 5 ? `${frame}-${k + 1}` : ""));
    check(`${frame}: fill_form_by_uid wrote only inputs 3 and 6`, JSON.stringify(got) === JSON.stringify(want),
      `got ${JSON.stringify(got)}`);
  }

  // 4. A selector that stops being unique after the snapshot is refused, not guessed.
  await clear();
  const zipUid = uidFor("top zip");
  const zipCss = (await mcp.tool("resolve_uid_to_selector", { tabId, uid: zipUid })).text.match(/^css=(.*)$/m)?.[1];
  await evalJson(`const z = document.querySelector('input[data-testid="zip"]');
    const c = z.cloneNode(); c.setAttribute("aria-label", "top zip clone"); z.before(c); return [];`);
  const stillMatches = await evalJson(`return [document.querySelectorAll(${JSON.stringify(zipCss)}).length];`);
  if (stillMatches[0] > 1) {
    const refused = await mcp.tool("fill_by_uid", { tabId, uid: zipUid, value: "should-not-land" });
    check("fill_by_uid refuses a now-ambiguous selector", refused.isError && /ambiguous/.test(refused.text), refused.text);
    const zips = await evalJson(`return Array.from(document.querySelectorAll('input[data-testid="zip"]')).map(e => e.value);`);
    check("nothing was written by the refused fill", zips.every((v) => v === ""), JSON.stringify(zips));
  } else {
    console.log(`  skip  ambiguity guard: the zip selector stayed unique after cloning (${zipCss})`);
  }
} finally {
  if (tabId) { try { await mcp.tool("close_page", { tabId }); } catch {} }
  server.kill();
  http.close();
}

console.log(failures === 0 ? "\nPASS - every uid selects exactly its own element" : `\nFAIL - ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
