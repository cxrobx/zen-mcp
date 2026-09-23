/**
 * Helpers for the live Zen profile, used by check-space-sync.mjs and gen-space-markers.mjs.
 * Nothing here writes to the profile; gen-space-markers.mjs is the one writer, and only
 * of the Space Routing file.
 *
 * SPACES LIVE IN zen-sessions.jsonlz4, NOT IN places.sqlite. The zen_workspaces
 * table is a one-time migration source ZenSessionManager reads once on the first
 * launch of Zen 1.21+ and never writes again — a fossil frozen at migration day
 * that still lists deleted spaces and misses every space created since.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
export const ZEN_ROOT = join(HOME, "Library", "Application Support", "zen");
export const ROUTE_TABLE = join(HOME, ".config", "zen-mcp", "containers.json");
export const FORCE_PREF = "zen.workspaces.force-container-workspace";
export const ROUTING_FILE = "zen-space-routing.jsonlz4";

/** Resolve the profile Zen actually runs. profiles.ini's `Default=1` can name a
 *  legacy profile, so prefer the Install sections and break ties by the freshest
 *  prefs.js. */
export function resolveProfile(override) {
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
  return live.map((p) => ({ p, mtime: mtime(join(p, "prefs.js")) })).sort((a, b) => b.mtime - a.mtime)[0].p;
}

function mtime(p) {
  try {
    return execFileSync("/usr/bin/stat", ["-f", "%m", p], { encoding: "utf8" }).trim() | 0;
  } catch {
    return 0;
  }
}

const MAGIC = "mozLz40\0";

/** mozlz4 = "mozLz40\0" + uint32LE decompressed size + one LZ4 block. */
export function mozlz4Decode(buf) {
  if (buf.subarray(0, 8).toString("latin1") !== MAGIC) throw new Error("not a mozlz4 file");
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
  return dst.subarray(0, o);
}

/**
 * Literal-only LZ4 block: one sequence carrying the whole payload, no matches. Valid LZ4
 * (the final sequence is always literals-only) and plenty at these sizes; Zen's decoder
 * read files written this way on 2026-08-25. Callers verify the round trip before writing.
 */
export function mozlz4Encode(payload) {
  const raw = Buffer.from(payload, "utf8");
  const parts = [];
  if (raw.length < 15) {
    parts.push(Buffer.from([raw.length << 4]));
  } else {
    parts.push(Buffer.from([0xf0]));
    let rem = raw.length - 15;
    const ext = [];
    while (rem >= 255) {
      ext.push(255);
      rem -= 255;
    }
    ext.push(rem);
    parts.push(Buffer.from(ext));
  }
  parts.push(raw);
  const header = Buffer.alloc(12);
  header.write(MAGIC, 0, "latin1");
  header.writeUInt32LE(raw.length, 8);
  return Buffer.concat([header, ...parts]);
}

/**
 * The Space Routing rule each container needs so a tab zen-mcp opens in it lands in its
 * space (server/src/space-marker.ts). Only a container bound to exactly one space gets one:
 * with none there is nowhere to send it, and with two Zen would have to guess.
 */
export function expectedMarkerRules(containers, spaces, spaceMarkerReference) {
  const rules = [];
  for (const c of containers) {
    const bound = spaces.filter((s) => s.containerId === c.userContextId);
    if (bound.length !== 1) continue;
    rules.push({
      container: c.name,
      space: bound[0].name,
      reference: spaceMarkerReference(`firefox-container-${c.userContextId}`),
      openIn: bound[0].uuid,
      matchType: "contains",
    });
  }
  return rules;
}

/** The live space list. containerTabId 0 (or absent) means "no container". */
export function readSpaces(profile) {
  const f = join(profile, "zen-sessions.jsonlz4");
  if (!existsSync(f)) {
    throw new Error(
      `${f} not found. Spaces live in that file as of Zen 1.21; the zen_workspaces table in places.sqlite is a frozen migration source and is NOT a substitute.`
    );
  }
  const spaces = JSON.parse(mozlz4Decode(readFileSync(f)).toString("utf8")).spaces ?? [];
  return spaces.map((s) => ({ uuid: s.uuid, name: s.name, containerId: s.containerTabId || 0 }));
}

export function readContainers(profile) {
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

/**
 * user.js is the value on next start; prefs.js is what the running Zen loaded.
 * When they disagree a restart is pending, which is worth saying out loud —
 * editing user.js alone changes nothing about the browser running right now.
 */
export function readPref(profile) {
  const read = (file) => {
    const p = join(profile, file);
    if (!existsSync(p)) return undefined;
    const m = readFileSync(p, "utf8").match(
      new RegExp(`^user_pref\\("${FORCE_PREF.replace(/\./g, "\\.")}",\\s*(true|false)\\)`, "m")
    );
    return m ? m[1] === "true" : undefined;
  };
  const declared = read("user.js");
  const running = read("prefs.js");
  const value = declared ?? running ?? false;
  return {
    value,
    source: declared !== undefined ? "user.js" : running !== undefined ? "prefs.js" : "default",
    running: running ?? false,
    pendingRestart: running !== undefined && declared !== undefined && running !== declared,
  };
}

/** The whole routing file ({routes, defaultRouteExternal}), or null when there is none. */
export function readRoutingFile(profile) {
  const f = join(profile, ROUTING_FILE);
  if (!existsSync(f)) return null;
  return JSON.parse(mozlz4Decode(readFileSync(f)).toString("utf8"));
}

/** null when no rules file exists; {error} when it is unreadable. */
export function readRoutingRules(profile) {
  const f = join(profile, ROUTING_FILE);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(mozlz4Decode(readFileSync(f)).toString("utf8")).routes ?? [];
  } catch (e) {
    return { error: e.message };
  }
}

export function readRouteTable() {
  if (!existsSync(ROUTE_TABLE)) return { containers: {}, routes: {}, consoles: [], projects: {} };
  const raw = JSON.parse(readFileSync(ROUTE_TABLE, "utf8"));
  return {
    containers: raw.containers ?? {},
    routes: raw.routes ?? {},
    consoles: raw.consoles ?? [],
    projects: raw.projects ?? {},
  };
}

/** host -> container name, flattening the route table's identity and residence tiers. */
export function hostContainerMap(table) {
  const map = new Map();
  for (const [containerName, def] of Object.entries(table.containers))
    for (const h of hostList(def)) map.set(h.toLowerCase(), containerName);
  for (const [containerName, hosts] of Object.entries(table.routes))
    for (const h of hostList(hosts)) map.set(h.toLowerCase(), containerName);
  return map;
}

/** A container entry is `"a.com"`, `["a.com"]`, or `{domains, aliases}` (routes.ts compileContainerDefs); aliases are console tokens, not hosts. */
function hostList(def) {
  if (typeof def === "string") return [def];
  if (Array.isArray(def)) return def;
  const domains = def?.domains ?? [];
  return typeof domains === "string" ? [domains] : domains;
}
