import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  matchesPathGlob,
  normalizeUrl,
  redactText,
  registrableDomain,
  sanitizeLocator,
} from "../shared/dist/nav-redact.js";
import { rankNotes, scoreNote } from "../daemon/dist/nav-memory/ranking.js";
import { encodeEmbedding } from "../daemon/dist/nav-memory/embeddings.js";
import { JsonNavStore } from "../daemon/dist/nav-memory/store.js";
import { NavMemoryService } from "../daemon/dist/nav-memory/service.js";
import { NavContext } from "../server/dist/nav-memory.js";
import { verifyFeedback } from "../server/dist/nav-feedback.js";
import { pageFingerprint } from "../server/dist/nav-identity.js";
import { mergeCompatible } from "../daemon/dist/nav-memory/merge.js";
import { runInNewContext } from "node:vm";

const offlineEmbedder = (dimension = 3) => ({
  model: "fake",
  dimension,
  async isAvailable() { return false; },
  async embedDocuments() { return []; },
  async embedQuery() { return new Float32Array([1, 0, 0]); },
  status() { return { available: false, lastCheckedAt: null }; },
});

function fixtureNote(overrides) {
  const stamp = "2025-05-01T00:00:00.000Z";
  return {
    id: "a".repeat(64),
    host: "dupe.example",
    registrableDomain: "dupe.example",
    pathGlob: null,
    kind: "selector",
    summary: "A fixture note.",
    detail: "A fixture detail.",
    example: null,
    tools: [],
    success: true,
    confidence: 0.5,
    reinforced: 1,
    createdAt: stamp,
    lastSeenAt: stamp,
    source: null,
    embedding: null,
    ...overrides,
  };
}

function vector(values) {
  return encodeEmbedding(Float32Array.from(values));
}

function fixtureEvent(clock, overrides = {}) {
  return { ts: clock.getTime(), tool: "fill", host: "example.com", path: "/form", ok: true, ...overrides };
}

test("normalization redacts identifiers and isolates private suffix tenants", () => {
  const value = normalizeUrl("https://User:pass@example.com/x");
  assert.equal(value, null);
  const normalized = normalizeUrl("https://Example.com/users/secret%40example.com/123456?token=bad#frag");
  assert.deepEqual(normalized, { host: "example.com", path: "/users/*/*", registrableDomain: "example.com" });
  assert.equal(registrableDomain("one.vercel.app"), "one.vercel.app");
  assert.equal(registrableDomain("two.vercel.app"), "two.vercel.app");
  assert.equal(registrableDomain("console.cloud.google.com"), "google.com");
  assert.equal(redactText("secret@example.com AKIA1234567890ABCDEF"), "<email> <aws-key>");
  assert.equal(sanitizeLocator('input[value="secret@example.com"][name="email"]'), 'input[value="*"][name="email"]');
});

test("path scoping and ranking exclude nonmatching scoped notes", () => {
  assert.equal(matchesPathGlob("/auth/clients/abc", "/auth/clients/*"), true);
  assert.equal(matchesPathGlob("/billing", "/auth/clients/*"), false);
  const now = new Date().toISOString();
  const base = {
    kind: "workflow",
    detail: "detail",
    example: null,
    tools: [],
    success: true,
    confidence: 0.8,
    reinforced: 1,
    createdAt: now,
    lastSeenAt: now,
    source: null,
    embedding: null,
    registrableDomain: "google.com",
  };
  const notes = [
    { ...base, id: "exact", host: "console.cloud.google.com", pathGlob: null, summary: "exact" },
    { ...base, id: "scoped", host: "console.cloud.google.com", pathGlob: "/auth/clients/*", summary: "scoped" },
    { ...base, id: "related", host: "accounts.google.com", pathGlob: null, summary: "related", reinforced: 16 },
  ];
  assert.deepEqual(rankNotes(notes, { host: "console.cloud.google.com", registrableDomain: "google.com", path: "/billing" }, 10).map((n) => n.id), ["exact", "related"]);
});

test("actionable kinds outrank workflow/timing notes at equal standing", () => {
  const now = new Date().toISOString();
  const base = {
    host: "app.example",
    registrableDomain: "app.example",
    pathGlob: null,
    detail: "detail",
    example: null,
    tools: [],
    success: true,
    confidence: 0.6,
    reinforced: 1,
    createdAt: now,
    lastSeenAt: now,
    source: null,
    embedding: null,
  };
  const notes = [
    { ...base, id: "cadence", kind: "timing", summary: "Calls happen at intervals." },
    { ...base, id: "toolTip", kind: "tool-tip", summary: "get_page_text fails here; evaluate_script works." },
    { ...base, id: "flow", kind: "workflow", summary: "Activity occurs on the root path." },
  ];
  const ranked = rankNotes(notes, { host: "app.example", registrableDomain: "app.example" }, 10).map((n) => n.id);
  assert.equal(ranked[0], "toolTip");
});

