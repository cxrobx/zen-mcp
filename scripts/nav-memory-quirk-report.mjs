#!/usr/bin/env node
// Score the nav-memory quirk eval: merge shard reports, print the arm tables, the
// task-stratified contrasts and the verdict against the rule fixed before the run.
//
//   node scripts/nav-memory-quirk-report.mjs [--bank bank.json] [--json out.json] shard1.json shard2.json ...
//
// Every contrast is stratified by page: the difference is taken within each page and
// then averaged, so a page with more surviving runs cannot outvote the others.
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : null; };
const bankPath = flag('bank'), jsonPath = flag('json');
if (args.length === 0) { console.error('usage: nav-memory-quirk-report.mjs [--bank file] [--json file] report.json ...'); process.exit(2); }
const reports = await Promise.all(args.map(async path => JSON.parse(await readFile(path, 'utf8'))));
const everything = reports.flatMap(r => r.runs);
const runs = everything.filter(r => !r.runnerFailure);
const ARM_ORDER = ['off', 'shipped', 'ungated', 'ideal', 'off-changed', 'stale-ungated', 'stale-ideal'];
const arms = ARM_ORDER.filter(arm => runs.some(r => r.arm === arm));
const ITERATIONS = 10000;

// Seeded, so a rerun of this script prints the same intervals and p-values.
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
function wilson(k, n) {
  if (n === 0) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - w) / d), Math.min(1, (c + w) / d)];
}
const pct = x => `${(100 * x).toFixed(0)}%`;
const pts = x => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(0)}`;

function strata(group, a, b, value) {
  const tasks = [...new Set(runs.filter(r => r.group === group).map(r => r.task))];
  return tasks.map(task => ({ task, a: runs.filter(r => r.task === task && r.arm === a).map(value), b: runs.filter(r => r.task === task && r.arm === b).map(value) })).filter(s => s.a.length && s.b.length);
}
const stratifiedDiff = cells => mean(cells.map(s => mean(s.a) - mean(s.b)));

function contrast(group, a, b, value, seed) {
  const cells = strata(group, a, b, value);
  if (cells.length === 0) return null;
  const observed = stratifiedDiff(cells), random = rng(seed);
  const pick = xs => xs[Math.floor(random() * xs.length)];
  const boot = [];
  let extreme = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    boot.push(stratifiedDiff(cells.map(s => ({ a: s.a.map(() => pick(s.a)), b: s.b.map(() => pick(s.b)) }))));
    const shuffled = cells.map(s => {
      const pool = [...s.a, ...s.b];
      for (let j = pool.length - 1; j > 0; j--) { const k = Math.floor(random() * (j + 1)); [pool[j], pool[k]] = [pool[k], pool[j]]; }
      return { a: pool.slice(0, s.a.length), b: pool.slice(s.a.length) };
    });
    if (Math.abs(stratifiedDiff(shuffled)) >= Math.abs(observed) - 1e-12) extreme++;
  }
  boot.sort((x, y) => x - y);
  return { pages: cells.length, nA: cells.reduce((n, s) => n + s.a.length, 0), nB: cells.reduce((n, s) => n + s.b.length, 0), diff: observed, low: boot[Math.floor(0.025 * ITERATIONS)], high: boot[Math.floor(0.975 * ITERATIONS)], p: (extreme + 1) / (ITERATIONS + 1) };
}

const lines = [];
const out = text => lines.push(text);
const summary = { runs: everything.length, scored: runs.length, runnerFailures: {}, arms: {}, contrasts: [], perTask: {}, verdict: {} };

function armTable(group, title) {
  const rows = arms.map(arm => ({ arm, rs: runs.filter(r => r.group === group && r.arm === arm) })).filter(row => row.rs.length);
  if (rows.length === 0) return;
  out(`\n### ${title}\n`);
  out('| Arm | Runs | Completed | 95% interval | Mean calls | Errored calls | Claimed done, not done | Runs shown a note |');
  out('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const { arm, rs } of rows) {
    const k = rs.filter(r => r.success).length, [low, high] = wilson(k, rs.length);
    const row = { runs: rs.length, completed: k, rate: k / rs.length, low, high, meanCalls: mean(rs.map(r => r.toolCalls)), erroredCalls: rs.reduce((n, r) => n + r.failedActions, 0), falseDone: rs.filter(r => r.falseDone).length, shownNote: rs.filter(r => r.injectedIds.length > 0).length };
    (summary.arms[group] ??= {})[arm] = row;
    out(`| ${arm} | ${row.runs} | ${k} (${pct(row.rate)}) | ${pct(low)} to ${pct(high)} | ${row.meanCalls.toFixed(1)} | ${row.erroredCalls} | ${row.falseDone} | ${row.shownNote} |`);
  }
}

function contrastTable(title, specs) {
  const rows = specs.map(([group, a, b], i) => ({ group, a, b, done: contrast(group, a, b, r => r.success ? 1 : 0, 1000 + i), calls: contrast(group, a, b, r => r.toolCalls, 2000 + i) })).filter(row => row.done);
  if (rows.length === 0) return;
  out(`\n### ${title}\n`);
  out('| Contrast | Pages | Completion, points | 95% interval | p | Calls per run | 95% interval | p |');
  out('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    summary.contrasts.push(row);
    out(`| ${row.a} vs ${row.b} (${row.group}) | ${row.done.pages} | ${pts(row.done.diff)} | ${pts(row.done.low)} to ${pts(row.done.high)} | ${row.done.p.toFixed(3)} | ${row.calls.diff >= 0 ? '+' : ''}${row.calls.diff.toFixed(1)} | ${row.calls.low.toFixed(1)} to ${row.calls.high.toFixed(1)} | ${row.calls.p.toFixed(3)} |`);
  }
}

