#!/usr/bin/env node
// Live probe for the opt-in trusted input path (T299) against real Zen.
//
// The fixture's controls act ONLY on isTrusted events, the way Google's Material select does,
// so each check asserts both halves: the synthetic path is refused by the page and the
// trusted path works. Also pins fill_by_uid on a controlled (framework-style) input.
//
// It moves your real cursor briefly and brings Zen to the front, like any trusted click.
// Needs extension >= 0.0.23, native/build.sh, and Accessibility granted to the helper.
// Closes every tab on the fixture port, pass or fail.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const FIXTURE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>zen-mcp trusted fixture</title>
<style>
  body { font: 14px/1.4 -apple-system, sans-serif; padding: 2rem; }
  button, [role=listbox] { padding: .5rem 1rem; margin: .5rem 0; display: inline-block; border: 1px solid #888; cursor: pointer; }
  #menu { position: absolute; background: #fff; border: 1px solid #888; }
  #menu [role=option] { height: 0; overflow: hidden; padding: 0 1rem; }
  #menu.open [role=option] { height: 2rem; line-height: 2rem; }
</style></head><body>
  <h1>Trusted fixture</h1>
  <div><button id="trusted-btn" type="button">Trusted only</button> <span id="trusted-result">initial</span></div>
  <div><div id="lb" role="listbox" aria-expanded="false" tabindex="0">Pick one</div>
    <div id="menu"><div role="option" data-value="a">Alpha</div><div role="option" data-value="b">Beta</div></div></div>
  <div><button id="popup-btn" type="button">Open popup</button> <span id="popup-result">initial</span></div>
  <div><input id="controlled" aria-label="Controlled input" placeholder="controlled"></div>
  <div><input id="keys" aria-label="Key field" placeholder="keys"> <span id="key-result">initial</span>
    <input id="after-tab" aria-label="After tab"></div>
  <shadow-panel id="panel"></shadow-panel>
<script>
  const out = (id, v) => { document.getElementById(id).textContent = v; };
  document.getElementById('trusted-btn').addEventListener('click', (e) => out('trusted-result', e.isTrusted ? 'trusted' : 'synthetic'));
  const lb = document.getElementById('lb'), menu = document.getElementById('menu');
  lb.addEventListener('mousedown', (e) => {
    if (!e.isTrusted) return;           // Material-style gate
    lb.setAttribute('aria-expanded', 'true'); menu.classList.add('open');
  });
  for (const opt of menu.querySelectorAll('[role=option]')) {
    opt.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      lb.textContent = opt.textContent; lb.dataset.value = opt.dataset.value;
      lb.setAttribute('aria-expanded', 'false'); menu.classList.remove('open');
    });
  }
  document.getElementById('popup-btn').addEventListener('click', () => {
    const w = window.open('/popup', 'zenprobe', 'width=420,height=300');
    out('popup-result', w ? 'opened' : 'blocked');
  });
  // A controlled input: its model only moves on an InputEvent, and a render tick puts the
  // model back into the DOM, as React/Angular do.
  const ctl = document.getElementById('controlled'); let model = '';
  ctl.addEventListener('input', (e) => { if (e instanceof InputEvent) model = ctl.value; });
  setInterval(() => { if (ctl.value !== model) ctl.value = model; }, 20);
  document.getElementById('keys').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') out('key-result', e.isTrusted ? 'trusted' : 'synthetic');
  });
  // Open shadow root holding real controls, like Impact's React app.
  customElements.define('shadow-panel', class extends HTMLElement {
    connectedCallback() {
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<p>Shadow account name</p><input id="acct" aria-label="Account name">' +
        '<button id="shadow-btn" type="button">Shadow continue</button><span id="shadow-out">initial</span>';
      root.getElementById('shadow-btn').addEventListener('click', () => { root.getElementById('shadow-out').textContent = 'clicked'; });
    }
  });