test("store permissions, ETL idempotency, and durable seed suppression", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-store-test-"));
  const distiller = {
    async distill() {
      return [{ kind: "selector", summary: "The form exposes a stable selector.", detail: "The email input uses its name attribute.", tools: ["fill"], success: true, confidence: 0.6 }];
    },
  };
  const embedder = {
    model: "fake",
    dimension: 3,
    async isAvailable() { return false; },
    async embedDocuments() { return []; },
    async embedQuery() { return new Float32Array([1, 0, 0]); },
    status() { return { available: false, lastCheckedAt: null }; },
  };
  try {
    const store = new JsonNavStore(dir);
    const service = new NavMemoryService(store, distiller, embedder);
    await service.init();
    assert.equal(store.noteCount(), 6);
    assert.equal((await stat(join(dir, "notes.json"))).mode & 0o777, 0o600);
    await service.handleRequest({ connId: "c1", containerScope: "Personal" }, "navMemory.recordEvents", {
      events: [{ ts: Date.now(), tool: "fill", host: "example.com", path: "/form", ok: true, locator: "css:input[name=email]" }],
    });
    await service.onSessionEnd("c1");
    process.env.ZEN_MCP_NAV_ETL_PROBE = "1";
    const first = await service.handleRequest({ connId: "probe", containerScope: null }, "navMemory.etlNow", {});
    assert.equal(first.status, "processed");
    const learned = store.allNotes().find((note) => note.host === "example.com");
    assert.ok(learned);
    assert.equal((await store.applyEtlBatch(first.workId, [{ note: learned }])).changed, 0);
    assert.equal(store.allNotes().find((note) => note.id === learned.id).reinforced, 1);
    const seedId = store.allNotes().find((note) => note.source?.seed)?.id;
    await store.forget({ id: seedId });
    await service.stop();

    const reopened = new JsonNavStore(dir);
    const service2 = new NavMemoryService(reopened, distiller, embedder);
    await service2.init();
    assert.equal(reopened.allNotes().some((note) => note.id === seedId), false);
    await service2.stop();
    assert.equal((await readFile(join(dir, "notes.json"), "utf8")).includes("secret@example.com"), false);
  } finally {
    delete process.env.ZEN_MCP_NAV_ETL_PROBE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("server injection deduplicates shown notes and capture excludes entered values", async () => {
  const calls = [];
  const daemon = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "navMemory.query") {
        return { host: "example.com", registrableDomain: "example.com", total: 1, notes: [{ id: "n", host: "example.com", pathGlob: null, kind: "selector", summary: "The form has a stable selector.", confidence: 0.7, reinforced: 1 }] };
      }
      return { accepted: params.events.length, dropped: 0 };
    },
  };
  const nav = new NavContext(daemon, true);
  nav.observePages([{ tabId: 1, windowId: 1, index: 0, url: "https://example.com/form", title: "", active: true, cookieStoreId: "x", containerName: null }]);
  const wrapped = nav.wrap("fill", async () => ({ content: [{ type: "text", text: "filled" }] }));
  const one = await wrapped({ pageIdx: 0, selector: "css:input[name=email]", value: "secret@example.com" });
  const two = await wrapped({ pageIdx: 0, selector: "css:input[name=email]", value: "another@example.com" });
  assert.match(one.content[0].text, /^\[nav-memory\]/);
  assert.equal(two.content[0].text, "filled");
  await new Promise((resolve) => setImmediate(resolve));
  const records = calls.filter((call) => call.method === "navMemory.recordEvents");
  assert.equal(JSON.stringify(records).includes("secret@example.com"), false);
  assert.equal(JSON.stringify(records).includes("another@example.com"), false);
});

test("dev hosts are never captured, queried, or injected by the server", async () => {
  const calls = [];
  const daemon = {
    async call(method, params) {
      calls.push({ method, params });
      return { accepted: 0, dropped: 0 };
    },
  };
  const nav = new NavContext(daemon, true);
  nav.observePages([{ tabId: 1, windowId: 1, index: 0, url: "http://localhost:3000/landing", title: "", active: true, cookieStoreId: "x", containerName: null }]);
  const wrapped = nav.wrap("get_page_text", async () => ({ content: [{ type: "text", text: "body" }] }));
  const response = await wrapped({ tabId: 1 });
  assert.equal(response.content[0].text, "body");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
});

