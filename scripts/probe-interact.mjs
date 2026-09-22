#!/usr/bin/env node
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const DEEP_OPEN = '<div class="deep-wrapper">'.repeat(40);
const DEEP_CLOSE = "</div>".repeat(40);

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>zen-ext-mcp interact fixture</title>
  <style>
    body { font: 14px/1.4 -apple-system, sans-serif; padding: 2rem; }
    .box { padding: 1rem; border: 1px solid #ccc; margin: 1rem 0; }
    button { padding: 0.5rem 1rem; }
    input { padding: 0.4rem; margin: 0.25rem 0; display: block; width: 240px; }
    #rich-editor { min-height: 3rem; padding: 0.5rem; border: 1px solid #aaa; }
    .spacer { height: 1400px; }
    [data-hovered="yes"] { background: lime; }
    #deep-btn { text-transform: uppercase; }
  </style>
</head>
<body>
  <h1>Fixture</h1>

  <div class="box">
    <h2>Inputs</h2>
    <input id="text-input" type="text" placeholder="enter text">
    <input id="email-input" type="email" placeholder="enter email">
    <textarea id="ta" rows="3" placeholder="textarea"></textarea>
    <div id="rich-editor" contenteditable="true" role="textbox" aria-label="Rich editor"></div>
  </div>

  <div class="box">
    <h2>Click</h2>
    <button id="click-btn" type="button">Click me</button>
    <div id="click-result">initial</div>
    <button id="pointer-btn" type="button">Pointer only</button>
    <div id="pointer-result">initial</div>
  </div>

  <div class="box">
    <h2>Hover</h2>
    <div id="hover-target">hover me</div>
  </div>

  <div class="box">
    <h2>Press handling</h2>
    <button id="menu-trigger" type="button">Menu</button>
    <div id="menu" hidden>menu open</div>
    <div id="menu-events">none</div>
    <button id="nofocus-btn" type="button">No focus</button>
    <a id="newtab-link" href="/newtab-target" target="_blank"><span id="newtab-span">New tab link</span></a>
    <a id="routed-link" href="/routed-target" target="_blank">Routed link</a>
    <a id="sametab-link" href="#same">Same tab link</a>
  </div>

  <div class="spacer"></div>
  <button id="below-fold" type="button">Below fold</button>
  <div id="below-result">initial</div>
  <div id="delayed-root"></div>
  <div id="deep-result">initial</div>
  ${DEEP_OPEN}
    <button id="deep-btn" type="button">Deep action</button>
  ${DEEP_CLOSE}

  <script>
    const btn = document.getElementById('click-btn');
    btn.addEventListener('click', () => {
      document.getElementById('click-result').textContent = 'clicked';
    });
    const hover = document.getElementById('hover-target');
    hover.addEventListener('mouseenter', () => {
      hover.dataset.hovered = 'yes';
    });
    const rich = document.getElementById('rich-editor');
    rich.addEventListener('beforeinput', (event) => {
      event.preventDefault();
      rich.dataset.beforeinput = 'yes';
      rich.textContent = event.data || '';
      rich.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: event.data || '',
        inputType: event.inputType || 'insertText'
      }));
    });
    let pointerArmed = false;
    const pointerBtn = document.getElementById('pointer-btn');
    pointerBtn.addEventListener('pointerdown', () => {
      pointerArmed = true;
    });
    pointerBtn.addEventListener('click', () => {
      if (pointerArmed) document.getElementById('pointer-result').textContent = 'pointer clicked';
      pointerArmed = false;
    });
    document.getElementById('below-fold').addEventListener('click', () => {
      document.getElementById('below-result').textContent = 'below clicked';
    });
    window.startDelayedRender = () => {
      setTimeout(() => {
        const btn = document.createElement('button');
        btn.id = 'delayed-btn';
        btn.type = 'button';
        btn.textContent = 'Delayed';
        btn.addEventListener('click', () => {
          btn.dataset.clicked = 'yes';
        });
        document.getElementById('delayed-root').appendChild(btn);
      }, 700);
    };
    document.getElementById('deep-btn').addEventListener('click', () => {
      document.getElementById('deep-result').textContent = 'deep clicked';
    });
    // Modelled on a menu trigger (Radix and friends): cancel the press so the trigger keeps
    // focus off itself, open the menu, and treat focus landing on the trigger as focus
    // leaving the menu - which dismisses it. A click that forces focus opens and closes it.
    const trigger = document.getElementById('menu-trigger');
    const menu = document.getElementById('menu');
    const seen = [];
    for (const type of ['pointerdown', 'mousedown', 'focus', 'pointerup', 'mouseup', 'click']) {
      trigger.addEventListener(type, () => {
        seen.push(type);
        document.getElementById('menu-events').textContent = seen.join(',');
      });
    }
    trigger.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      menu.hidden = false;
    });
    trigger.addEventListener('focus', () => {
      menu.hidden = true;
    });
    const noFocus = document.getElementById('nofocus-btn');
    noFocus.addEventListener('mousedown', (event) => event.preventDefault());
    noFocus.addEventListener('click', () => {
      noFocus.dataset.clicked = 'yes';
    });
    // A client-side router handles the click itself, so no tab opens.
    document.getElementById('routed-link').addEventListener('click', (event) => event.preventDefault());
  </script>
