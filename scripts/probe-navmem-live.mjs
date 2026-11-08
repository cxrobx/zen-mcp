#!/usr/bin/env node
// Run the real server handlers and real Zen extension against scratch memory.
// No probe event, planted note or feedback reaches the production nav store.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DaemonClient } from '../server/dist/daemon-client.js';
import { registerTools } from '../server/dist/tools.js';
import { NavContext } from '../server/dist/nav-memory.js';
import { JsonNavStore } from '../daemon/dist/nav-memory/store.js';
import { NavMemoryService } from '../daemon/dist/nav-memory/service.js';

process.env.ZEN_MCP_NAV_MEMORY = '0';
const dir = await mkdtemp(join(tmpdir(), 'zen-nav-live-'));
const configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const token = (await readFile(process.env.ZEN_MCP_TOKEN_FILE || join(configRoot, 'zen-mcp/auth.token'), 'utf8')).trim();
const live = new DaemonClient({ url: `ws://127.0.0.1:${process.env.ZEN_MCP_PORT || 8766}`, token });
const store = new JsonNavStore(dir);
const offline = { model: 'fixture', dimension: 3, async isAvailable() { return false; }, async embedDocuments() { return []; }, async embedQuery() { return new Float32Array([1, 0, 0]); }, status() { return { available: false, lastCheckedAt: null }; } };
const service = new NavMemoryService(store, { async distill() { return []; } }, offline);
const context = { connId: 'live-probe-scratch', containerScope: null };
const daemon = { call(method, params) {
  return method.startsWith('navMemory.') ? service.handleRequest(context, method, params) : live.call(method, params);
} };
const nav = new NavContext(daemon, true, token); // Capture is deliberately enabled ONLY in scratch memory.
const handlers = new Map();
const call = async (name, args = {}) => {
  const response = await handlers.get(name)(args);
  assert.ok(!response.isError, `${name}: ${response.content?.[0]?.text}`);
  return response.content[0].text;
};
const stamp = new Date().toISOString();
const note = (id, summary) => ({ id: id.repeat(64), host: 'example.com', registrableDomain: 'example.com', pathGlob: '/', kind: 'selector', summary, detail: 'A structural selector identifies a control on the fixture destination.', example: null, tools: ['get_page_text'], success: true, confidence: 0.6, reinforced: 1, createdAt: stamp, lastSeenAt: stamp, source: null, embedding: null });
let tabId;
try {
  await service.init();
  await store.updateNotes([note('a', 'body provides the destination document.'), note('b', '#zen-nav-retired-fixture identifies the old destination control.')]);
  await live.connect();
  registerTools({ registerTool(name, config, handler) { handlers.set(name, handler); } }, daemon, { current: null }, { name: 'live-probe', version: '1', daemonUrl: 'scratch-nav/real-extension' }, nav);
  const opened = await call('new_page_in_container', { name: process.argv[2] || 'Personal', url: 'https://example.com/', active: false });
  tabId = Number(opened.match(/tabId=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(tabId), 'new tab id missing');
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const { result } = await live.call('dom.evaluate', { tabId, code: 'return location.hostname === "example.com" && document.readyState === "complete" && document.querySelector("body") !== null;' });
      if (result === true) { ready = true; break; }
    } catch { /* The document may not have committed yet. */ }
    await sleep(250);
  }
  if (!ready) {
    const { result } = await live.call('dom.evaluate', { tabId, code: 'return { ready: document.readyState, title: document.title, hasBody: document.body !== null, hasHeading: document.querySelector("h1") !== null };' });
    throw new Error(`fixture destination not ready: ${JSON.stringify(result)}`);
  }
  assert.match(await call('nav_memory_feedback', { tabId, id: 'a'.repeat(64), outcome: 'confirmed', check: { selector: 'body', state: 'visible', present: true } }), /status: active/);
  const failed = await handlers.get('nav_memory_feedback')({ tabId, id: 'a'.repeat(64), outcome: 'confirmed', check: { selector: '#zen-nav-retired-fixture', present: true } });
  assert.equal(failed.isError, true, 'missing selector cannot confirm an outcome');
  const obsoleteArgs = { tabId, id: 'b'.repeat(64), outcome: 'obsolete', check: { selector: '#zen-nav-retired-fixture', present: false } };
  assert.match(await call('nav_memory_feedback', obsoleteArgs), /status: obsolete/);
  assert.match(await call('nav_memory_feedback', obsoleteArgs), /already recorded/);
  const page = await call('get_page_text', { tabId });
  assert.match(page, new RegExp('a'.repeat(64)), 'verified page hint missing');
  assert.doesNotMatch(page, new RegExp('b'.repeat(64)), 'retired advice leaked into automatic hints');
  assert.match(await call('get_domain_playbook', { host: 'example.com' }), /feedback: obsolete/);
  const stats = JSON.parse(await call('nav_memory_stats'));
  assert.equal(stats.feedback.confirmed, 1);
  assert.equal(stats.feedback.obsolete, 1);
  console.log(JSON.stringify({ liveZen: true, scratchMemoryOnly: true, confirmed: 1, obsolete: 1, repeatedReportCountedOnce: true, failedAssertionRejected: true, obsoleteHintSuppressed: true }));
} finally {
  if (tabId) await live.call('pages.close', { tabId });
  live.close();
  await service.stop();
  await rm(dir, { recursive: true, force: true });
}
