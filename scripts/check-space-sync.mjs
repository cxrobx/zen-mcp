#!/usr/bin/env node
/**
 * check-space-sync.mjs — assert that each tab zen-mcp opens will land in the Zen space
 * bound to its container, without the user's view moving.
 *
 * Zen has two placement mechanisms, measured against live Zen (1.21.15b on 2026-08-25,
 * 1.22.1b on 2026-09-23):
 *
 *   1. zen.workspaces.force-container-workspace — files a tab by container, but
 *      ZenSpaceManager.onTabBrowserInserted follows every move with an unconditional
 *      `setTimeout(() => this.changeWorkspace(workspace), 0)`. No inBackground check,
 *      so every tab an agent opens yanks the user's browser to another space. MUST stay
 *      OFF.
 *
 *   2. Space Routing rules (zen-space-routing.jsonlz4) — URL-keyed, and they gate the
 *      space switch on `!inBackground`, which extension-opened tabs are. This is the one
 *      in use. They cannot see a tab's container, so zen-mcp opens each container tab at
 *      a marker (server/src/space-marker.ts) and one rule per container sends that marker
 *      to the container's space. The objection that reverted this on 2026-08-26 — a filed
 *      tab vanished from the extension API — was fixed by extension 0.0.18, which reaches
 *      tabs in other spaces by id.
 *
 * Checks: the pref is off; every container bound to exactly one space has its marker
 * rule, pointing at that space, and a marker URL's first matching rule is its own;
 * containers.json names only containers Zen has. Warns (does not fail) on user rules
 * that pull a host zen-mcp routes into a space other than its container's.
 *
 * Read-only. Never writes to the Zen profile; gen-space-markers.mjs writes the rules.
 */

import {
  resolveProfile,
  readSpaces,
  readContainers,
  readPref,
  readRoutingRules,
  readRouteTable,
  hostContainerMap,
  expectedMarkerRules,
  FORCE_PREF as PREF,
} from "./lib/zen-profile.mjs";
import { spaceMarkerReference, spaceMarkerUrl } from "../server/dist/space-marker.js";

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

console.log(bold("\nZen space placement — marker rules ON, container pref OFF"));
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

// Marker rules: what files each zen-mcp tab into its container's space.
const wanted = expectedMarkerRules(containers, spaces, spaceMarkerReference);
const spaceName = new Map(spaces.map((sp) => [sp.uuid, sp.name]));
const fix = "run `npm run spaces:markers -- --write`, then restart Zen";
if (rules === null) {
  console.log(`space routing rules: ${red("none")}`);
  problems.push(`no Space Routing file, so every zen-mcp tab lands in whatever space is active — ${fix}.`);
} else if (rules.error) {
  console.log(`space routing rules: ${red("unreadable")} ${dim(rules.error)}`);
  problems.push(`zen-space-routing.jsonlz4 exists but could not be read: ${rules.error}`);
} else {
  console.log(`space routing rules: ${rules.length}`);
  for (const w of wanted) {
    const url = spaceMarkerUrl(w.reference.slice("zen-space=".length, -1));
    // First match wins in Zen, so what matters is which rule a marker URL actually hits.
    const first = rules.find((r) => zenRuleMatches(url, r));
    if (!first) {
      console.log(`  ${red("✗")} ${w.container}: no marker rule`);
      problems.push(`no Space Routing rule for ${w.container}'s marker, so its tabs land in whatever space is active — ${fix}.`);
    } else if (first.openIn !== w.openIn) {
      const where = spaceName.get(first.openIn) ?? first.openIn;
      console.log(`  ${red("✗")} ${w.container}: marker goes to "${where}", not "${w.space}"`);
      problems.push(
        `${w.container}'s marker is caught by the rule "${first.reference}" (-> "${where}") instead of going to "${w.space}" — ${fix}, or remove that rule.`
      );
    } else {
      console.log(`  ${green("✓")} ${w.container} -> ${w.space}`);
    }
  }

  // A user rule on a host zen-mcp routes pulls the agent's tab (and the user's own
  // navigation) to that rule's space. Allowed, but worth seeing when it disagrees.
  const hostContainer = hostContainerMap(table);
  for (const rule of rules) {
    const ref = String(rule.reference ?? "").toLowerCase();
    if (!ref || ref.startsWith("zen-space") || rule.openIn === "most-recent-space") continue;
    const hit = [...hostContainer.entries()].find(([h]) => h.includes(ref) || ref.includes(h));
    if (!hit) continue;
    const [host, container] = hit;
    const ruleSpace = spaces.find((sp) => sp.uuid === rule.openIn);
    const owner = containers.find((c) => c.name === container);
    if (ruleSpace && owner && ruleSpace.containerId !== owner.userContextId) {
      console.log(
        `  ${yellow("!")} "${rule.reference}" sends ${host} to "${ruleSpace.name}", but zen-mcp routes it to ${container} ${dim("(a tab there ends up in the rule's space)")}`
      );
    }
  }
}

/** Zen's own matcher (ZenSpaceRoutingManager.isRouteMatching), for the three match types. */
function zenRuleMatches(uri, route) {
  const reference = String(route.reference ?? "");
  if (!reference.trim()) return false;
  switch (route.matchType) {
    case "contains":
      return uri.toLowerCase().includes(reference.toLowerCase());
    case "equal-to":
      return uri.toLowerCase().replace(/\/+$/, "") === reference.toLowerCase().replace(/\/+$/, "");
    case "regex":
      try {
        return new RegExp(reference).test(uri);
      } catch {
        return false;
      }
    default:
      return false;
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
for (const name of new Set([
  ...Object.keys(table.containers),
  ...Object.keys(table.routes),
  ...Object.keys(table.projects),
])) {
  if (!knownNames.has(name)) {
    problems.push(
      `~/.config/zen-mcp/containers.json routes to container "${name}", which does not exist in Zen — those URLs error and open nothing.`
    );
  }
}

console.log();
if (!problems.length) {
  console.log(green("✓ every container's tabs are filed into its space, and nothing switches your view."));
  process.exit(0);
}
console.log(bold(red(`${problems.length} problem${problems.length === 1 ? "" : "s"}:`)));
for (const p of problems) console.log(`  • ${p}`);
console.log();
process.exit(1);