</body>
</html>`;

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

async function main() {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    // Inline scripts are allowed for the fixture setup, but dynamic compilation is
    // deliberately blocked. This reproduces admin.google.com's unsafe-eval failure.
    res.setHeader("content-security-policy", "script-src 'unsafe-inline'; object-src 'none'");
    res.end(FIXTURE_HTML);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const fixtureUrl = `http://127.0.0.1:${port}/fixture`;
  console.log(`fixture serving on ${fixtureUrl}`);

  const mcpProc = spawnLogged(
    "mcp",
    "node",
    [resolve(root, "server/dist/index.js"), "--port", "8766"],
    { env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" } },
  );
  await sleep(400);
  const mcp = new McpClient(mcpProc);

  await mcp.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe-interact", version: "0.0.1" },
  });
  mcp.notify("notifications/initialized");

  await step(`new_page -> ${fixtureUrl}`, async () => {
    console.log(await mcp.callTool("new_page", { url: fixtureUrl }));
  });
  await sleep(1500);

  const list = await mcp.callTool("list_pages");
  const line = list.split("\n").find((l) => l.includes(`127.0.0.1:${port}`));
  if (!line) throw new Error("could not find fixture tab");
  const idx = Number.parseInt(line.match(/\[(\d+)\]/)?.[1] ?? "-1", 10);
  console.log(`> using pageIdx=${idx}`);

  await mcp.callTool("select_page", { pageIdx: idx });
  await sleep(300);

  const snap = await step("take_snapshot", () => mcp.callTool("take_snapshot", { pageIdx: idx }));
  console.log(snap);

  const textUid = findUidForTagId(snap, "input", "enter text");
  const emailUid = findUidForTagId(snap, "input", "enter email");
  const taUid = findUidForTagId(snap, "textarea", "textarea");
  const btnUid = findUidForTagId(snap, "button", "Click me");
  const hoverUid = findUidForTagId(snap, "div", "hover me");

  if (!textUid || !btnUid || !hoverUid || !emailUid || !taUid) {
    throw new Error(
      `missing uids: text=${textUid} email=${emailUid} ta=${taUid} btn=${btnUid} hover=${hoverUid}`,
    );
  }
  console.log(`> uids: text=${textUid} email=${emailUid} ta=${taUid} btn=${btnUid} hover=${hoverUid}`);

  await step(`fill_by_uid text=${textUid} -> "hello"`, async () => {
    console.log(await mcp.callTool("fill_by_uid", { pageIdx: idx, uid: textUid, value: "hello" }));
  });
  const textValue = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return document.getElementById('text-input').value;",
  });
  console.log(`> text input value -> "${textValue}"`);
  if (textValue !== "hello") throw new Error(`expected "hello", got "${textValue}"`);

  await step("fill_form_by_uid (email + textarea)", async () => {
    console.log(
      await mcp.callTool("fill_form_by_uid", {
        pageIdx: idx,
        fields: [
          { uid: emailUid, value: "test@example.com" },
          { uid: taUid, value: "multi\nline" },
        ],
      }),
    );
  });
  const emailValue = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return document.getElementById('email-input').value;",
  });
  const taValue = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return document.getElementById('ta').value;",
  });
  console.log(`> email -> "${emailValue}", textarea -> ${JSON.stringify(taValue)}`);
  if (emailValue !== "test@example.com") throw new Error(`email mismatch: ${emailValue}`);
  if (taValue !== "multi\nline") throw new Error(`textarea mismatch: ${taValue}`);

  await step(`click_by_uid btn=${btnUid}`, async () => {
    console.log(await mcp.callTool("click_by_uid", { pageIdx: idx, uid: btnUid }));
  });
  const clickResult = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return document.getElementById('click-result').textContent;",
  });
  console.log(`> click-result -> "${clickResult}"`);
  if (clickResult !== "clicked") throw new Error(`expected "clicked", got "${clickResult}"`);
  // An uncancelled press still focuses the target.
  const clickFocus = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return document.activeElement ? document.activeElement.id : null;",
  });
  console.log(`> focused after plain click -> ${clickFocus}`);
  if (clickFocus !== "click-btn") throw new Error(`expected click-btn focused, got ${clickFocus}`);

  await step(`hover_by_uid hover=${hoverUid}`, async () => {
    console.log(await mcp.callTool("hover_by_uid", { pageIdx: idx, uid: hoverUid }));
  });
  const hoverData = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return document.getElementById('hover-target').dataset.hovered ?? null;",
  });
  console.log(`> hover-target dataset.hovered -> ${hoverData}`);
  if (hoverData !== "yes") throw new Error(`expected "yes", got ${hoverData}`);

  const richDocumentFocused = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return document.hasFocus();",
  });
  await step("fill contenteditable mini-editor", async () => {
    console.log(
      await mcp.callTool("fill", {
        pageIdx: idx,
        selector: "#rich-editor",
        value: "rich text sticks",
      }),
    );
  });
  const richState = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "var el=document.getElementById('rich-editor'); return {text: el.textContent, beforeinput: el.dataset.beforeinput || null};",
  });
  console.log(`> rich editor -> ${richState}`);
  if (!richState.includes("rich text sticks")) {
    throw new Error(`rich editor text did not stick: ${richState}`);
  }
  if (richDocumentFocused !== "true" && !richState.includes("yes")) {
    throw new Error(`background rich editor did not receive synthetic beforeinput: ${richState}`);
  }

  await step("pointer-event-only click by locator", async () => {
    console.log(await mcp.callTool("click", { pageIdx: idx, selector: "#pointer-btn" }));
  });
  const pointerResult = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return document.getElementById('pointer-result').textContent;",
  });
  console.log(`> pointer-result -> "${pointerResult}"`);
  if (pointerResult !== "pointer clicked") {
    throw new Error(`expected pointer click, got "${pointerResult}"`);
  }

  await step("auto-scroll below-fold target", async () => {
    console.log(await mcp.callTool("click", { pageIdx: idx, selector: "#below-fold" }));
  });
  const belowState = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return {result: document.getElementById('below-result').textContent, y: window.scrollY};",
  });
  console.log(`> below state -> ${belowState}`);
  if (!belowState.includes("below clicked")) throw new Error(`below-fold click failed: ${belowState}`);
  if (belowState.includes('"y": 0') || belowState.includes('"y":0')) {
    throw new Error(`expected page to scroll before below-fold click: ${belowState}`);
  }

  await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "window.startDelayedRender(); return true;",
  });
  await step("auto-wait delayed locator", async () => {
    console.log(
      await mcp.callTool("click", {
        pageIdx: idx,
        selector: "#delayed-btn",
        timeoutMs: 3000,
      }),
    );
  });
  const delayedClicked = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return document.getElementById('delayed-btn').dataset.clicked || null;",
  });
  console.log(`> delayed clicked -> ${delayedClicked}`);
  if (delayedClicked !== "yes") throw new Error(`delayed click failed: ${delayedClicked}`);

  const deepSnapshot = await step("snapshot reaches a 40-level-deep control", () =>
    mcp.callTool("take_snapshot", { pageIdx: idx, includeAll: true }),
  );
  const deepUid = findUidForTagId(deepSnapshot, "button", "Deep action");
  if (!deepUid) throw new Error("deep action button missing from snapshot");
  console.log(`> deep action uid=${deepUid}`);

  await step("rendered-text locator ignores CSS text-transform casing", async () => {
    console.log(
      await mcp.callTool("click", {
        pageIdx: idx,
        selector: "text:DEEP ACTION",
      }),
    );
  });
  const deepState = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "const el = document.getElementById('deep-result'); return el?.textContent ?? null;",
  });
  console.log(`> deep result -> ${deepState}`);
  if (deepState !== "deep clicked") throw new Error(`deep locator click failed: ${deepState}`);

  await step("cancelled pointerdown: no mouse events, no focus, menu stays open", async () => {
    console.log(await mcp.callTool("click", { pageIdx: idx, selector: "#menu-trigger" }));
  });
  const menuState = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "return {open: !document.getElementById('menu').hidden, events: document.getElementById('menu-events').textContent, focused: document.activeElement ? document.activeElement.id : null};",
  });
  console.log(`> menu state -> ${menuState}`);
  const menu = JSON.parse(menuState);
  if (menu.events !== "pointerdown,pointerup,click") {
    throw new Error(`expected pointerdown,pointerup,click only, got ${menu.events}`);
  }
  if (!menu.open) throw new Error(`menu closed after a cancelled press: ${menuState}`);
  if (menu.focused === "menu-trigger") throw new Error(`trigger took focus: ${menuState}`);

  await step("cancelled mousedown: click lands, focus does not move", async () => {
    console.log(await mcp.callTool("click", { pageIdx: idx, selector: "#nofocus-btn" }));
  });
  const noFocusState = await mcp.callTool("evaluate_script", {
    pageIdx: idx,
    code: "var b=document.getElementById('nofocus-btn'); return {clicked: b.dataset.clicked || null, focused: document.activeElement === b};",
  });
  console.log(`> no-focus state -> ${noFocusState}`);
  const noFocus = JSON.parse(noFocusState);
  if (noFocus.clicked !== "yes") throw new Error(`click did not land: ${noFocusState}`);
  if (noFocus.focused) throw new Error(`button focused despite a cancelled mousedown: ${noFocusState}`);

  const newTabText = await step("_blank link (clicked on a child span) names its URL", () =>
    mcp.callTool("click", { pageIdx: idx, selector: "#newtab-span" }),
  );
  console.log(newTabText);
  const expectedUrl = `http://127.0.0.1:${port}/newtab-target`;
  if (!newTabText.includes(`opens in a new tab: ${expectedUrl}`)) {
    throw new Error(`expected a new-tab note naming ${expectedUrl}`);
  }
  await sleep(800);
  // Not asserted: whether the popup blocker stopped it depends on this profile's settings.
  // Recorded, because "usually stopped" is the claim the note makes. Any tab it did open is closed.
  const opened = (await mcp.callTool("list_pages"))
    .split("\n")
    .filter((l) => l.includes(`127.0.0.1:${port}/newtab-target`));
  console.log(`> popup blocker ${opened.length ? "LET IT THROUGH" : "stopped it"}`);
  for (const l of opened) {
    const openedId = Number.parseInt(l.match(/tabId[=:]\s*(\d+)/)?.[1] ?? "", 10);
    if (Number.isFinite(openedId)) await mcp.callTool("close_page", { tabId: openedId });
  }

  for (const [selector, why] of [
    ["#routed-link", "a router cancelled the click"],
    ["#sametab-link", "no target"],
  ]) {
    const text = await step(`no new-tab note: ${why}`, () => mcp.callTool("click", { pageIdx: idx, selector }));
    console.log(text);
    if (text.includes("opens in a new tab")) throw new Error(`unexpected new-tab note for ${selector}`);
  }

  await mcp.callTool("close_page", { pageIdx: idx });

  console.log("\n[probe-interact] PASS");
  mcpProc.kill("SIGTERM");
  server.close();
  await sleep(200);
  process.exit(0);
}

main().catch((err) => {
  console.error("[probe-interact] FAIL:", err.message);
  process.exit(1);
});