test("daemon drops dev-host events even from servers that predate the check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-devhost-test-"));
  const distiller = { async distill() { return []; } };
  try {
    const store = new JsonNavStore(dir);
    const service = new NavMemoryService(store, distiller, offlineEmbedder());
    await service.init();
    const result = await service.handleRequest({ connId: "c1", containerScope: null }, "navMemory.recordEvents", {
      events: [
        { ts: Date.now(), tool: "fill", host: "localhost", path: "/x", ok: true },
        { ts: Date.now(), tool: "fill", host: "127.0.0.1", path: "/x", ok: true },
        { ts: Date.now(), tool: "fill", host: "app.local", path: "/x", ok: true },
        { ts: Date.now(), tool: "fill", host: "example.com", path: "/x", ok: true },
      ],
    });
    assert.equal(result.accepted, 1);
    assert.equal(result.dropped, 3);
    await service.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("query failures remain retryable and the kill switch is inert", async () => {
  let queries = 0;
  const daemon = {
    async call(method, params) {
      if (method === "navMemory.query") {
        queries += 1;
        if (queries === 1) throw new Error("transient");
        return { host: "example.com", registrableDomain: "example.com", total: 1, notes: [{ id: "n", host: "example.com", pathGlob: null, kind: "timing", summary: "The page settles after navigation.", confidence: 0.6, reinforced: 1 }] };
      }
      return { accepted: params.events.length, dropped: 0 };
    },
  };
  const nav = new NavContext(daemon, true);
  const wrapped = nav.wrap("navigate_page", async () => ({ content: [{ type: "text", text: "done" }] }));
  assert.equal((await wrapped({ url: "https://example.com/" })).content[0].text, "done");
  assert.match((await wrapped({ url: "https://example.com/" })).content[0].text, /^\[nav-memory\]/);
  assert.equal(queries, 2);

  const disabled = new NavContext({ async call() { throw new Error("must not call"); } }, false);
  const plain = await disabled.wrap("navigate_page", async () => ({ content: [{ type: "text", text: "plain" }] }))({ url: "https://example.com/" });
  assert.equal(plain.content[0].text, "plain");
});

test("failed ETL reaches quarantine and decay uses elapsed time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-failure-test-"));
  let clock = new Date("2025-01-01T00:00:00.000Z");
  const distiller = { async distill() { throw new Error("fixture failure"); } };
  const embedder = {
    model: "fake",
    dimension: 3,
    async isAvailable() { return false; },
    async embedDocuments() { return []; },
    async embedQuery() { return new Float32Array([1, 0, 0]); },
    status() { return { available: false, lastCheckedAt: null }; },
  };
  try {
    const store = new JsonNavStore(dir);
    const service = new NavMemoryService(store, distiller, embedder, () => new Date(clock));
    await service.init();
    await service.tick();
    await service.handleRequest({ connId: "c", containerScope: null }, "navMemory.recordEvents", {
      events: [{ ts: clock.getTime(), tool: "click", host: "example.com", path: "/", ok: false, errorCode: "TIMEOUT" }],
    });
    await service.onSessionEnd("c");
    process.env.ZEN_MCP_NAV_ETL_PROBE = "1";
    for (let i = 0; i < 3; i++) await service.handleRequest({ connId: "probe", containerScope: null }, "navMemory.etlNow", {});
    assert.equal((await store.counts()).failed, 1);
    const before = store.allNotes()[0].confidence;
    clock = new Date("2025-03-12T00:00:00.000Z");
    await service.tick();
    assert.ok(store.allNotes()[0].confidence < before);
    await service.stop();
  } finally {
    delete process.env.ZEN_MCP_NAV_ETL_PROBE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("distiller reinforcement merges into the referenced note and rejects bad indexes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-reinforce-test-"));
  const original = "The fixture form exposes a stable email locator.";
  const seen = [];
  let mode = "create";
  const body = (summary, extra = {}) => ({
    kind: "selector",
    summary,
    detail: "The input is reachable through its structural name attribute.",
    tools: ["fill"],
    success: true,
    confidence: 0.6,
    ...extra,
  });
  const distiller = {
    async distill(session, existing) {
      seen.push(existing);
      if (mode === "create") return [body(original)];
      if (mode === "reinforce") {
        const index = existing.findIndex((note) => note.summary === original);
        return [body("A rephrasing of the same locator fact.", { reinforces: index + 1 })];
      }
      return [body("An unrelated observation about redirects.", { reinforces: 99 })];
    },
  };
  const clock = new Date("2025-06-01T00:00:00.000Z");
  try {
    const store = new JsonNavStore(dir);
    const service = new NavMemoryService(store, distiller, offlineEmbedder(), () => clock);
    await service.init();
    process.env.ZEN_MCP_NAV_ETL_PROBE = "1";
    const run = async (connId) => {
      await service.handleRequest({ connId, containerScope: null }, "navMemory.recordEvents", { events: [fixtureEvent(clock)] });
      await service.onSessionEnd(connId);
      return service.handleRequest({ connId: "probe", containerScope: null }, "navMemory.etlNow", {});
    };

    await run("c1");
    const learned = store.allNotes().filter((note) => note.host === "example.com");
    assert.equal(learned.length, 1);
    assert.equal(learned[0].reinforced, 1);
    assert.deepEqual(seen[0], []);

    mode = "reinforce";
    await run("c2");
    const afterReinforce = store.allNotes().filter((note) => note.host === "example.com");
    assert.equal(afterReinforce.length, 1, "reinforcement must not create a second note");
    assert.equal(afterReinforce[0].id, learned[0].id);
    assert.equal(afterReinforce[0].reinforced, 2);
    assert.equal(seen[1].length, 1, "the distiller must be shown the host's known notes");
    assert.equal(seen[1][0].summary, original);

    mode = "invalid";
    await run("c3");
    const afterInvalid = store.allNotes().filter((note) => note.host === "example.com");
    assert.equal(afterInvalid.length, 2, "an out-of-range reinforces must fall back to a new note");
    assert.equal(afterInvalid.find((note) => note.id === learned[0].id).reinforced, 2);
    assert.ok(store.getMeta().etlCreated >= 2 && store.getMeta().etlMerged >= 1);
    assert.ok(store.getMeta().lastEtlAt);
    await service.stop();
  } finally {
    delete process.env.ZEN_MCP_NAV_ETL_PROBE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("consolidation sweep merges near-duplicates hourly and never deletes a seed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-consolidate-test-"));
  let clock = new Date("2025-06-01T00:00:00.000Z");
  const distiller = { async distill() { return []; } };
  try {
    const store = new JsonNavStore(dir);
    const service = new NavMemoryService(store, distiller, offlineEmbedder(), () => new Date(clock));
    await service.init();
    await store.updateNotes([
      fixtureNote({ id: "a".repeat(64), summary: "Original phrasing.", confidence: 0.6, reinforced: 1, createdAt: "2025-01-01T00:00:00.000Z", embedding: vector([1, 0, 0]) }),
      fixtureNote({ id: "b".repeat(64), summary: "Reinvented phrasing.", confidence: 0.5, reinforced: 3, createdAt: "2025-04-01T00:00:00.000Z", lastSeenAt: "2025-05-20T00:00:00.000Z", tools: ["click"], embedding: vector([0.9, 0.43589, 0]) }),
      fixtureNote({ id: "c".repeat(64), summary: "A genuinely different fact.", embedding: vector([0, 1, 0]) }),
      fixtureNote({ id: "d".repeat(64), host: "seeded.example", registrableDomain: "seeded.example", summary: "Seeded knowledge.", confidence: 0.3, source: { seed: true, seedVersion: 1 }, embedding: vector([1, 0, 0]) }),
      fixtureNote({ id: "e".repeat(64), host: "seeded.example", registrableDomain: "seeded.example", summary: "Learned restatement.", confidence: 0.6, reinforced: 2, embedding: vector([1, 0, 0]) }),
    ]);

    await service.tick();
    const kept = store.allNotes().find((note) => note.id === "a".repeat(64));
    assert.ok(kept, "the higher-confidence note is the merge target");
    assert.equal(store.allNotes().some((note) => note.id === "b".repeat(64)), false);
    assert.equal(kept.reinforced, 4, "reinforced counts are summed");
    assert.equal(kept.createdAt, "2025-01-01T00:00:00.000Z", "the earliest createdAt survives");
    assert.equal(kept.lastSeenAt, "2025-05-20T00:00:00.000Z", "the latest lastSeenAt survives");
    assert.deepEqual(kept.tools, ["click"]);
    assert.ok(store.allNotes().some((note) => note.id === "c".repeat(64)), "a below-threshold pair is untouched");
    const seed = store.allNotes().find((note) => note.id === "d".repeat(64));
    assert.ok(seed?.source?.seed, "a seed is a merge target, never a deleted source");
    assert.equal(seed.reinforced, 3);
    assert.equal(seed.confidence, 0.6);
    assert.equal(store.allNotes().some((note) => note.id === "e".repeat(64)), false);
    assert.equal(store.getMeta().consolidated, 2);

    clock = new Date(clock.getTime() + 30 * 60_000);
    await store.updateNotes([
      fixtureNote({ id: "1".repeat(64), host: "later.example", summary: "Fresh pair one.", embedding: vector([0, 0, 1]) }),
      fixtureNote({ id: "2".repeat(64), host: "later.example", summary: "Fresh pair two.", embedding: vector([0, 0, 1]) }),
    ]);
    await service.tick();
    assert.equal(store.allNotes().filter((note) => note.host === "later.example").length, 2, "the sweep is throttled to hourly");

    clock = new Date(clock.getTime() + 31 * 60_000);
    await service.tick();
    assert.equal(store.allNotes().filter((note) => note.host === "later.example").length, 1);
    assert.equal(store.getMeta().consolidated, 3);
    assert.ok(store.getMeta().lastConsolidateAt);
    await service.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idle sessions checkpoint to disk and high-water flushes before events drop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-checkpoint-test-"));
  let clock = new Date("2025-06-01T00:00:00.000Z");
  const distiller = { async distill() { return []; } };
  try {
    const store = new JsonNavStore(dir);
    const service = new NavMemoryService(store, distiller, offlineEmbedder(), () => new Date(clock));
    await service.init();
    await service.handleRequest({ connId: "idle", containerScope: null }, "navMemory.recordEvents", { events: [fixtureEvent(clock)] });
    assert.equal((await store.counts()).pending, 0, "an active session stays in memory");

    clock = new Date(clock.getTime() + 11 * 60_000);
    await service.tick();
    assert.equal((await store.counts()).done, 1, "the idle session was flushed and consumed");

    await service.onSessionEnd("idle");
    assert.equal((await store.counts()).pending, 0, "the checkpointed session state was reset");
    await service.handleRequest({ connId: "idle", containerScope: null }, "navMemory.recordEvents", { events: [fixtureEvent(clock)] });
    await service.onSessionEnd("idle");
    assert.equal((await store.counts()).pending, 1, "the next event starts a fresh session");

    let dropped = 0;
    for (let batch = 0; batch < 8; batch++) {
      const events = Array.from({ length: 50 }, () => fixtureEvent(clock, { host: "high-water.example" }));
      const result = await service.handleRequest({ connId: "busy", containerScope: null }, "navMemory.recordEvents", { events });
      dropped += result.dropped;
    }
    assert.equal(dropped, 0, "the high-water flush happens before the shift-drop cap");
    const files = (await readdir(join(dir, "sessions", "pending"))).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 2);
    const sizes = await Promise.all(files.map(async (name) => {
      const parsed = JSON.parse(await readFile(join(dir, "sessions", "pending", name), "utf8"));
      return parsed.events.length;
    }));
    assert.ok(sizes.includes(400), "the flushed session kept every event it accepted");
    await service.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("consumed work is archived, retention-capped, and purged by forget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-done-test-"));
  try {
    const store = new JsonNavStore(dir);
    await store.init();
    const session = (host) => ({
      schemaVersion: 1,
      workId: `work-${host}`,
      host,
      registrableDomain: host,
      container: null,
      startedAt: "2025-06-01T00:00:00.000Z",
      endedAt: "2025-06-01T00:01:00.000Z",
      attempts: 0,
      events: [{ ts: Date.now(), tool: "click", host, path: "/", ok: true }],
    });
    await store.saveSessionLogs([session("archived.example")]);
    const claimed = await store.claimOldest();
    await store.completeWork(claimed.filename);
    let counts = await store.counts();
    assert.equal(counts.processing, 0);
    assert.equal(counts.done, 1, "consumed work is archived instead of deleted");
    const archived = JSON.parse(await readFile(join(dir, "sessions", "done", claimed.filename), "utf8"));
    assert.equal(archived.events[0].tool, "click");

    const forgotten = await store.forget({ host: "archived.example", includeRaw: true });
    assert.equal(forgotten.done, 1);
    assert.equal((await store.counts()).done, 0);

    await store.saveSessionLogs([session("stale.example")]);
    const second = await store.claimOldest();
    await store.completeWork(second.filename);
    const stale = join(dir, "sessions", "done", second.filename);
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    await utimes(stale, old, old);
    await store.prune(Date.now());
    counts = await store.counts();
    assert.equal(counts.done, 0, "the done archive honours the 30-day TTL");
    assert.ok(store.getMeta().pruned >= 1);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt stores are preserved with restrictive permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nav-corrupt-test-"));
  try {
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "notes.json"), "not-json", { mode: 0o600 });
    const store = new JsonNavStore(dir);
    await store.init();
    const backup = (await readdir(dir)).find((name) => name.startsWith("notes.json.corrupt-"));
    assert.ok(backup);
    assert.equal((await stat(join(dir, backup))).mode & 0o777, 0o600);
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("path changes retrieve new scoped hints without repeating shown notes or exceeding the budget", async () => {
  const queries = [];
  const general = fixtureNote({ id: '1'.repeat(64), host: 'example.com', summary: 'General hint.' });
  const billing = fixtureNote({ id: '2'.repeat(64), host: 'example.com', pathGlob: '/billing', summary: 'Billing hint.' });
  const daemon = { async call(method, params) {
    if (method === 'navMemory.query') {
      queries.push(params);
      const notes = [general, ...(params.path === '/billing' ? [billing] : [])].filter(n => !params.excludeIds.includes(n.id));
      return { host: params.host, total: notes.length, notes };
    }
    return { accepted: params.events.length, dropped: 0 };
  } };
  const nav = new NavContext(daemon, true);
  const read = nav.wrap('navigate_page', async () => ({ content: [{ type: 'text', text: 'read' }] }));
  assert.match((await read({ url: 'https://example.com/' })).content[0].text, /General hint/);
  const next = (await read({ url: 'https://example.com/billing?token=private' })).content[0].text;
  assert.match(next, /Billing hint/);
  assert.doesNotMatch(next, /General hint/);
  assert.match(next, new RegExp(billing.id));
  assert.ok(Buffer.byteLength(next.split('\n\nread')[0]) <= 1536);
  assert.equal((await read({ url: 'https://example.com/billing' })).content[0].text, 'read');
  assert.equal((await read({ url: 'https://example.com/' })).content[0].text, 'read');
  assert.deepEqual(queries.map(q => q.path), ['/', '/billing']);
  assert.deepEqual(queries[1].excludeIds, [general.id]);

  const emptyNav = new NavContext({ ...daemon, async call(method, params) {
    if (method === 'navMemory.query' && params.path === '/') return { host: params.host, total: 0, notes: [] };
    return daemon.call(method, params);
  } }, true);
  const initiallyEmpty = emptyNav.wrap('navigate_page', async () => ({ content: [{ type: 'text', text: 'read' }] }));
  assert.equal((await initiallyEmpty({ url: 'https://example.com/' })).content[0].text, 'read');
  assert.match((await initiallyEmpty({ url: 'https://example.com/billing' })).content[0].text, /Billing hint/);
});

