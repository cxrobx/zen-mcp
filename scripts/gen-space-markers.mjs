#!/usr/bin/env node
/**
 * gen-space-markers.mjs — write the Zen Space Routing rules that file each tab zen-mcp
 * opens into the space bound to its container.
 *
 * The server opens a container tab at about:blank#zen-space=<cookieStoreId>; first and
 * only then loads the real URL (server/src/space-marker.ts). One "contains" rule per
 * container matches that marker and names the container's space. Zen routes an
 * extension-opened tab in the background, so the tab is filed without the user's view
 * moving; foreground opens take the user to it. Nothing the user does produces a marker,
 * so their own browsing is untouched.
 *
 * Rules come from the container <-> space binding in the live profile (each space's
 * containerTabId). A container with no bound space, or two, gets no rule: check:spaces
 * reports that. Rules whose reference starts with "zen-space" are this script's and are
 * regenerated; every other rule in the file is kept as the user left it.
 *
 * Dry run by default. --write backs the file up, writes, and reads it back.
 *
 * Zen reads this file once, at startup, so restart Zen after writing. It also saves its
 * in-memory rules over the file when the Space Routing dialog closes, so don't open that
 * dialog between writing and restarting.
 */

import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  expectedMarkerRules,
  mozlz4Decode,
  mozlz4Encode,
  readContainers,
  readRoutingFile,
  readSpaces,
  resolveProfile,
  ROUTING_FILE,
} from "./lib/zen-profile.mjs";
import { SPACE_MARKER_NAMESPACE, spaceMarkerReference } from "../server/dist/space-marker.js";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const red = (s) => (color ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (color ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (color ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s) => (color ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (color ? `\x1b[1m${s}\x1b[0m` : s);

const args = process.argv.slice(2);
const write = args.includes("--write");
const profile = resolveProfile(args.find((a) => !a.startsWith("--")));
const target = join(profile, ROUTING_FILE);

const containers = readContainers(profile);
const spaces = readSpaces(profile);
const wanted = expectedMarkerRules(containers, spaces, spaceMarkerReference);

console.log(bold("Space Routing marker rules"));
console.log(dim(`profile: ${profile}\n`));
for (const r of wanted) console.log(`  ${r.container.padEnd(18)} -> ${r.space.padEnd(18)} ${dim(r.reference)}`);
const unplaced = containers.filter((c) => !wanted.some((r) => r.container === c.name));
for (const c of unplaced) {
  console.log(`  ${c.name.padEnd(18)} -> ${yellow("no rule")} ${dim("(no single space bound to it)")}`);
}

let existing = null;
try {
  existing = readRoutingFile(profile);
} catch (e) {
  console.log(red(`\n${ROUTING_FILE} exists but could not be read (${e.message}) — refusing to overwrite it.`));
  process.exit(1);
}
const ours = (r) => String(r.reference ?? "").toLowerCase().startsWith(SPACE_MARKER_NAMESPACE);
const kept = (existing?.routes ?? []).filter((r) => !ours(r));
const dropped = (existing?.routes ?? []).filter(ours);
if (kept.length) console.log(dim(`\nkeeping ${kept.length} rule(s) not made by this script`));
for (const r of dropped) {
  if (!wanted.some((w) => w.reference === r.reference && w.openIn === r.openIn)) {
    console.log(dim(`replacing "${r.reference}"`));
  }
}

// Markers first: first match wins, and a marker URL should never reach a user's rule.
const routes = [
  ...wanted.map((r) => ({ id: randomUUID(), reference: r.reference, openIn: r.openIn, matchType: r.matchType })),
  ...kept,
];
const payload = JSON.stringify({
  ...(existing ?? {}),
  routes,
  defaultRouteExternal: existing?.defaultRouteExternal ?? "most-recent-space",
});
const encoded = mozlz4Encode(payload);
if (mozlz4Decode(encoded).toString("utf8") !== payload) {
  throw new Error("encode/decode round trip mismatch — refusing to write");
}

if (!write) {
  console.log(yellow(`\nDry run: ${routes.length} rule(s). Re-run with --write, then restart Zen.`));
  process.exit(0);
}

if (existsSync(target)) {
  const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(target, backup);
  console.log(dim(`\nbacked up the existing file to ${backup}`));
}
writeFileSync(target, encoded);
const back = readRoutingFile(profile);
if (JSON.stringify(back) !== payload) {
  console.log(red("wrote the file but it does not read back identically — check it before restarting"));
  process.exit(1);
}
console.log(green(`\n✓ wrote ${routes.length} rule(s) to ${ROUTING_FILE} and read them back.`));
console.log(
  bold("\nRestart Zen for them to take effect") +
    " — it reads this file once, at startup.\nDon't open Space Routing Settings before restarting: closing it saves Zen's old rules over this file."
);
