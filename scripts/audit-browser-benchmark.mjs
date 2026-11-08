#!/usr/bin/env node
// Audit a saved run without new model decisions or changes to browser state.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const input = resolve(process.argv[2] || '/private/tmp/zen-browser-benchmark-scored.json');
const output = resolve(process.argv[3] || '/private/tmp/zen-browser-benchmark-audited.json');
const report = JSON.parse(await readFile(input, 'utf8'));
assert.equal(report.benchmark, 'live-zen-public-demo-tasks');
const corrections = [];
for (const run of report.runs) {
  if (report.oracleVersion === 2) continue;
  if (run.task === 'table-read') {
    const page = run.trace.filter(t => !t.error && t.tool === 'get_page_text').map(t => t.text).join('\n');
    // The first returned table supplies independent, recorded ground truth.
    const expected = page.match(/^Doe\t[^\t\n]+\t([^\t\n]+)/m)?.[1];
    assert.ok(expected, 'recorded table does not contain the requested row');
    const success = run.answer.trim().toLowerCase() === expected.trim().toLowerCase();
    corrections.push({ task: run.task, repetition: run.repetition, memory: run.memory, before: run.success, after: success, evidence: 'requested row in recorded live page text' });
    run.success = success;
  }
  if (run.task === 'add-remove') {
    const labels = new Map(), clicks = [];
    for (const step of run.trace) {
      if (step.error) continue;
      if (step.tool === 'navigate_page') { labels.clear(); clicks.length = 0; }
      if (step.tool === 'take_snapshot') {
        labels.clear();
        for (const match of step.text.matchAll(/button#(\S+)\s+name="([^"]+)"/g)) labels.set(match[1], match[2]);
      }
      if (step.tool === 'interactive_elements') {
        labels.clear();
        for (const match of step.text.matchAll(/^(\S+) button "([^"]+)"/gm)) labels.set(match[1], match[2]);
      }
      if (step.tool === 'click_by_uid') clicks.push(labels.get(step.args.uid) || 'unknown');
      if (step.tool === 'click') clicks.push(step.args.selector === 'text:Add Element' ? 'Add Element' : step.args.selector === '#elements button' ? 'Delete' : 'unknown');
    }
    const sequence = JSON.stringify(clicks) === JSON.stringify(['Add Element', 'Add Element', 'Add Element', 'Delete']);
    // The original DOM oracle checked exactly two remaining buttons. Require
    // the requested three-add / one-remove sequence as well, using live UID labels.
    const success = run.success && sequence;
    corrections.push({ task: run.task, repetition: run.repetition, memory: run.memory, before: run.success, after: success, evidence: 'recorded successful actions, current snapshot UID labels, and final DOM count', sequenceVerified: sequence });
    run.success = success;
  }
}
const pairs = new Map();
for (const run of report.runs) {
  const key = `${run.task}:${run.repetition}`;
  const pair = pairs.get(key) || [];
  pair.push(run); pairs.set(key, pair);
}
for (const pair of pairs.values()) assert.ok(pair.length === 2 && new Set(pair.map(r => r.memory)).size === 2, 'unmatched trial');
const excludedPairs = [...pairs.entries()].filter(([, pair]) => pair.some(r => r.failureReason)).map(([key, pair]) => ({ key, reason: pair.filter(r => r.failureReason).map(r => r.failureReason) }));
const excluded = new Set(excludedPairs.map(p => p.key));
const valid = report.runs.filter(r => !excluded.has(`${r.task}:${r.repetition}`));
const summary = Object.fromEntries(['off', 'on'].map(mode => {
  const runs = valid.filter(r => r.memory === mode);
  return [mode, { runs: runs.length, completed: runs.filter(r => r.success).length, successRate: runs.filter(r => r.success).length / runs.length, toolCalls: runs.reduce((n,r) => n + r.toolCalls, 0), browserActionErrors: runs.reduce((n,r) => n + r.failedActions - r.blockedActions, 0), rejectedActions: runs.reduce((n,r) => n + r.blockedActions, 0) }];
}));
const perTask = [...new Set(valid.map(r => r.task))].map(task => ({ task, ...Object.fromEntries(['off', 'on'].map(mode => {
  const runs = valid.filter(r => r.task === task && r.memory === mode);
  return [mode, { runs: runs.length, completed: runs.filter(r => r.success).length, toolCalls: runs.reduce((n,r) => n + r.toolCalls, 0) }];
})) }));
const audited = { ...report, originalSummary: report.summary, summary, audit: { input, attemptedRuns: report.runs.length, validRuns: valid.length, excludedPairs, corrections, method: report.oracleVersion === 2 ? 'strict live DOM oracle including add/remove click observer and named table row; whole matched pairs excluded for runner errors; no outcome-selected reruns' : 'table answer rescored from recorded requested row; add/remove sequence checked against live UID labels; whole matched pairs excluded for model-output errors; no reruns selected by outcome' }, perTask };
await writeFile(output, JSON.stringify(audited, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ output, summary, excludedPairs: excludedPairs.map(p => p.key), perTask }, null, 2));
