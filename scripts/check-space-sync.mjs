#!/usr/bin/env node
/**
 * check-space-sync.mjs — assert that neither Zen space-placement mechanism is
 * enabled, and that the container side of the route table still holds up.
 *
 * The obvious feature request is "make zen-mcp put its tabs in the matching Zen
 * space." Both of Zen's mechanisms for that were measured on 2026-08-25 against
 * live Zen 1.21.15b, and BOTH cost more than the tidiness is worth:
 *
 *   1. zen.workspaces.force-container-workspace — files the tab by container, but
 *      ZenSpaceManager.onTabBrowserInserted follows every move with an
 *      unconditional `setTimeout(() => this.changeWorkspace(workspace), 0)`. No
 *      inBackground check, so every tab an agent opens yanks the user's browser
 *      to another space.
 *
 *   2. Space Routing rules (zen-space-routing.jsonlz4) — these DO gate the space
 *      switch on `!inBackground`, so focus stays put. But the tab is still moved,
 *      and Zen scopes browser.tabs.query({}) to the ACTIVE space, so the tab
 *      vanishes from the WebExtension API the instant it is filed. Verified: an
 *      open_url tab came back NOT_FOUND to close_page one call later. Every
 *      subsequent tool — get_page_text, take_snapshot, click — fails the same way
 *      whenever the agent's project is not the space the user is sitting in.
 *
 * One mechanism moves the browser to the tab; the other moves the tab away from
 * the agent. There is no third option: the constraint is Zen scoping the tab API
 * to one space, which sits above the WebExtension layer. So the correct state is
 * BOTH OFF — tabs land in whatever space is active, which is untidy and entirely
 * reachable. This script exists to keep it that way.
 *
 * What it still checks positively: each container has exactly one space bound to
 * it (that binding is what makes the user's OWN new tabs land in the right jar),
 * and containers.json names only containers Zen actually has.
 *
 * Read-only. Never writes to the Zen profile.
 */

import {
  resolveProfile,
  readSpaces,
  readContainers,
  readPref,
  readRoutingRules,
  readRouteTable,
  hostContainerMap,
  FORCE_PREF as PREF,
} from "./lib/zen-profile.mjs";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (color ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (color ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (color ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);

const profile = resolveProfile(process.argv.slice(2).find((a) => !a.startsWith("--")));
const spaces = readSpaces(profile);
const containers = readContainers(profile);
const pref = readPref(profile);
const rules = readRoutingRules(profile);
const table = readRouteTable();

const problems = [];
const byId = new Map(containers.map((c) => [c.userContextId, c]));
const spacesFor = new Map();
for (const s of spaces) {
  if (!s.containerId) continue;
  if (!spacesFor.has(s.containerId)) spacesFor.set(s.containerId, []);
  spacesFor.get(s.containerId).push(s);
}

console.log(bold("\nZen space placement — both mechanisms should be OFF"));
console.log(dim(`profile: ${profile}`));
console.log(dim(`spaces:  zen-sessions.jsonlz4 (${spaces.length})\n`));

// Hazard 1: the pref steals focus.
console.log(`${PREF}: ${pref.value ? red("ON") : green("OFF")} ${dim(`(${pref.source})`)}`);
if (pref.pendingRestart) {
  console.log(
    `  ${yellow("pending restart")} — the running Zen loaded ${pref.running ? "ON" : "OFF"}; ${pref.source} says ${pref.value ? "ON" : "OFF"}.`
  );
}
if (pref.value || pref.running) {
  problems.push(
    `${PREF} is ON${pref.value !== pref.running ? " in the running Zen (prefs.js)" : ""} — ZenSpaceManager.onTabBrowserInserted calls changeWorkspace() unconditionally, so every background tab an agent opens yanks the browser to another space. Set it false in user.js, and flip it in about:config to stop it without a restart.`
  );
}

// Hazard 2: routing rules make agent-opened tabs unreachable.
const hostContainer = hostContainerMap(table);
if (rules === null) {
  console.log(`space routing rules: ${green("none")}`);
} else if (rules.error) {
  console.log(`space routing rules: ${red("unreadable")} ${dim(rules.error)}`);
  problems.push(`zen-space-routing.jsonlz4 exists but could not be read: ${rules.error}`);
} else {
  console.log(`space routing rules: ${rules.length ? red(String(rules.length)) : green("none")}`);
  for (const rule of rules) {
    const ref = String(rule.reference ?? "").toLowerCase();
    if (!ref || rule.openIn === "most-recent-space") continue;
    const hit = [...hostContainer.keys()].find((h) => h.includes(ref) || ref.includes(h));
    if (hit) {
      console.log(`  ${red("✗")} "${rule.reference}" covers ${hit}, which zen-mcp routes`);
      problems.push(
        `a Space Routing rule matches "${hit}" — zen-mcp routes that host, so a tab opened for it is filed into another space and becomes invisible to browser.tabs.query({}). Every tool call on it then fails NOT_FOUND unless that space happens to be active. Delete the rule in Space Routing Settings.`
      );
    } else {
      console.log(`  ${dim("·")} "${rule.reference}" — not a host zen-mcp routes ${dim("(fine)")}`);
    }
  }
}

// Container <-> space bindings: what makes the user's own new tabs land right.
console.log();
const width = Math.max(...containers.map((c) => c.name.length), ...spaces.map((s) => s.name.length), 12);
console.log(bold(`${"container".padEnd(width)}  ${"space".padEnd(width)}  status`));
for (const c of containers) {
  const bound = spacesFor.get(c.userContextId) ?? [];
  if (bound.length === 1) {
    console.log(`${c.name.padEnd(width)}  ${bound[0].name.padEnd(width)}  ${green("ok")}`);
  } else if (bound.length === 0) {
    console.log(`${c.name.padEnd(width)}  ${"—".padEnd(width)}  ${yellow("no space bound")}`);
  } else {
    const names = bound.map((b) => b.name).join(", ");
    console.log(`${c.name.padEnd(width)}  ${names.padEnd(width)}  ${yellow(`${bound.length} spaces share it`)}`);
  }
}

for (const s of spaces.filter((s) => s.containerId && !byId.has(s.containerId))) {
  console.log(
    `\n${yellow("space")} "${s.name}" is bound to container id ${s.containerId}, which is not a public container.`
  );
}

// containers.json must only name containers Zen has — a miss opens nothing.
const knownNames = new Set(containers.map((c) => c.name));
for (const name of new Set([...Object.keys(table.containers), ...Object.keys(table.routes)])) {
  if (!knownNames.has(name)) {
    problems.push(
      `~/.config/zen-mcp/containers.json routes to container "${name}", which does not exist in Zen — those URLs error and open nothing.`
    );
  }
}

console.log();
if (!problems.length) {
  console.log(green("✓ neither mechanism is on; MCP tabs stay reachable."));
  process.exit(0);
}
console.log(bold(red(`${problems.length} problem${problems.length === 1 ? "" : "s"}:`)));
for (const p of problems) console.log(`  • ${p}`);
console.log();
process.exit(1);
