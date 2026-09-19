#!/usr/bin/env node
// What versions AMO has already signed, highest first. Run before bumping
// extension/src/manifest.json: AMO rejects a re-upload of any previously-signed version,
// including ones deleted locally, so the repo's manifest can lag behind what AMO has.
//
//   node scripts/amo-versions.mjs
//
// The unauthenticated endpoint that used to answer this now returns 401 for an UNLISTED
// add-on ("Authentication credentials were not provided"), so this signs a short-lived
// HS256 JWT from the same ~/.config/zen-mcp/.env credentials `extension/scripts/sign.sh`
// uses. Nothing is uploaded and nothing is written.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GECKO_ID = "zen-ext-mcp@cxrobx";

function credentials() {
  let { AMO_KEY: key, AMO_SECRET: secret } = process.env;
  if (key && secret) return { key, secret };
  const envFile = process.env.ZEN_EXT_ENV_FILE ?? join(homedir(), ".config", "zen-mcp", ".env");
  try {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?(AMO_KEY|AMO_SECRET)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (m[1] === "AMO_KEY") key = value;
      else secret = value;
    }
  } catch {
    // fall through to the error below - the file being absent is the same failure as it
    // being incomplete, and the fix is the same.
  }
  if (!key || !secret) {
    console.error(`error: AMO_KEY and AMO_SECRET are not set, and ${envFile} did not supply them.`);
    console.error("  get fresh keys at https://addons.mozilla.org/developers/addon/api/key/");
    process.exit(1);
  }
  return { key, secret };
}

const { key, secret } = credentials();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: "HS256", typ: "JWT" });
const body = b64({ iss: key, jti: String(Math.random()), iat: now, exp: now + 120 });
const jwt = `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;

const url = `https://addons.mozilla.org/api/v5/addons/addon/${GECKO_ID}/versions/?filter=all_with_unlisted`;
const response = await fetch(url, { headers: { Authorization: `JWT ${jwt}` } });
if (!response.ok) {
  console.error(`error: AMO returned HTTP ${response.status}`);
  console.error((await response.text()).slice(0, 300));
  process.exit(1);
}
const { results = [] } = await response.json();
const versions = results.map((v) => v.version);
if (versions.length === 0) {
  console.log("AMO has no signed versions on file for this add-on.");
  process.exit(0);
}
// AMO returns newest first; the first row is what to bump past.
console.log(versions.slice(0, 10).join("\n"));
console.error(`\nhighest signed: ${versions[0]} -> bump the manifest past it`);
