#!/usr/bin/env node
// Deterministic fixture evaluation, not a claim about real-world task success.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonNavStore } from '../daemon/dist/nav-memory/store.js';
import { NavMemoryService } from '../daemon/dist/nav-memory/service.js';
import { NavContext } from '../server/dist/nav-memory.js';
import { verifyFeedback } from '../server/dist/nav-feedback.js';
import { pageFingerprint } from '../server/dist/nav-identity.js';
import { runInNewContext } from 'node:vm';

const dir = await mkdtemp(join(tmpdir(), 'zen-nav-eval-'));
const store = new JsonNavStore(dir);
const offline = { model: 'fixture', dimension: 3, async isAvailable() { return false; }, async embedDocuments() { return []; }, async embedQuery() { return new Float32Array([1, 0, 0]); }, status() { return { available: false, lastCheckedAt: null }; } };
const service = new NavMemoryService(store, { async distill() { return []; } }, offline);
const host = 'app.example.com';
const stamp = new Date().toISOString();
const note = (id, selector) => ({ id: id.repeat(64), host, registrableDomain: 'example.com', pathGlob: '/billing', kind: 'selector', summary: `${selector} identifies the billing form.`, detail: 'The form is reachable through this stable structural id.', example: null, tools: ['fill'], success: true, confidence: 0.6, reinforced: 1, createdAt: stamp, lastSeenAt: stamp, source: null, embedding: null });
const first = note('a', '#current');

async function run(enabled, selector) {
  const context = { connId: `eval-${enabled}-${selector}`, containerScope: null };
  const daemon = { call(method, params) { return service.handleRequest(context, method, params); } };
  const nav = new NavContext(daemon, enabled, 'fixture-key');
  let toolCalls = 0;
  let failedActions = 0;
  const read = nav.wrap('navigate_page', async () => { toolCalls++; return { content: [{ type: 'text', text: 'Fixture page ready.' }] }; });
  await read({ url: `https://${host}/` });
  const page = await read({ url: `https://${host}/billing` });
  const known = page.content[0].text.match(/#[a-z]+ identifies/);
  const suggested = known ? known[0].split(' ')[0] : '#legacy';
  const fill = nav.wrap('fill', async args => {
    toolCalls++;
    const found = args.selector === selector;
    if (!found) failedActions++;
    return { isError: !found, content: [{ type: 'text', text: found ? 'Fixture result verified.' : 'Error [NOT_FOUND]: fixture control missing.' }] };
  });
  const attempted = await fill({ url: `https://${host}/billing`, selector: suggested });
  if (attempted.isError) await fill({ url: `https://${host}/billing`, selector });
  await new Promise(resolve => setImmediate(resolve));
  return { toolCalls, failedActions, hint: known ? suggested : null, completed: true };
}

try {
  await service.init();
  await store.updateNotes([first]);
  const promote = async (id, target = '#current') => service.handleRequest({ connId: `verified-${id}`, containerScope: null }, 'navMemory.feedback', { id, outcome: 'confirmed', evidence: { host, path: '/billing', pageKey: pageFingerprint(`https://${host}/billing`, 'fixture-key'), check: 'state', state: 'value', target, expected: true, observed: true } });
  await promote(first.id);
  const memoryOff = await run(false, '#current');
  const memoryOn = await run(true, '#current');
  assert.equal(memoryOn.failedActions, 0);
  assert.ok(memoryOn.toolCalls < memoryOff.toolCalls);

  // The fixture website changes its selector. A verified absence retires the
  // old advice, then independent structural knowledge names the replacement.
  const evidence = await verifyFeedback({ async call(method, params) {
    return { result: runInNewContext(`(function(){${params.code}})()`, {
      location: { href: `https://${host}/billing` },
      document: { readyState: 'complete', querySelector(css) { return css === '#replacement' ? {} : null; } },
    }) };
  } }, 1, { selector: '#current', present: false });
  await service.handleRequest({ connId: 'changed-site', containerScope: null }, 'navMemory.feedback', {
    id: first.id, outcome: 'obsolete', evidence,
  });
  await store.updateNotes([note('b', '#replacement')]);
  await promote('b'.repeat(64), '#replacement');
  const changedSite = await run(true, '#replacement');
  assert.equal(changedSite.hint, '#replacement');
  assert.equal(changedSite.failedActions, 0);
  const inspected = await service.handleRequest({ connId: 'reader', containerScope: null }, 'navMemory.query', { host, full: true });
  assert.ok(inspected.notes.some(n => n.id === first.id && n.feedback.status === 'obsolete'));
  console.log(JSON.stringify({ fixtureOnly: true, memoryOff, memoryOn, changedSite, obsoleteAdviceRemainsInspectable: true }, null, 2));
} finally {
  await service.stop();
  await rm(dir, { recursive: true, force: true });
}
