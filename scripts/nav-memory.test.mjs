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
import { rankNotes } from "../daemon/dist/nav-memory/ranking.js";
import { encodeEmbedding } from "../daemon/dist/nav-memory/embeddings.js";
import { JsonNavStore } from "../daemon/dist/nav-memory/store.js";
import { NavMemoryService } from "../daemon/dist/nav-memory/service.js";
import { NavContext } from "../server/dist/nav-memory.js";

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

test("server injection is once per host and capture excludes entered values", async () => {
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