</script></body></html>`;

function spawnLogged(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], ...opts });
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  return child;
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
      if (parsed.id !== undefined && this.pending.has(parsed.id)) {
        const { resolve } = this.pending.get(parsed.id);
        this.pending.delete(parsed.id);
        resolve(parsed);
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
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolveP(msg);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async callTool(name, args) {
    const r = await this.send("tools/call", { name, arguments: args ?? {} });
    if (r.error) throw new Error(`${name}: ${r.error.message}`);
    const text = r.result?.content?.find?.((c) => c.type === "text")?.text ?? "";
    if (r.result?.isError) throw new Error(`${name}: ${text}`);
    return text;
  }
}

function step(label, body) {
  console.log(`\n--- ${label} ---`);
  return body();
}

function findUidForTagId(snapshot, tag, idHint) {
  // Crude scan of the formatted snapshot text for a line beginning with `tag#UID`
  // where the id hint is present elsewhere on the line.
  const lines = snapshot.split("\n");
  for (const line of lines) {
    const m = line.match(new RegExp(`(?:^|\\s)${tag}#([\\w_]+)`));
    if (m && (!idHint || line.toLowerCase().includes(idHint.toLowerCase()))) {
      return m[1];
    }
  }
  return null;
}


const NOW = () => new Date().toISOString().slice(11, 19);
let failures = 0;
function check(label, okay, detail) {
  console.log(`${okay ? "PASS" : "FAIL"} ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!okay) failures++;
}

async function main() {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url?.startsWith("/popup") ? "<title>popup</title>popup" : FIXTURE_HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const fixtureUrl = `http://127.0.0.1:${port}/fixture`;
  console.log(`[${NOW()}] fixture on ${fixtureUrl}`);

  const mcpProc = spawnLogged("mcp", "node", [resolve(root, "server/dist/index.js"), "--port", "8766"], {
    env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" },
  });
  await sleep(400);
  const mcp = new McpClient(mcpProc);
  await mcp.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe-trusted", version: "0.0.1" } });
  mcp.notify("notifications/initialized");

  const closeFixtureTabs = async () => {
    const pages = await mcp.callTool("list_pages", { includeHidden: true }).catch(() => "");
    for (const l of pages.split("\n").filter((x) => x.includes(`127.0.0.1:${port}`))) {
      const tabId = Number.parseInt(l.match(/tabId=(\d+)/)?.[1] ?? "", 10);
      if (Number.isFinite(tabId)) await mcp.callTool("close_page", { tabId }).catch(() => {});
    }
  };
  const read = async (tabId, expr) =>
    (await mcp.callTool("evaluate_script", { tabId, code: `return ${expr};` })).trim();

  try {
    const opened = await mcp.callTool("new_page", { url: fixtureUrl });
    const tabId = Number.parseInt(opened.match(/tabId=(\d+)/)?.[1] ?? "", 10);
    await sleep(800);
    const has = (s, v) => s.includes(v);

    // fill_by_uid on a controlled input (no OS events involved).
    const snap = await mcp.callTool("take_snapshot", { tabId });
    const uid = snap.split("\n").find((l) => l.includes("Controlled input"))?.match(/#([\w_]+)/)?.[1];
    await mcp.callTool("fill_by_uid", { tabId, uid, value: "hello" });
    await sleep(200);
    check("fill_by_uid sticks on a controlled input", has(await read(tabId, "document.getElementById('controlled').value"), "hello"));

    // Synthetic halves: the page must refuse them, or the fixture proves nothing.
    await mcp.callTool("click", { tabId, selector: "#trusted-btn" });
    check("synthetic click is seen as synthetic", has(await read(tabId, "document.getElementById('trusted-result').textContent"), "synthetic"));
    await mcp.callTool("click", { tabId, selector: "#lb" });
    check("synthetic click leaves the listbox closed", has(await read(tabId, "document.getElementById('lb').getAttribute('aria-expanded')"), "false"));

    // Trusted halves.
    console.log(await mcp.callTool("click", { tabId, selector: "#trusted-btn", trusted: true }));
    check("trusted click is seen as trusted", has(await read(tabId, "document.getElementById('trusted-result').textContent"), "trusted"));
    console.log(await mcp.callTool("select_option", { tabId, selector: "#lb", by: "label", value: "Beta", trusted: true }));
    check("trusted select_option picks Beta", has(await read(tabId, "document.getElementById('lb').dataset.value || ''"), "b"));
    const popupText = await mcp.callTool("click", { tabId, selector: "#popup-btn", trusted: true });
    console.log(popupText);
    check("trusted click opens a popup", has(await read(tabId, "document.getElementById('popup-result').textContent"), "opened"));
    check("trusted click names the tab it opened", /opened: tabId=\d+ http:\/\/127\.0\.0\.1:\d+\/popup/.test(popupText), popupText.split("\n").slice(1).join(" | "));

    // Trusted keys: the page sees isTrusted, and the browser's own Tab handling moves focus.
    await mcp.callTool("press_key", { tabId, keys: "ArrowDown", selector: "#keys" });
    check("synthetic key is seen as synthetic", has(await read(tabId, "document.getElementById('key-result').textContent"), "synthetic"));
    console.log(await mcp.callTool("press_key", { tabId, keys: "ArrowDown", selector: "#keys", trusted: true }));
    check("trusted key is seen as trusted", has(await read(tabId, "document.getElementById('key-result').textContent"), "trusted"));
    await mcp.callTool("press_key", { tabId, keys: "Tab", trusted: true });
    check("trusted Tab moves focus", has(await read(tabId, "document.activeElement && document.activeElement.id"), "after-tab"));
    const quit = await mcp.callTool("press_key", { tabId, keys: "Cmd+Q", trusted: true }).then(() => "pressed", (e) => String(e.message));
    check("trusted Cmd+Q is refused", quit.includes("refused_combo"), quit.slice(0, 120));

    // Open shadow DOM: snapshot, find_by_text, click_by_uid and fill_by_uid reach inside.
    const snap2 = await mcp.callTool("take_snapshot", { tabId });
    const btnUid = snap2.split("\n").find((l) => l.includes("Shadow continue"))?.match(/#([\w_]+)/)?.[1];
    const acctUid = snap2.split("\n").find((l) => l.includes("Account name"))?.match(/#([\w_]+)/)?.[1];
    check("take_snapshot lists controls inside an open shadow root", !!btnUid && !!acctUid);
    if (btnUid) await mcp.callTool("click_by_uid", { tabId, uid: btnUid });
    check("click_by_uid reaches a shadow DOM button", has(await read(tabId, "document.getElementById('panel').shadowRoot.getElementById('shadow-out').textContent"), "clicked"));
    if (acctUid) await mcp.callTool("fill_by_uid", { tabId, uid: acctUid, value: "Acme" });
    check("fill_by_uid reaches a shadow DOM input", has(await read(tabId, "document.getElementById('panel').shadowRoot.getElementById('acct').value"), "Acme"));
    // find_by_text takes its own snapshot, which replaces the uids above, so it runs after them.
    const found = await mcp.callTool("find_by_text", { tabId, text: "Shadow continue" }).catch((e) => String(e.message));
    check("find_by_text finds shadow DOM text", found.includes("Shadow continue"), found.split("\n")[0]);
    await read(tabId, "(document.getElementById('panel').shadowRoot.getElementById('shadow-out').textContent = 'reset')");
    const viaCss = await mcp.callTool("click", { tabId, selector: "#shadow-btn" }).then(() => "ok", (e) => String(e.message));
    check("a plain css locator falls back into open shadow roots",
      viaCss === "ok" && has(await read(tabId, "document.getElementById('panel').shadowRoot.getElementById('shadow-out').textContent"), "clicked"), viaCss);

    // Refusal: an element that is not visible must not be clicked.
    const refused = await mcp.callTool("click", { tabId, selector: "#menu [role=option]", trusted: true, timeoutMs: 500 }).then(
      () => "clicked",
      (e) => String(e.message),
    );
    check("trusted click refuses a 0px element", refused.includes("Nothing was clicked"), refused.slice(0, 120));
  } finally {
    await closeFixtureTabs();
    mcpProc.kill();
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
