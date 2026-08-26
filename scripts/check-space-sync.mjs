#!/usr/bin/env node
/**
 * check-space-sync.mjs — report drift between Zen Spaces, Zen containers, and
 * the zen-mcp host route table.
 *
 * Zen exposes no workspace id to WebExtensions, so zen-mcp can pick a tab's
 * CONTAINER but never its SPACE. Zen decides the space itself, by two
 * mechanisms this script inspects:
 *
 *   1. zen.workspaces.force-container-workspace (default OFF)
 *      When ON, a tab created with an explicit container is filed into the one
 *      space bound to that container — ZenSpaceManager.getContextIdIfNeeded().
 *      "One" is literal: the match is `matchingWorkspaces.length === 1`, so a
 *      container with zero spaces, or two, silently stops being filed.
 *
 *   2. Space Routing rules (zen-space-routing.jsonlz4, Zen 1.21+)
 *      URL pattern -> space. Applied in ZenSpaceRoutingManager.onAfterAddTab(),
 *      which runs AFTER the force logic and therefore outranks it.
 *
 * So the invariant that keeps spaces and containers together is: every
 * container zen-mcp routes to has exactly one space bound to it, and any Space
 * Routing rule agrees with the host's container in containers.json.
 *
 * Read-only. Copies the sqlite files before opening them, and never writes to
 * the Zen profile.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/** Resolve the profile Zen actually runs. profiles.ini's `Default=1` names a
 *  legacy profile here, so prefer the Install sections and break ties by the
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
  return live
    .map((p) => ({ p, mtime: statMtime(join(p, "prefs.js")) }))
    .sort((a, b) => b.mtime - a.mtime)[0].p;
}

function statMtime(p) {
  try {
    return execFileSync("/usr/bin/stat", ["-f", "%m", p], { encoding: "utf8" }).trim() | 0;
  } catch {
    return 0;
  }
}

/** Copy sqlite + its WAL to a scratch dir so an open read never touches the
 *  live file and still sees uncommitted WAL pages. */
function readWorkspaces(profile) {
  const db = join(profile, "places.sqlite");
  if (!existsSync(db)) return [];
  const scratch = mkdtempSync(join(tmpdir(), "zen-sync-"));
  try {
    copyFileSync(db, join(scratch, "places.sqlite"));
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(db + suffix)) copyFileSync(db + suffix, join(scratch, "places.sqlite" + suffix));
    }
    const out = execFileSync(
      "sqlite3",
      [
        join(scratch, "places.sqlite"),
        "select uuid, name, ifnull(container_id,-1), position from zen_workspaces order by position;",
      ],
      { encoding: "utf8" }
    );
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [uuid, name, containerId, position] = line.split("|");
        return { uuid, name, containerId: Number(containerId), position: Number(position) };
      });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readContainers(profile) {
  const f = join(profile, "containers.json");
  if (!existsSync(f)) return [];
  const data = JSON.parse(readFileSync(f, "utf8"));
  return (data.identities ?? [])
    .filter((i) => i.public)
    .map((i) => ({
      userContextId: i.userContextId,
      name: i.name ?? l10nName(i.l10nId),
    }));
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
const workspaces = readWorkspaces(profile);
const containers = readContainers(profile);
const pref = readPref(profile);
const rules = readRoutingRules(profile);
const table = readRouteTable();

const problems = [];
const byId = new Map(containers.map((c) => [c.userContextId, c]));
const spacesFor = new Map();
for (const w of workspaces) {
  if (w.containerId < 0) continue;
  if (!spacesFor.has(w.containerId)) spacesFor.set(w.containerId, []);
  spacesFor.get(w.containerId).push(w);
}

console.log(bold("\nZen spaces ↔ containers ↔ zen-mcp route table"));
console.log(dim(`profile: ${profile}\n`));

// 1. the master switch
const prefLine = pref.value ? green("ON") : red("OFF");
console.log(`${PREF}: ${prefLine} ${dim(`(${pref.source})`)}`);
if (!pref.value) {
  problems.push(
    `${PREF} is OFF — a tab zen-mcp opens in a container is filed into whatever space is active at that moment, not the space that owns the container.`
  );
}

// 2. space routing rules
if (rules === null) {
  console.log(`space routing rules: ${dim("none configured")}`);
} else if (rules.error) {
  console.log(`space routing rules: ${red("unreadable")} ${dim(rules.error)}`);
} else {
  console.log(`space routing rules: ${rules.length}`);
}
console.log();

// 3. every container needs exactly one space
const width = Math.max(...containers.map((c) => c.name.length), 12);
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
const orphaned = workspaces.filter((w) => w.containerId >= 0 && !byId.has(w.containerId));
const unbound = workspaces.filter((w) => w.containerId < 0);
for (const w of orphaned) {
  console.log(
    `${red("space")} "${w.name}" is bound to container id ${w.containerId}, which is not a public container.`
  );
  problems.push(
    `space "${w.name}" points at container id ${w.containerId} — not a public container (likely a deleted or internal one). Rebind it in the space's settings.`
  );
}
for (const w of unbound) {
  console.log(`${yellow("space")} "${w.name}" has no container bound. ${dim("(fine if deliberate)")}`);
}

// 5. containers.json names a container Zen does not have
const named = new Set([...Object.keys(table.containers), ...Object.keys(table.routes)]);
const knownNames = new Set(containers.map((c) => c.name));
for (const name of named) {
  if (!knownNames.has(name)) {
    problems.push(
      `~/.config/zen-mcp/containers.json routes to container "${name}", which does not exist in Zen — those URLs error and open nothing.`
    );
  }
}

// 6. a routing rule that contradicts the route table's container for that host
if (Array.isArray(rules) && rules.length) {
  const hostContainer = new Map();
  for (const [containerName, hosts] of Object.entries(table.containers))
    for (const h of hosts) hostContainer.set(h.toLowerCase(), containerName);
  for (const [containerName, hosts] of Object.entries(table.routes))
    for (const h of hosts) hostContainer.set(h.toLowerCase(), containerName);

  const spaceByUuid = new Map(workspaces.map((w) => [w.uuid, w]));
  for (const rule of rules) {
    if (rule.openIn === "most-recent-space") continue;
    const space = spaceByUuid.get(rule.openIn);
    if (!space) {
      problems.push(`space routing rule "${rule.reference}" points at a space that no longer exists.`);
      continue;
    }
    const mcpContainer = hostContainer.get(String(rule.reference).toLowerCase());
    if (!mcpContainer) continue;
    const spaceContainer = byId.get(space.containerId)?.name ?? "(none)";
    if (spaceContainer !== mcpContainer) {
      problems.push(
        `host "${rule.reference}": zen-mcp routes it to container "${mcpContainer}", but the Zen rule sends it to space "${space.name}" whose container is "${spaceContainer}". The Zen rule wins, so the tab lands in the wrong pairing.`
      );
    }
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