test("concurrent page reads share a query and inject each note only once", async () => {
  let queries = 0;
  const daemon = { async call(method, params) {
    if (method !== 'navMemory.query') return { accepted: params.events.length, dropped: 0 };
    queries++;
    await new Promise(resolve => setImmediate(resolve));
    return { host: params.host, total: 1, notes: [fixtureNote()] };
  } };
  const nav = new NavContext(daemon, true);
  const read = nav.wrap('navigate_page', async () => ({ content: [{ type: 'text', text: 'read' }] }));
  const results = await Promise.all([read({ url: 'https://dupe.example/' }), read({ url: 'https://dupe.example/' })]);
  assert.equal(queries, 1);
  assert.equal(results.filter(r => r.content[0].text.includes('[nav-memory]')).length, 1);
});

test("semantic, exact-text and referenced merges preserve scope, kind and polarity", async () => {
  for (const online of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'nav-merge-scope-'));
    const clock = new Date('2025-06-01T00:00:00Z');
    let output = [];
    const base = { kind: 'selector', summary: 'The page exposes a stable control.', detail: 'A structural locator identifies the control.', tools: ['click'], success: true, confidence: 0.6, pathGlob: '/form' };
    const embedder = { ...offlineEmbedder(), async isAvailable() { return online; }, async embedDocuments(texts) { return texts.map(() => Float32Array.from([1, 0, 0])); } };
    const store = new JsonNavStore(dir);
    const service = new NavMemoryService(store, { async distill() { return output; } }, embedder, () => clock);
    try {
      await service.init();
      process.env.ZEN_MCP_NAV_ETL_PROBE = '1';
      let sequence = 0;
      const run = async notes => {
        output = notes;
        const connId = `session-${sequence++}`;
        await service.handleRequest({ connId, containerScope: null }, 'navMemory.recordEvents', { events: [fixtureEvent(clock)] });
        await service.onSessionEnd(connId);
        assert.equal((await service.handleRequest({ connId, containerScope: null }, 'navMemory.etlNow', {})).status, 'processed');
      };
      await run([base]);
      for (const change of [{ pathGlob: '/billing' }, { pathGlob: undefined }, { kind: 'workflow' }, { success: false }]) {
        await run([{ ...base, ...change, reinforces: 1 }]);
      }
      let notes = store.allNotes().filter(n => n.host === 'example.com');
      assert.equal(notes.length, 5, 'incompatible facts must survive even with identical embeddings or summaries');
      assert.equal(new Set(notes.map(n => n.id)).size, 5, 'identity includes path and polarity');
      assert.ok(notes.every(n => n.reinforced === 1));
      await run([base, { ...base }]);
      notes = store.allNotes().filter(n => n.host === 'example.com');
      assert.equal(notes.length, 5);
      assert.equal(notes.find(n => n.kind === 'selector' && n.pathGlob === '/form' && n.success).reinforced, 2, 'one work file reinforces a fact once');
      await service.tick();
      assert.equal(store.allNotes().filter(n => n.host === 'example.com').length, 5, 'hourly sweep uses the same scope rules');
    } finally {
      delete process.env.ZEN_MCP_NAV_ETL_PROBE;
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function feedbackEvidence(overrides = {}) {
  return { host: 'example.com', path: '/form', check: 'selector', target: '#current', expected: true, observed: true, ...overrides };
}

test("live feedback assertions fail closed and evaluate safely without persisting page content", async () => {
  let ready = 'complete';
  let url = 'https://example.com/form?token=private#private';
  const selector = 'input[data-label="quoted\\\"value"]';
  const daemon = { async call(method, params) {
    assert.equal(method, 'dom.evaluate');
    assert.equal(params.tabId, 7);
    const result = runInNewContext(`(function(){${params.code}})()`, {
      location: { href: url },
      document: { readyState: ready, querySelector(css) { assert.equal(css, selector); return {}; } },
    });
    return { result };
  } };
  const evidence = await verifyFeedback(daemon, 7, { selector, present: true });
  assert.equal(evidence.path, '/form');
  assert.equal(evidence.observed, true);
  assert.equal(evidence.target, 'input[data-label="*"]');
  assert.equal(JSON.stringify(evidence).includes('private'), false);
  await assert.rejects(verifyFeedback(daemon, 7, { selector, present: false }), /did not satisfy/);
  ready = 'loading';
  await assert.rejects(verifyFeedback(daemon, 7, { selector, present: true }), /still loading/);
  ready = 'complete';
  url = 'http://localhost/form';
  await assert.rejects(verifyFeedback(daemon, 7, { selector, present: true }), /non-development/);
  await assert.rejects(verifyFeedback(daemon, 7, { selector, pathGlob: '/form', present: true }), /exactly one/);
  await assert.rejects(verifyFeedback(daemon, 7, { pathGlob: '/form?secret', present: true }), /invalid path/);
  url = 'https://example.com/form';
  assert.equal((await verifyFeedback(daemon, 7, { pathGlob: '/form', present: true })).check, 'path');
});

test("verified feedback demotes and suppresses stale advice, counts each session once, and survives restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-feedback-'));
  let clock = new Date('2025-06-01T00:00:00Z');
  const store = new JsonNavStore(dir);
  const service = new NavMemoryService(store, { async distill() { return []; } }, offlineEmbedder(), () => clock);
  const id = 'a'.repeat(64);
  try {
    await service.init();
    await store.updateNotes([fixtureNote({ id, host: 'example.com', pathGlob: '/form', lastSeenAt: clock.toISOString() })]);
    const report = (session, outcome, evidence = feedbackEvidence()) => service.handleRequest({ connId: session, containerScope: null }, 'navMemory.feedback', { id, outcome, evidence });
    const query = full => service.handleRequest({ connId: 'reader', containerScope: null }, 'navMemory.query', { host: 'example.com', path: '/form', full });
    const rankBefore = scoreNote(store.allNotes().find(n => n.id === id), { host: 'example.com', now: clock.getTime() });
    await assert.rejects(report('s0', 'confirmed', feedbackEvidence({ observed: false })), /verified structural/);
    await assert.rejects(report('s0', 'confirmed', feedbackEvidence({ host: 'other.example' })), /exact host/);
    await assert.rejects(report('s0', 'confirmed', feedbackEvidence({ path: '/billing' })), /path scope/);
    await assert.rejects(report('s0', 'confirmed', feedbackEvidence({ check: 'path', target: '/billing' })), /verified structural/);
    assert.equal((await report('s1', 'contradicted')).feedback.status, 'suspect');
    const suspect = store.allNotes().find(n => n.id === id);
    assert.ok(scoreNote(suspect, { host: 'example.com', now: clock.getTime() }) < rankBefore / 2);
    assert.equal(suspect.reinforced, 1, 'feedback is separate from heuristic distillation');
    assert.equal((await report('s1', 'contradicted')).recorded, false);
    assert.equal((await report('s1', 'obsolete')).feedback.contradicted, 0, 'corrected verdict replaces the same session vote');
    assert.equal((await query(false)).notes.length, 0, 'obsolete advice is not automatically eligible');
    assert.equal((await query(true)).notes.length, 1, 'obsolete advice remains inspectable');
    const stats = await service.handleRequest({ connId: 'r', containerScope: null }, 'navMemory.stats', {});
    assert.equal(stats.feedback.obsoleteNotes, 1);
    await service.stop();

    const reopened = new JsonNavStore(dir);
    const next = new NavMemoryService(reopened, { async distill() { return []; } }, offlineEmbedder(), () => clock);
    await next.init();
    assert.equal(reopened.allNotes().find(n => n.id === id).feedback.status, 'obsolete');
    assert.equal((await next.handleRequest({ connId: 's1', containerScope: null }, 'navMemory.feedback', { id, outcome: 'obsolete', evidence: feedbackEvidence() })).recorded, false);
    clock = new Date('2025-06-02T00:00:00Z');
    const restored = await next.handleRequest({ connId: 's2', containerScope: null }, 'navMemory.feedback', { id, outcome: 'confirmed', evidence: feedbackEvidence({ target: 'input[value="secret@example.com"]', ignored: 'private' }) });
    assert.equal(restored.feedback.status, 'active');
    assert.equal(restored.feedback.confirmed, 1);
    assert.equal(restored.feedback.obsolete, 1);
    assert.equal(restored.feedback.history.length, 2);
    assert.equal((await next.handleRequest({ connId: 'r', containerScope: null }, 'navMemory.query', { host: 'example.com', path: '/form' })).notes.length, 0, 'presence-only confirmation is a candidate');
    const raw = await readFile(join(dir, 'notes.json'), 'utf8');
    assert.equal(raw.includes('secret@example.com'), false);
    assert.equal(raw.includes('private'), false);
    assert.equal((await stat(join(dir, 'notes.json'))).mode & 0o777, 0o600);
    await next.stop();
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ETL cannot erase verified obsolescence and consolidation preserves evidence ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-feedback-etl-'));
  const clock = new Date('2025-06-01T00:00:00Z');
  const store = new JsonNavStore(dir);
  const id = 'b'.repeat(64);
  const note = fixtureNote({ id, host: 'example.com', embedding: vector([1, 0, 0]) });
  const service = new NavMemoryService(store, { async distill() { return [{ kind: note.kind, summary: note.summary, detail: note.detail, tools: [], success: true, confidence: 0.7 }]; } }, offlineEmbedder(), () => clock);
  try {
    await service.init();
    await store.updateNotes([note]);
    await service.handleRequest({ connId: 'verified', containerScope: null }, 'navMemory.feedback', { id, outcome: 'obsolete', evidence: feedbackEvidence() });
    await service.handleRequest({ connId: 'etl', containerScope: null }, 'navMemory.recordEvents', { events: [fixtureEvent(clock)] });
    await service.onSessionEnd('etl');
    process.env.ZEN_MCP_NAV_ETL_PROBE = '1';
    await service.handleRequest({ connId: 'etl', containerScope: null }, 'navMemory.etlNow', {});
    assert.equal(store.allNotes().find(n => n.id === id).feedback.status, 'obsolete');
    await store.updateNotes([fixtureNote({ id: 'c'.repeat(64), host: 'example.com', embedding: vector([1, 0, 0]) })]);
    await service.tick();
    assert.ok(store.allNotes().find(n => n.id === id).feedback.history.length > 0);
    assert.equal(store.allNotes().filter(n => n.host === 'example.com').length, 2);
  } finally {
    delete process.env.ZEN_MCP_NAV_ETL_PROBE;
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("feedback invalidation prevents an older in-flight query from injecting stale advice", async () => {
  let release;
  let queries = 0;
  const daemon = { async call(method, params) {
    if (method !== 'navMemory.query') return { accepted: params.events.length, dropped: 0 };
    const sequence = ++queries;
    if (sequence === 1) await new Promise(resolve => { release = resolve; });
    return { host: params.host, total: sequence === 1 ? 1 : 0, notes: sequence === 1 ? [fixtureNote()] : [] };
  } };
  const nav = new NavContext(daemon, true);
  const read = nav.wrap('navigate_page', async () => ({ content: [{ type: 'text', text: 'read' }] }));
  const old = read({ url: 'https://dupe.example/' });
  await new Promise(resolve => setImmediate(resolve));
  nav.invalidate('dupe.example', 'a'.repeat(64));
  assert.equal((await read({ url: 'https://dupe.example/' })).content[0].text, 'read');
  release();
  assert.equal((await old).content[0].text, 'read');
  assert.equal(queries, 2);
});

test("a semantic restatement of retired advice preserves its verified status", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-retired-semantic-'));
  const clock = new Date('2025-06-01T00:00:00Z');
  const store = new JsonNavStore(dir);
  const embedder = { ...offlineEmbedder(), async isAvailable() { return true; }, async embedDocuments(texts) { return texts.map(() => Float32Array.from([1, 0, 0])); } };
  const service = new NavMemoryService(store, { async distill() { return [{ kind: 'selector', summary: 'A restatement of the retired control.', detail: 'The same obsolete control is described again.', tools: [], success: true, confidence: 0.6 }]; } }, embedder, () => clock);
  const id = 'd'.repeat(64);
  try {
    await service.init();
    await store.updateNotes([fixtureNote({ id, host: 'example.com', embedding: vector([1, 0, 0]) })]);
    await service.handleRequest({ connId: 'verified', containerScope: null }, 'navMemory.feedback', { id, outcome: 'obsolete', evidence: feedbackEvidence() });
    await service.handleRequest({ connId: 'etl', containerScope: null }, 'navMemory.recordEvents', { events: [fixtureEvent(clock)] });
    await service.onSessionEnd('etl');
    process.env.ZEN_MCP_NAV_ETL_PROBE = '1';
    await service.handleRequest({ connId: 'etl', containerScope: null }, 'navMemory.etlNow', {});
    assert.equal(store.allNotes().filter(n => n.host === 'example.com').length, 1);
    assert.equal(store.allNotes().find(n => n.id === id).feedback.status, 'obsolete');
  } finally {
    delete process.env.ZEN_MCP_NAV_ETL_PROBE;
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('keyed page identities separate redacted routes and query caches without leaking paths', async () => {
  const key = 'test-secret';
  const add = 'https://example.com/add_remove_elements/';
  const dynamic = 'https://example.com/dynamic_controls';
  assert.equal(normalizeUrl(add).path, normalizeUrl(dynamic).path);
  assert.notEqual(pageFingerprint(add, key), pageFingerprint(dynamic, key));
  assert.equal(pageFingerprint(add, key), pageFingerprint(add.slice(0, -1) + '?token=private#private', key));
  assert.notEqual(pageFingerprint(add, key), pageFingerprint(add, 'rotated-key'));
  assert.notEqual(pageFingerprint('https://example.com/users/123', key), pageFingerprint('https://example.com/users/456', key));
  assert.notEqual(pageFingerprint('https://example.com/a%2Fb', key), pageFingerprint('https://example.com/a/b', key));
  const queries = [], events = [];
  const nav = new NavContext({ async call(method, params) {
    if (method === 'navMemory.query') { queries.push(params); return { host: params.host, total: 0, notes: [] }; }
    events.push(...params.events); return { accepted: params.events.length, dropped: 0 };
  } }, true, key);
  const read = nav.wrap('navigate_page', async () => ({ content: [{ type: 'text', text: 'ready' }] }));
  await read({ url: add }); await read({ url: dynamic }); await read({ url: add + '?token=private' });
  assert.equal(queries.length, 2);
  assert.equal(new Set(events.map(e => e.pageKey)).size, 2);
  assert.doesNotMatch(JSON.stringify(events), /private|add_remove_elements|dynamic_controls/);
});

test('automatic retrieval requires outcome proof on the exact page, including legacy and seed notes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nav-promotion-'));
  const store = new JsonNavStore(dir);
  const service = new NavMemoryService(store, { async distill() { return []; } }, offlineEmbedder());
  const pageKey = pageFingerprint('https://example.com/dynamic_controls', 'test-key');
  const otherKey = pageFingerprint('https://example.com/add_remove_elements', 'test-key');
  const id = 'a'.repeat(64);
  const ctx = { connId: 'same-session', containerScope: null };
  const evidence = { host: 'example.com', path: '/*', pageKey, check: 'selector', target: '#input', expected: true, observed: true };
  const query = (key = pageKey, full = false) => service.handleRequest(ctx, 'navMemory.query', { host: 'example.com', path: '/*', pageKey: key, full });
  const report = e => service.handleRequest(ctx, 'navMemory.feedback', { id, outcome: 'confirmed', evidence: e });
  try {
    await service.init();
    await store.updateNotes([fixtureNote({ id, host: 'example.com', pathGlob: '/*', source: { seed: true } })]);
    assert.equal((await query()).notes.length, 0);
    assert.equal((await query(pageKey, true)).notes.length, 1);
    await report(evidence);
    assert.equal((await query()).notes.length, 0, 'presence is not an outcome');
    const proof = { ...evidence, check: 'state', state: 'value' };
    assert.equal((await report(proof)).recorded, true, 'same vote can upgrade weak evidence');
    assert.equal((await report(proof)).recorded, false);
    assert.equal(store.allNotes().find(n => n.id === id).feedback.confirmed, 1);
    assert.equal((await query()).notes.length, 1);
    assert.equal((await query(otherKey)).notes.length, 0, 'redacted glob collisions cannot reuse a proof');
    assert.equal((await query(undefined)).notes.length, 1); // default above
    assert.equal((await service.handleRequest(ctx, 'navMemory.query', { host: 'example.com', path: '/*' })).notes.length, 0, 'old clients fail closed');
    await store.updateNotes([fixtureNote({ id: 'b'.repeat(64), host: 'example.com', pathGlob: '/*', pageKey })]);
    await assert.rejects(service.handleRequest(ctx, 'navMemory.feedback', { id: 'b'.repeat(64), outcome: 'confirmed', evidence: { ...proof, pageKey: otherKey } }), /scope/);
    const stats = await service.handleRequest(ctx, 'navMemory.stats', {});
    assert.equal(stats.eligibility.verifiedNotes, 1);
    await service.stop();
    const reopened = new JsonNavStore(dir); await reopened.init();
    assert.equal(reopened.allNotes().find(n => n.id === id).feedback.history[0].evidence.pageKey, pageKey);
    await reopened.close();
    assert.equal(mergeCompatible(fixtureNote({ pageKey }), fixtureNote({ pageKey: otherKey })), false);
  } finally { await service.stop(); await rm(dir, { recursive: true, force: true }); }
});

test('state verifier checks live outcomes and keeps field values transient', async () => {
  let element = { value: 'private-entered-value', disabled: false, checked: true, getClientRects() { return [1]; } };
  const fingerprint = url => pageFingerprint(url, 'test-key');
  const daemon = { async call(method, params) {
    return { result: runInNewContext(`(function(){${params.code}})()`, {
      location: { href: 'https://example.com/form?token=private' },
      document: { readyState: 'complete', querySelector() { return element; }, querySelectorAll() { return [element, element]; } },
      getComputedStyle() { return { display: 'block', visibility: 'visible' }; },
    }) };
  } };
  const evidence = await verifyFeedback(daemon, 1, { selector: '#input', state: 'value', value: 'private-entered-value' }, fingerprint);
  assert.equal(evidence.observed, true);
  assert.doesNotMatch(JSON.stringify(evidence), /private/);
  for (const state of ['enabled', 'checked', 'visible']) assert.equal((await verifyFeedback(daemon, 1, { selector: '#input', state, present: true }, fingerprint)).observed, true);
  assert.equal((await verifyFeedback(daemon, 1, { selector: '#input', state: 'count', count: 2 }, fingerprint)).observed, 2);
  await assert.rejects(verifyFeedback(daemon, 1, { selector: '#input', state: 'value', value: 'wrong' }, fingerprint), /did not satisfy/);
  await assert.rejects(verifyFeedback(daemon, 1, { selector: '#input', state: 'count', count: 3 }, fingerprint), /did not satisfy/);
  await assert.rejects(verifyFeedback(daemon, 1, { selector: '#input', state: 'enabled', present: true, value: 'extra' }, fingerprint), /one valid assertion/);
  element.disabled = true;
  await assert.rejects(verifyFeedback(daemon, 1, { selector: '#input', state: 'value', value: element.value }, fingerprint), /did not satisfy/);
  element = null;
  await assert.rejects(verifyFeedback(daemon, 1, { selector: '#input', state: 'enabled', present: false }, fingerprint), /did not satisfy/);
});

test('distillation confines selector claims to observed locators and exact page identities', async () => {
  process.env.ZEN_MCP_NAV_ETL_PROBE = '1';
  const dir = await mkdtemp(join(tmpdir(), 'nav-claims-'));
  const store = new JsonNavStore(dir);
  const item = { kind: 'selector', summary: '#elements button is the Add control.', detail: 'Invented semantic claim.', tools: ['click'], success: true, confidence: .6, locator: '#elements button' };
  const service = new NavMemoryService(store, { async distill() { return [item, { ...item, locator: '#invented' }]; } }, offlineEmbedder());
  try {
    await service.init();
    for (const [index, url] of ['https://example.com/add_remove_elements', 'https://example.com/dynamic_controls'].entries()) {
      const ctx = { connId: `claim-${index}`, containerScope: null };
      await service.handleRequest(ctx, 'navMemory.recordEvents', { events: [{ ts: Date.now(), tool: 'click', host: 'example.com', path: '/*', pageKey: pageFingerprint(url, 'test-key'), locator: '#elements button', ok: true }] });
      await service.onSessionEnd(ctx.connId);
      assert.equal((await service.handleRequest(ctx, 'navMemory.etlNow', {})).status, 'processed');
    }
    const notes = store.allNotes().filter(n => n.host === 'example.com');
    assert.equal(notes.length, 2);
    assert.notEqual(notes[0].id, notes[1].id);
    assert.notEqual(notes[0].pageKey, notes[1].pageKey);
    assert.equal(notes[0].summary, 'click accepted locator #elements button.');
    assert.doesNotMatch(JSON.stringify(notes), /Add control|Invented semantic|#invented/);
    assert.equal(mergeCompatible(notes[0], notes[1]), false);
  } finally { await service.stop(); await rm(dir, { recursive: true, force: true }); }
});
