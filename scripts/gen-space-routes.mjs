#!/usr/bin/env node
/**
 * gen-space-routes.mjs — generate Zen's Space Routing rules from the zen-mcp
 * host route table, so a URL's SPACE and its CONTAINER are decided by one list.
 *
 * zen-mcp routes host -> container (~/.config/zen-mcp/containers.json). Zen routes
 * URL -> space (zen-space-routing.jsonlz4). Each space is bound to a container, so
 * the two agree exactly when every host's rule points at the space whose container
 * is the one zen-mcp routes that host to. This script derives that second table
 * from the first instead of asking anyone to keep them in step by hand.
 *
 * Space Routing is the mechanism to use rather than the
 * zen.workspaces.force-container-workspace pref, because
 * ZenSpaceRoutingManager.#routeToWorkspace gates the space SWITCH on
 * `!inBackground` — zen-mcp opens tabs in the background, so a tab is filed
 * without the browser following it. The pref has no such check and yanks focus
 * on every agent-opened tab.
 *
 * Dry run by default. Pass --write to actually write the file.
 *
 * Zen reads this file ONCE, in the ZenSpaceRoutingManager constructor, so a
 * restart is required for new rules to take effect. It also holds the parsed
 * routes in memory and saves them back when the Space Routing dialog is used,
 * so editing rules in the UI before restarting would overwrite what we wrote.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  resolveProfile,
  readSpaces,
  readContainers,
  readRoutingRules,
  readRouteTable,
  hostContainerMap,
  mozlz4Encode,
  mozlz4Decode,
  ROUTING_FILE,
} from "./lib/zen-profile.mjs";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (color ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (color ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (color ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);

const args = process.argv.slice(2);
const write = args.includes("--write");
const profileArg = args.find((a) => !a.startsWith("--"));
const profile = resolveProfile(profileArg);
const target = join(profile, ROUTING_FILE);

const spaces = readSpaces(profile);
const containers = readContainers(profile);
const table = readRouteTable();
const existing = readRoutingRules(profile);

const containerByName = new Map(containers.map((c) => [c.name, c]));
const spacesByContainer = new Map();
for (const s of spaces) {
  if (!s.containerId) continue;
  if (!spacesByContainer.has(s.containerId)) spacesByContainer.set(s.containerId, []);
  spacesByContainer.get(s.containerId).push(s);
}

console.log(bold("\nGenerate Zen Space Routing rules from the zen-mcp route table"));
console.log(dim(`profile: ${profile}`));
console.log(dim(`target:  ${ROUTING_FILE}${existing === null ? " (does not exist yet)" : ""}\n`));

const routes = [];
const skipped = [];
const hostWidth = Math.max(...[...hostContainerMap(table).keys()].map((h) => h.length), 4);

for (const [host, containerName] of hostContainerMap(table)) {
  const container = containerByName.get(containerName);
  if (!container) {
    skipped.push(`${host}: container "${containerName}" does not exist in Zen`);
    continue;
  }
  const bound = spacesByContainer.get(container.userContextId) ?? [];
  if (bound.length !== 1) {
    skipped.push(
      `${host}: container "${containerName}" is bound to ${bound.length} spaces — need exactly one to pick a target`
    );
    continue;
  }
  const space = bound[0];
  routes.push({ id: randomUUID(), reference: host, openIn: space.uuid, matchType: "contains" });
  console.log(`${host.padEnd(hostWidth)}  ${dim("→")}  ${green(space.name)} ${dim(`(container ${containerName})`)}`);
}

for (const s of skipped) console.log(`${yellow("skipped")} ${s}`);

if (!routes.length) {
  console.log(red("\nNothing to write."));
  process.exit(1);
}

// Preserve any rule already on disk whose host we are not regenerating, so a
// hand-added rule is not silently destroyed by a regenerate.
const generatedHosts = new Set(routes.map((r) => r.reference.toLowerCase()));
let preserved = 0;
if (Array.isArray(existing)) {
  for (const r of existing) {
    if (!generatedHosts.has(String(r.reference ?? "").toLowerCase())) {
      routes.push(r);
      preserved++;
    }
  }
}
if (preserved) console.log(dim(`\npreserved ${preserved} existing rule(s) for hosts not in the route table`));

const payload = JSON.stringify({ routes, defaultRouteExternal: "most-recent-space" });
const encoded = mozlz4Encode(payload);

// Prove the bytes we are about to write decode back to exactly what we meant.
const verify = JSON.parse(mozlz4Decode(encoded).toString("utf8"));
if (JSON.stringify(verify) !== payload) throw new Error("encode/decode round-trip mismatch — refusing to write");

console.log(`\n${routes.length} rule(s), ${encoded.length} bytes.`);

if (!write) {
  console.log(yellow("\nDry run. Re-run with --write to install, then restart Zen."));
  process.exit(0);
}

if (existsSync(target)) {
  const backup = `${target}.bak`;
  copyFileSync(target, backup);
  console.log(dim(`backed up existing file to ${backup}`));
}
writeFileSync(target, encoded);

// Read it back off disk through the normal read path.
const readBack = readRoutingRules(profile);
if (!Array.isArray(readBack) || readBack.length !== routes.length) {
  console.log(red("wrote the file but could not read it back — check it manually"));
  process.exit(1);
}
console.log(green(`\n✓ wrote ${routes.length} rules to ${ROUTING_FILE} and read them back.`));
console.log(
  bold("\nRestart Zen for these to take effect") +
    " — the routing manager reads this file once, in its constructor.\nDon't open Space Routing Settings before restarting: Zen would save its in-memory (empty) set over this file."
);
