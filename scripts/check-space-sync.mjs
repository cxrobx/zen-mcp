#!/usr/bin/env node
/**
 * check-space-sync.mjs — report drift between Zen Spaces, Zen containers, and
 * the zen-mcp host route table.
 *
 * Zen exposes no workspace id to WebExtensions, so zen-mcp can pick a tab's
 * CONTAINER but never its SPACE. Zen decides the space itself, by two
 * mechanisms this script inspects:
 *
 *   1. Space Routing rules (zen-space-routing.jsonlz4, Zen 1.21+) — THE ONE TO USE.
 *      URL pattern -> space, applied in ZenSpaceRoutingManager.#routeToWorkspace(),
 *      which moves the tab and gates the space SWITCH on `!inBackground`. zen-mcp
 *      opens in the background, so the tab is filed and focus never moves.
 *
 *   2. zen.workspaces.force-container-workspace — DO NOT ENABLE. It files the tab
 *      by container, but ZenSpaceManager.onTabBrowserInserted() then runs an
 *      unconditional `setTimeout(() => this.changeWorkspace(workspace), 0)` with no
 *      inBackground check, so every tab an agent opens yanks the browser to another
 *      space. Measured 2026-08-25 against live Zen 1.21.15b.
 *
 * So the invariant that keeps spaces and containers together is: every host in
 * containers.json has a Space Routing rule, and that rule points at a space whose
 * container is the one containers.json routes the host to.
 *
 * Read-only. Never writes to the Zen profile. Where things live on disk, and why
 * places.sqlite is not one of them, is documented in scripts/lib/zen-profile.mjs.
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

// ---------------------------------------------------------------------------

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

console.log(bold("\nZen spaces ↔ containers ↔ zen-mcp route table"));
console.log(dim(`profile: ${profile}`));
console.log(dim(`spaces:  zen-sessions.jsonlz4 (${spaces.length})\n`));

// 1. the master switch
console.log(`${PREF}: ${pref.value ? red("ON") : green("OFF")} ${dim(`(${pref.source})`)}`);
if (pref.pendingRestart) {
  console.log(
    `  ${yellow("pending restart")} — the running Zen loaded ${pref.running ? "ON" : "OFF"}; ${pref.source} says ${pref.value ? "ON" : "OFF"}.`
  );
  if (pref.running) {
    problems.push(
      `${PREF} is still ON in the running Zen (prefs.js) even though user.js sets it OFF — it keeps stealing focus until Zen restarts, or you flip it in about:config now.`
    );
  }
}
if (pref.value) {
  problems.push(
    `${PREF} is ON — it files tabs by container, but ZenSpaceManager.onTabBrowserInserted() follows every move with an unconditional changeWorkspace(), so each background tab an agent opens yanks the browser to another space. Turn it off and use Space Routing rules, which gate the switch on !inBackground.`
  );
}

// 2. space routing rules
if (rules === null) console.log(`space routing rules: ${dim("none configured")}`);
else if (rules.error) console.log(`space routing rules: ${red("unreadable")} ${dim(rules.error)}`);
else console.log(`space routing rules: ${rules.length ? green(String(rules.length)) : yellow("0")}`);
console.log();

// 3. every container needs exactly one space
const width = Math.max(...containers.map((c) => c.name.length), ...spaces.map((s) => s.name.length), 12);
console.log(bold(`${"container".padEnd(width)}  ${"space".padEnd(width)}  status`));
for (const c of containers) {
  const bound = spacesFor.get(c.userContextId) ?? [];
  let status;
  let spaceName;
  if (bound.length === 1) {
    spaceName = bound[0].name;
    status = green("ok");
  } else if (bound.length === 0) {
    spaceName = "—";
    status = red("no space bound to this container");
    problems.push(
      `container "${c.name}" has no space bound to it — tabs zen-mcp opens there can never be filed automatically.`
    );
  } else {
    spaceName = bound.map((b) => b.name).join(", ");
    status = red(`${bound.length} spaces share it — forcing is disabled for this container`);
    problems.push(
      `container "${c.name}" is bound to ${bound.length} spaces (${spaceName}); Zen only files a tab when exactly one space matches.`
    );
  }
  console.log(`${c.name.padEnd(width)}  ${spaceName.padEnd(width)}  ${status}`);
}

// 4. spaces pointing at a container that is gone or private
console.log();
for (const s of spaces.filter((s) => s.containerId && !byId.has(s.containerId))) {
  console.log(`${red("space")} "${s.name}" is bound to container id ${s.containerId}, which is not a public container.`);
  problems.push(
    `space "${s.name}" points at container id ${s.containerId} — not a public container (likely deleted). Rebind it in Edit Space → Profile.`
  );
}
for (const s of spaces.filter((s) => !s.containerId)) {
  console.log(`${yellow("space")} "${s.name}" has no container bound. ${dim("(fine if deliberate)")}`);
}

// 5. containers.json names a container Zen does not have
const knownNames = new Set(containers.map((c) => c.name));
for (const name of new Set([...Object.keys(table.containers), ...Object.keys(table.routes)])) {
  if (!knownNames.has(name)) {
    problems.push(
      `~/.config/zen-mcp/containers.json routes to container "${name}", which does not exist in Zen — those URLs error and open nothing.`
    );
  }
}

// 6. host coverage: every host zen-mcp routes needs a rule, pointing at a space
//    whose container is the one zen-mcp routes that host to.
const hostContainer = hostContainerMap(table);

if (hostContainer.size) {
  const ruleList = Array.isArray(rules) ? rules : [];
  const spaceByUuid = new Map(spaces.map((s) => [s.uuid, s]));
  const hostWidth = Math.max(...[...hostContainer.keys()].map((h) => h.length), 4);

  console.log();
  console.log(bold(`${"host".padEnd(hostWidth)}  ${"container".padEnd(width)}  routes to space`));
  for (const [host, mcpContainer] of hostContainer) {
    // Zen matches "contains" against the whole URL, so a rule covers a host when
    // its reference is a substring of that host (or matches it outright).
    const rule = ruleList.find((r) => {
      const ref = String(r.reference ?? "").toLowerCase();
      if (!ref) return false;
      return r.matchType === "regex" ? safeRegex(ref, host) : host.includes(ref) || ref.includes(host);
    });
    if (!rule) {
      console.log(`${host.padEnd(hostWidth)}  ${mcpContainer.padEnd(width)}  ${yellow("no rule — stays in the active space")}`);
      problems.push(
        `host "${host}" has no Space Routing rule, so a tab zen-mcp opens for it gets the right container but stays in whatever space is active.`
      );
      continue;
    }
    if (rule.openIn === "most-recent-space") {
      console.log(`${host.padEnd(hostWidth)}  ${mcpContainer.padEnd(width)}  ${yellow("rule set to \"most recent space\"")}`);
      problems.push(`host "${host}" has a rule, but it opens in "most recent space" — pick the space explicitly.`);
      continue;
    }
    const space = spaceByUuid.get(rule.openIn);
    if (!space) {
      console.log(`${host.padEnd(hostWidth)}  ${mcpContainer.padEnd(width)}  ${red("rule points at a deleted space")}`);
      problems.push(`space routing rule "${rule.reference}" points at a space that no longer exists.`);
      continue;
    }
    const spaceContainer = byId.get(space.containerId)?.name ?? "(none)";
    if (spaceContainer !== mcpContainer) {
      console.log(`${host.padEnd(hostWidth)}  ${mcpContainer.padEnd(width)}  ${red(`${space.name} (container ${spaceContainer})`)}`);
      problems.push(
        `host "${host}": zen-mcp routes it to container "${mcpContainer}", but the Zen rule sends it to space "${space.name}" whose container is "${spaceContainer}". The Zen rule wins, so the tab lands in the wrong pairing.`
      );
    } else {
      console.log(`${host.padEnd(hostWidth)}  ${mcpContainer.padEnd(width)}  ${green(space.name)}`);
    }
  }
}

function safeRegex(pattern, value) {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

console.log();
if (!problems.length) {
  console.log(green("✓ spaces and containers are in sync."));
  process.exit(0);
}
console.log(bold(red(`${problems.length} problem${problems.length === 1 ? "" : "s"}:`)));
for (const p of problems) console.log(`  • ${p}`);
console.log();
process.exit(1);