out(`Runs: ${everything.length} recorded, ${runs.length} scored.`);
for (const arm of arms) {
  const lost = everything.filter(r => r.arm === arm && r.runnerFailure).length, retried = everything.filter(r => r.arm === arm && r.tries > 1).length;
  summary.runnerFailures[arm] = { lost, retried };
}
out(`Planner failures after three tries (excluded): ${arms.map(arm => `${arm} ${summary.runnerFailures[arm].lost}`).join(', ')}. Runs that needed a retry: ${arms.map(arm => `${arm} ${summary.runnerFailures[arm].retried}`).join(', ')}.`);

armTable('quirk', 'Quirk pages');
armTable('control', 'Control pages');
contrastTable('Against no memory, page by page', [
  ['quirk', 'shipped', 'off'], ['quirk', 'ungated', 'off'], ['quirk', 'ideal', 'off'],
  ['quirk', 'stale-ungated', 'off-changed'], ['quirk', 'stale-ideal', 'off-changed'],
  ['control', 'shipped', 'off'], ['control', 'ungated', 'off'], ['control', 'ideal', 'off'],
]);

out('\n### Completion by page\n');
out(`| Page | ${arms.join(' | ')} |`);
out(`| --- | ${arms.map(() => '---:').join(' | ')} |`);
for (const task of [...new Set(runs.map(r => r.task))]) {
  const cells = arms.map(arm => { const rs = runs.filter(r => r.task === task && r.arm === arm); return rs.length ? `${rs.filter(r => r.success).length}/${rs.length}` : ''; });
  summary.perTask[task] = Object.fromEntries(arms.map((arm, i) => [arm, cells[i]]));
  out(`| ${task} | ${cells.join(' | ')} |`);
}

out('\n### Notes shown, mean per run\n');
out(`| Page | ${arms.filter(a => !a.startsWith('off')).join(' | ')} |`);
out(`| --- | ${arms.filter(a => !a.startsWith('off')).map(() => '---:').join(' | ')} |`);
for (const task of [...new Set(runs.map(r => r.task))]) {
  out(`| ${task} | ${arms.filter(a => !a.startsWith('off')).map(arm => { const rs = runs.filter(r => r.task === task && r.arm === arm); return rs.length ? mean(rs.map(r => r.injectedIds.length)).toFixed(1) : ''; }).join(' | ')} |`);
}

if (bankPath) {
  const bank = JSON.parse(await readFile(bankPath, 'utf8'));
  const byId = new Map(Object.values(bank.banks).flat().map(n => [n.id, n]));
  out('\n### What each arm was shown\n');
  for (const arm of arms.filter(a => !a.startsWith('off'))) {
    out(`\n**${arm}**\n`);
    for (const task of [...new Set(runs.map(r => r.task))]) {
      const ids = [...new Set(runs.filter(r => r.task === task && r.arm === arm).flatMap(r => r.injectedIds))];
      out(`- ${task}: ${ids.length ? ids.map(id => `[${byId.get(id)?.kind ?? '?'}] ${byId.get(id)?.summary ?? id}`).join(' · ') : '(nothing shown)'}`);
    }
  }
}

// The rule was fixed before any memory arm ran; this only reads the numbers against it.
const find = (a, b, group = 'quirk') => summary.contrasts.find(c => c.a === a && c.b === b && c.group === group)?.done;
const ideal = find('ideal', 'off'), shipped = find('shipped', 'off'), ungated = find('ungated', 'off'), staleU = find('stale-ungated', 'off-changed'), staleI = find('stale-ideal', 'off-changed');
if (ideal) {
  out('\n### Against the rule fixed before the run\n');
  summary.verdict.ceiling = ideal.diff >= 0.15;
  out(`- Ceiling: ideal notes ${pts(ideal.diff)} points against no memory (interval ${pts(ideal.low)} to ${pts(ideal.high)}). The bar was +15. ${summary.verdict.ceiling ? 'Cleared.' : 'Not cleared.'}`);
  if (shipped && ungated) out(`- Pipeline: shipped ${pts(shipped.diff)} (${pts(shipped.low)} to ${pts(shipped.high)}), ungated ${pts(ungated.diff)} (${pts(ungated.low)} to ${pts(ungated.high)}).`);
  if (staleI && staleU) {
    summary.verdict.staleLossExceedsGain = { ideal: -staleI.diff > ideal.diff, ungated: ungated ? -staleU.diff > ungated.diff : null };
    out(`- Staleness: stale ideal ${pts(staleI.diff)} (${pts(staleI.low)} to ${pts(staleI.high)}), stale ungated ${pts(staleU.diff)} (${pts(staleU.low)} to ${pts(staleU.high)}) against no memory on the changed pages.`);
  }
}

console.log(lines.join('\n'));
if (jsonPath) await writeFile(jsonPath, JSON.stringify(summary, null, 2), { mode: 0o600 });
