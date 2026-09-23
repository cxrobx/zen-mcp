#!/usr/bin/env node
/**
 * probe-space-marker.mjs — live check that a tab zen-mcp opens in a container lands in the
 * Zen space bound to that container, and that the user's view does not move.
 *
 * Needs the marker rules installed (npm run spaces:markers -- --write, then a Zen restart)
 * and the user sitting in a space OTHER than the target container's. Opens one background
 * example.com tab through the real server, then reports:
 *   - where Zen filed it (zen-sessions.jsonlz4 records each tab's space),
 *   - whether the visible tab set and the active tab are unchanged,
 *   - whether the tools still reach it by tabId, and whether the marker left history.
 * With --active it also opens one FOREGROUND tab, confirms Zen switched to the target
 * space, and switches back by reselecting the tab that was active before (or, when Zen has
 * discarded that - it drops an empty new-tab page you leave - any tab visible then). That
 * moves your view twice; it is opt-in for that reason.
 *
 *   node scripts/probe-space-marker.mjs [--container CXVentures] [--active]
 *
 * Every tab it opens is closed, pass or fail. Nav memory is off.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedMarkerRules,
  mozlz4Decode,
  readContainers,
  readSpaces,
  resolveProfile,
} from "./lib/zen-profile.mjs";
import { spaceMarkerReference } from "../server/dist/space-marker.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const target = arg("--container", "CXVentures");
const withActive = args.includes("--active");

const profile = resolveProfile();
const spaces = readSpaces(profile);
const spaceName = new Map(spaces.map((s) => [s.uuid, s.name]));
const rule = expectedMarkerRules(readContainers(profile), spaces, spaceMarkerReference).find((r) => r.container === target);
if (!rule) {
  console.error(`${target} has no single space bound to it, so there is nowhere to file its tabs.`);
  process.exit(2);
}

const child = spawn("node", [join(root, "server/dist/index.js"), "--port", "8766", "--container", "Personal"], {
  cwd: "/",
  stdio: ["pipe", "pipe", "ignore"],
  env: { ...process.env, ZEN_MCP_NAV_MEMORY: "0" },
});
let buf = "";
let nextId = 1;
const pending = new Map();
child.stdout.on("data", (c) => {
  buf += c;
  const lines = buf.split("\n");
  buf = lines.pop();
  for (const l of lines) {
    if (!l.trim()) continue;
    const m = JSON.parse(l);
    if (pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  }
});
const rpc = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const tool = async (name, a = {}) => {
  const r = await rpc("tools/call", { name, arguments: a });
  return { isError: !!r.result?.isError, text: r.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(r.error) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function visible() {
  const { text } = await tool("list_pages");
  const rows = text.split("\n").filter((l) => /^\s*\*?\s*\[\d+\] tabId=/.test(l));
  const activeRow = rows.find((l) => l.trim().startsWith("*")) ?? "";
  return {
    ids: rows.map((l) => Number(/tabId=(\d+)/.exec(l)[1])),
    active: Number(/tabId=(\d+)/.exec(activeRow)?.[1] ?? -1),
    urls: rows.map((l) => l.split(" ").find((w) => w.startsWith("http"))).filter(Boolean),
  };
}

/**
 * The space you are in, by majority over the visible tabs' recorded spaces. The active tab
 * alone is not enough: right after a restart it is often Zen's empty new-tab page, which
 * has no URL to look up and which Zen discards when you leave the space.
 */
