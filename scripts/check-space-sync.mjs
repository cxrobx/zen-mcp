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
 * SPACES LIVE IN zen-sessions.jsonlz4, NOT IN places.sqlite. The zen_workspaces
 * table is a one-time migration source that ZenSessionManager reads once on the
 * first launch of Zen 1.21+ and then never writes again — it is a fossil frozen
 * at migration day, and reading it reports spaces that were deleted months ago
 * and misses every space created since. Don't "fix" a missing space by going
 * back to sqlite.
 *
 * Read-only. Never writes to the Zen profile.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const ZEN_ROOT = join(HOME, "Library", "Application Support", "zen");
const ROUTE_TABLE = join(HOME, ".config", "zen-mcp", "containers.json");
const PREF = "zen.workspaces.force-container-workspace";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (color ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (color ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (color ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);

/** Resolve the profile Zen actually runs. profiles.ini's `Default=1` can name a
 *  legacy profile, so prefer the Install sections and break ties by the
 *  freshest prefs.js. */
function resolveProfile(override) {
  if (override) return override;
  const ini = readFileSync(join(ZEN_ROOT, "profiles.ini"), "utf8");
  const candidates = [];
  for (const m of ini.matchAll(/^\[Install[^\]]*\][^[]*/gm)) {
    const d = m[0].match(/^Default=(.+)$/m);
    if (d) candidates.push(join(ZEN_ROOT, d[1].trim()));
  }
  if (!candidates.length) {
    for (const m of ini.matchAll(/^Path=(.+)$/gm)) candidates.push(join(ZEN_ROOT, m[1].trim()));
  }
  const live = candidates.filter((p) => existsSync(join(p, "prefs.js")));
  if (!live.length) throw new Error("no Zen profile with a prefs.js found");
  return live.map((p) => ({ p, mtime: statMtime(join(p, "prefs.js")) })).sort((a, b) => b.mtime - a.mtime)[0].p;
}

function statMtime(p) {
  try {
    return execFileSync("/usr/bin/stat", ["-f", "%m", p], { encoding: "utf8" }).trim() | 0;
  } catch {
    return 0;
  }
}

/** mozlz4 = "mozLz40\0" + uint32LE decompressed size + one LZ4 block. */
function mozlz4(buf) {
  if (buf.subarray(0, 8).toString("latin1") !== "mozLz40\0") throw new Error("not a mozlz4 file");
  const size = buf.readUInt32LE(8);
  const src = buf.subarray(12);
  const dst = Buffer.alloc(size);
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const token = src[i++];
    let litLen = token >> 4;
    if (litLen === 15) {
      let b;
      do {
        b = src[i++];
        litLen += b;
      } while (b === 255);
    }
    src.copy(dst, o, i, i + litLen);
    i += litLen;
    o += litLen;
    if (i >= src.length) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    let matchLen = token & 0xf;
    if (matchLen === 15) {
      let b;
      do {
        b = src[i++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4;
    for (let k = 0; k < matchLen; k++) dst[o + k] = dst[o - offset + k];
    o += matchLen;
  }
  return JSON.parse(dst.subarray(0, o).toString("utf8"));
}

/** The live space list. containerTabId 0 (or absent) means "no container". */
function readSpaces(profile) {
  const f = join(profile, "zen-sessions.jsonlz4");
  if (!existsSync(f)) {
    throw new Error(
      `${f} not found. Spaces live in that file as of Zen 1.21; the zen_workspaces table in places.sqlite is a frozen migration source and is NOT a substitute.`
    );
  }
  const spaces = mozlz4(readFileSync(f)).spaces ?? [];
  return spaces.map((s) => ({
    uuid: s.uuid,
    name: s.name,
    containerId: s.containerTabId || 0,
  }));
}

function readContainers(profile) {
  const f = join(profile, "containers.json");
  if (!existsSync(f)) return [];
  const data = JSON.parse(readFileSync(f, "utf8"));
  return (data.identities ?? [])
    .filter((i) => i.public)
    .map((i) => ({ userContextId: i.userContextId, name: i.name ?? l10nName(i.l10nId) }));
}

function l10nName(id) {
  const map = {
    "user-context-personal": "Personal",
    "user-context-work": "Work",
    "user-context-banking": "Banking",
    "user-context-shopping": "Shopping",
  };
  return map[id] ?? id ?? "(unnamed)";
}

function readPref(profile) {
  for (const file of ["user.js", "prefs.js"]) {
    const p = join(profile, file);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, "utf8").match(
      new RegExp(`^user_pref\\("${PREF.replace(/\./g, "\\.")}",\\s*(true|false)\\)`, "m")
    );
    if (m) return { value: m[1] === "true", source: file };
  }
  return { value: false, source: "default" };
}

function readRoutingRules(profile) {
  const f = join(profile, "zen-space-routing.jsonlz4");
  if (!existsSync(f)) return null;
  try {
    return mozlz4(readFileSync(f)).routes ?? [];
  } catch (e) {
    return { error: e.message };
  }
}

function readRouteTable() {
  if (!existsSync(ROUTE_TABLE)) return { containers: {}, routes: {}, consoles: [] };
  const raw = JSON.parse(readFileSync(ROUTE_TABLE, "utf8"));
  return { containers: raw.containers ?? {}, routes: raw.routes ?? {}, consoles: raw.consoles ?? [] };
}

// ---------------------------------------------------------------------------

const profile = resolveProfile(process.argv[2]);
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
if (pref.value) {
  problems.push(
    `${PREF} is ON — it files tabs by container, but ZenSpaceManager.onTabBrowserInserted() follows every move with an unconditional changeWorkspace(), so each background tab an agent opens yanks the browser to another space. Turn it off and use Space Routing rules, which gate the switch on !inBackground.`
  );
}

// 2. space routing rules
if (rules === null) console.log(`space routing rules: ${dim("none configured")}`);
else if (rules.error) console.log(`space routing rules: ${red("unreadable")} ${dim(rules.error)}`);
else console.log(`space routing rules: ${rules.length}`);
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
const hostContainer = new Map();
for (const [containerName, hosts] of Object.entries(table.containers))
  for (const h of hosts) hostContainer.set(h.toLowerCase(), containerName);
for (const [containerName, hosts] of Object.entries(table.routes))
  for (const h of hosts) hostContainer.set(h.toLowerCase(), containerName);

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
