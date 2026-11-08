#!/usr/bin/env node
// Merge predetermined task groups, never select trials by their outcomes.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const manifest = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
const output = resolve(process.argv[3]);
const reports = await Promise.all(manifest.sources.map(async source => ({
  source,
  report: JSON.parse(await readFile(resolve(source.path), 'utf8')),
})));
const first = reports[0].report;
const runs = [], sources = [], tasks = new Set();
for (const { source, report } of reports) {
  for (const key of ['benchmark', 'oracleVersion', 'bankHash', 'model', 'repetitions', 'setup']) assert.deepEqual(report[key], first[key], `incompatible ${key}`);
  assert.equal(report.oracleVersion, 2);
  for (const task of source.tasks) { assert.ok(!tasks.has(task), 'task groups overlap'); tasks.add(task); }
  const selected = report.runs.filter(run => source.tasks.includes(run.task));
  for (const task of source.tasks) for (let rep = 1; rep <= first.repetitions; rep++) for (const memory of ['off', 'on']) {
    assert.equal(selected.filter(run => run.task === task && run.repetition === rep && run.memory === memory).length, 1, 'missing or duplicate trial');
  }
  runs.push(...selected);
  sources.push({ path: resolve(source.path), tasks: source.tasks, selectedRuns: selected.length, ignoredRuns: report.runs.length - selected.length });
}
assert.deepEqual([...tasks].sort(), [...manifest.expectedTasks].sort(), 'task coverage differs from predetermined manifest');
const checks = Object.fromEntries(['ownedTabsClosed', 'activeTabsUnchanged', 'productionNotesUnchanged'].map(key => [key, reports.every(({ report }) => report.checks[key] === true)]));
checks.frozenBankNotes = first.checks.frozenBankNotes;
checks.verifiedBankNotes = first.checks.verifiedBankNotes;
const summary = Object.fromEntries(['off', 'on'].map(memory => {
  const selected = runs.filter(run => run.memory === memory);
  return [memory, { runs: selected.length, completed: selected.filter(run => run.success).length, toolCalls: selected.reduce((n, run) => n + run.toolCalls, 0), failedActions: selected.reduce((n, run) => n + run.failedActions, 0), blockedActions: selected.reduce((n, run) => n + run.blockedActions, 0), runnerFailures: selected.filter(run => run.failureReason).length }];
}));
const modelUsage = { scope: 'all source processes including ignored runs; failed CLI usage may be unavailable' };
for (const key of ['requests', 'inputTokens', 'outputTokens', 'costUsd']) modelUsage[key] = reports.reduce((n, { report }) => n + report.modelUsage[key], 0);
modelUsage.models = [...new Set(reports.flatMap(({ report }) => report.modelUsage.models))];
const result = { ...first, startedAt: reports.map(({ report }) => report.startedAt).sort()[0], runs, checks, summary, modelUsage,
  execution: { sources, method: 'predetermined disjoint task groups; identical frozen bank/model/schemas/oracles/budgets; separate background tabs; remaining groups ran concurrently; no selection by outcome; interrupted duplicates outside designated groups omitted' } };
await writeFile(output, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ output, checks, summary, sources }, null, 2));