function currentSpace(urls) {
  const d = JSON.parse(mozlz4Decode(readFileSync(join(profile, "zen-sessions.jsonlz4"))).toString("utf8"));
  const votes = new Map();
  for (const t of d.tabs ?? []) {
    if (t.pinned || t.zenEssential) continue;
    const entry = t.entries?.[(t.index ?? 1) - 1] ?? t.entries?.at(-1);
    if (!entry?.url || !urls.includes(entry.url)) continue;
    const name = spaceName.get(t.zenWorkspace) ?? t.zenWorkspace;
    votes.set(name, (votes.get(name) ?? 0) + 1);
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** The space Zen's session file records for the tab whose current URL contains needle. */
async function spaceOf(needle, after = 0, timeoutMs = 45000) {
  const f = join(profile, "zen-sessions.jsonlz4");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (statSync(f).mtimeMs > after) {
      const d = JSON.parse(mozlz4Decode(readFileSync(f)).toString("utf8"));
      for (const t of d.tabs ?? []) {
        const entry = t.entries?.[(t.index ?? 1) - 1] ?? t.entries?.at(-1);
        if (entry?.url?.includes(needle)) return spaceName.get(t.zenWorkspace) ?? t.zenWorkspace;
      }
    }
    if (Date.now() > deadline) return null;
    await sleep(1500);
  }
}

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};
const opened = [];

await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe-space-marker", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

try {
  const before = await visible();
  const youAreIn = currentSpace(before.urls);
  console.log(`you are in: ${youAreIn ?? "unknown"} · target: ${target} -> space "${rule.space}"`);
  if (youAreIn === rule.space) {
    console.error(`You are in "${rule.space}" already, so a tab landing there proves nothing. Switch spaces and re-run.`);
    process.exitCode = 2;
  } else {
    console.log("\nbackground open:");
    const t0 = Date.now();
    const url = `https://example.com/?zen-mcp-space-probe=bg-${t0}`;
    const r = await tool("new_page_in_container", { name: target, url });
    if (r.isError) throw new Error(r.text);
    const tabId = Number(/tabId=(\d+)/.exec(r.text)[1]);
    opened.push(tabId);
    await sleep(2500);
    const mid = await visible();
    check(!mid.ids.includes(tabId), "the tab is not in the space you are looking at");
    check(mid.active === before.active && mid.ids.join() === before.ids.join(), "your visible tabs and active tab are unchanged");
    const read = await tool("get_page_text", { tabId });
    check(!read.isError && read.text.includes("Example Domain"), "get_page_text reaches it by tabId");
    const hist = await tool("evaluate_script", { tabId, code: "return history.length;" });
    check(hist.text.trim() === "1", `the marker left no history entry (history.length ${hist.text.trim()})`);
    const where = await spaceOf(`bg-${t0}`, t0);
    check(where === rule.space, `Zen filed it in "${where ?? "not saved yet"}" (expected "${rule.space}")`);

    if (withActive) {
      console.log("\nforeground open (moves your view, then puts it back):");
      const u2 = `https://example.com/?zen-mcp-space-probe=fg-${Date.now()}`;
      const r2 = await tool("new_page_in_container", { name: target, url: u2, active: true });
      if (r2.isError) throw new Error(r2.text);
      const fgId = Number(/tabId=(\d+)/.exec(r2.text)[1]);
      opened.push(fgId);
      await sleep(2000);
      const there = await visible();
      check(there.ids.includes(fgId) && there.active === fgId, "Zen switched you to the tab's space and selected it");
      // Back to where you were: the tab you had in front if it still exists, else any tab
      // that was visible then (Zen discards an empty new-tab page when you leave its space).
      let restored = null;
      for (const id of [before.active, ...before.ids.filter((id) => id !== before.active)]) {
        const sel = await tool("select_page", { tabId: id });
        if (!sel.isError) {
          restored = id;
          break;
        }
        if (id === before.active) console.log(`    (your previous tab ${id} is gone: ${sel.text.split("\n")[0]})`);
      }
      await sleep(1500);
      const back = await visible();
      check(restored !== null && back.ids.includes(restored), `switched you back to the space you were in (via tabId ${restored})`);
    }
  }
} catch (err) {
  failures.push(String(err.message ?? err));
  console.error(`error: ${err.message ?? err}`);
} finally {
  for (const tabId of opened) await tool("close_page", { tabId });
  if (opened.length) console.log(`\nclosed ${opened.length} probe tab(s)`);
  child.kill();
}
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exitCode = 1;
} else if (process.exitCode !== 2) {
  console.log("\nall checks passed");
}
