// Careful hosts (server/src/careful-hosts.ts): signed-in social sites whose terms ban automated
// access. Nothing is blocked; the agent gets the read-only rule the first time it touches such a
// site in a session, then a counted one-line reminder on every page load or scroll. These pin
// the matching, the once-then-remind cadence, the config file's replace-not-merge meaning, the
// fall-back on a malformed file, the off switch, and that the NavContext wrapper prepends it
// even with nav memory disabled.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CarefulHosts, DEFAULT_CAREFUL_DOMAINS, HEAVY_SESSION_THRESHOLD } from "../server/dist/careful-hosts.js";
import { NavContext } from "../server/dist/nav-memory.js";

const FULL = /^\[careful-site\] x\.com: this browser is signed in to the user's real account/;

test("first touch of a careful site gets the full rule, naming read-only, pace and the stop signals", () => {
  const c = new CarefulHosts(DEFAULT_CAREFUL_DOMAINS);
  const text = c.notice("open_url", "x.com");
  assert.match(text, FULL);
  assert.match(text, /Read only\. Never like, follow, reply, post/);
  assert.match(text, /no scroll loops/);
  assert.match(text, /rate limit, a captcha, "this request looks like it might be automated"/);
  assert.match(text, /Careful-site list: built-in defaults/);
});

test("after the first touch, reads stay quiet and loads/scrolls get a counted reminder", () => {
  const c = new CarefulHosts(["x.com"]);
  assert.match(c.notice("open_url", "x.com"), FULL);
  assert.equal(c.notice("get_page_text", "x.com"), null);
  assert.equal(c.notice("take_snapshot", "x.com"), null);
  assert.equal(
    c.notice("navigate_page", "x.com"),
    '[careful-site] 2 page loads, 0 scrolls on x.com this session. Read only, person\'s pace; stop at any rate-limit or "automated" warning.',
  );
  assert.match(c.notice("scroll", "x.com"), /2 page loads, 1 scroll on x\.com/);
});

test("past the heavy threshold the reminder says to finish and stop", () => {
  const c = new CarefulHosts(["x.com"]);
  for (let i = 0; i < HEAVY_SESSION_THRESHOLD; i++) c.notice("scroll", "x.com");
  assert.match(c.notice("scroll", "x.com"), /more than a person browses; finish with what you have and stop/);
});

test("subdomains match their registrable domain; www and case are ignored; other sites never match", () => {
  const c = new CarefulHosts(["x.com", "WWW.LinkedIn.com"]);
  assert.equal(c.match("mobile.x.com"), "x.com");
  assert.equal(c.match("www.linkedin.com"), "linkedin.com");
  assert.equal(c.match("X.COM"), "x.com");
  assert.equal(c.match("notx.com"), null);
  assert.equal(c.match("x.com.example.com"), null);
  assert.equal(c.match("example.com"), null);
});

test("an entry can scope to one subdomain without claiming the whole site", () => {
  const c = new CarefulHosts(["old.reddit.com"]);
  assert.equal(c.match("old.reddit.com"), "old.reddit.com");
  assert.equal(c.match("www.reddit.com"), null);
});

test("each careful site is counted on its own", () => {
  const c = new CarefulHosts(["x.com", "linkedin.com"]);
  c.notice("open_url", "x.com");
  assert.match(c.notice("open_url", "linkedin.com"), /^\[careful-site\] linkedin\.com: this browser/);
  assert.match(c.notice("open_url", "x.com"), /2 page loads, 0 scrolls on x\.com/);
});

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("the config file replaces the defaults, a missing one means defaults, a malformed one falls back loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "careful-"));
  const file = join(dir, "careful-hosts.json");

  withEnv({ ZEN_MCP_CAREFUL_HOSTS_FILE: file }, () => {
    const missing = CarefulHosts.load();
    assert.equal(missing.match("x.com"), "x.com");
    assert.equal(missing.source, "built-in defaults");

    writeFileSync(file, JSON.stringify({ domains: ["example.org"] }));
    const custom = CarefulHosts.load();
    assert.equal(custom.match("example.org"), "example.org");
    assert.equal(custom.match("x.com"), null, "the file replaces, it does not merge");
    assert.equal(custom.source, file);

    writeFileSync(file, '{"domains": "x.com"}');
    const logs = [];
    const bad = CarefulHosts.load((m) => logs.push(m));
    assert.equal(bad.match("x.com"), "x.com");
    assert.equal(logs.length, 1);
    assert.match(logs[0], /malformed/);
  });
});

test("ZEN_MCP_CAREFUL_HOSTS=0 turns it off", () => {
  withEnv({ ZEN_MCP_CAREFUL_HOSTS: "0" }, () => assert.equal(CarefulHosts.load(), null));
});

const unusedDaemon = { call() { throw new Error("nav memory is off; the daemon must not be called"); } };
const text = (t) => ({ content: [{ type: "text", text: t }] });

test("the wrapper prepends the rule with nav memory OFF, and leaves other sites untouched", async () => {
  const nav = new NavContext(unusedDaemon, false, "k".repeat(64), new CarefulHosts(["x.com"]));
  const open = nav.wrap("open_url", async () => text("opened tab 7"));
  const onX = await open({ url: "https://x.com/search?q=example" });
  assert.match(onX.content[0].text, FULL);
  assert.match(onX.content[0].text, /\n\nopened tab 7$/);

  const elsewhere = await open({ url: "https://example.com/" });
  assert.equal(elsewhere.content[0].text, "opened tab 7");

  const again = await open({ url: "https://x.com/home" });
  assert.match(again.content[0].text, /^\[careful-site\] 2 page loads, 0 scrolls on x\.com this session\./);
});

test("location-free tools and a wrapper with no careful list never add anything", async () => {
  const nav = new NavContext(unusedDaemon, false, "k".repeat(64), new CarefulHosts(["x.com"]));
  const listed = await nav.wrap("list_pages", async () => text("tabs"))({ url: "https://x.com/" });
  assert.equal(listed.content[0].text, "tabs");

  const plain = new NavContext(unusedDaemon, false, "k".repeat(64));
  const r = await plain.wrap("open_url", async () => text("ok"))({ url: "https://x.com/" });
  assert.equal(r.content[0].text, "ok");
});
