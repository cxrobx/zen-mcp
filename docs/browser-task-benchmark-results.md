# Browser task benchmark — audited 2026-09-30

## Initial comparison

The broader evaluation did **not demonstrate an overall reliability benefit from memory**. In this small sample, memory reduced some task overhead but completed fewer tasks. This does not support a claim that the learning system is near gold standard.

The benchmark attempted 32 live Zen runs across eight public demo tasks, alternating memory on/off over two repetitions. Fresh Claude Haiku 4.5 decisions drove current server tool handlers. Successful scripted warmups were distilled by the real Claude distiller into a shared scratch note bank. Embeddings were disabled. Production notes remained byte-for-byte unchanged and all owned tabs were closed. The scored run also preserved the active tabs.

Two matched pairs were excluded because one member failed to return valid model output, leaving **28 valid runs: 14 per condition**. Browser-task failures and invalid tool arguments remain in the results. A table oracle originally selected the first row instead of the requested named row; the four table results were corrected from their recorded live page text. Add/remove results were audited against successful clicks, current snapshot UID labels, and the final DOM count to verify three additions followed by one deletion. No trials were selectively rerun to improve scores. The earlier diagnostic run, which dropped setup hints, is excluded entirely.

| Metric | Memory off | Memory on |
| --- | ---: | ---: |
| Completed | 12/14 (86%) | 10/14 (71%) |
| Attempted tool calls | 79 | 74 |
| Browser action errors | 0 | 7 |
| Rejected action proposals | 1 | 3 |

Setup, navigation settling, and independent oracle reads are excluded from tool-call totals. Rejected proposals are included as attempted calls but distinguished from browser action errors. Fewer total calls is not sufficient evidence of an efficiency benefit when task completion differs.

| Task | Completed, off | Completed, on | Calls, off | Calls, on |
| --- | ---: | ---: | ---: | ---: |
| Dropdown | 2/2 | 2/2 | 8 | 8 |
| Checkboxes | 1/1 | 1/1 | 12 | 5 |
| Add/remove controls | 2/2 | 0/2 | 18 | 24 |
| Numeric input | 2/2 | 2/2 | 8 | 6 |
| Delayed input enablement | 0/2 | 1/2 | 10 | 11 |
| Delayed rendering | 2/2 | 1/2 | 9 | 10 |
| Table reading | 2/2 | 2/2 | 5 | 4 |
| Nested frames | 1/1 | 1/1 | 9 | 6 |

## Findings

- Path privacy normalization collapses both `/add_remove_elements/` and `/dynamic_controls` to `/*` because their static segments meet the opaque-ID length rule. This loses page identity and allows unrelated advice to share a scope. A privacy-preserving route identity is needed; simply retaining all raw segments would weaken the existing privacy guarantees.
- Some learned summaries omit the actual selector or describe a selector as a vague alternative. A diagnostic warmup also produced an incorrect Add/Delete attribution. The scored bank inferred a URL transition from `/` to `/*`, treating a redaction placeholder as a real site route. Distillation needs stronger evidence and clearer handling of redacted paths.
- In the scored add/remove runs, the planner repeatedly guessed a nonexistent CSS `name` attribute and once used a stale snapshot UID. Both memory-on attempts exhausted their budgets, producing seven browser action errors. The small sample cannot establish that memory caused those guesses.
- Some runs claimed completion after successful RPCs while the independent state check still failed. This supports keeping live outcome validation separate from transport success.

The three earlier improvements remain useful mechanisms: refreshed page hints, explicit feedback with retirement, and compatible merging. This evaluation exercises learned hint retrieval and browser behavior; it does not isolate the causal effect of each change, automatically exercise feedback correction, or prove production performance. One public demo host, one decision model, two repetitions, and disabled embeddings limit the conclusions.

## Reproduction

Run `npm run eval:browser` with the Zen extension connected and an authenticated Claude CLI. The current harness passes setup observations to the planner, permits bounded arrays of DOM reads, returns rejected proposals for recovery, checks the named table row, and uses a click observer to verify the add/remove sequence. The initial results above were audited against the saved run. The follow-up below reruns all eight tasks with the corrected live oracles.

The original scored report is `/private/tmp/zen-browser-benchmark-scored.json`; the audited report is `/private/tmp/zen-browser-benchmark-audited.json`. Both contain only benchmark public-page traces and scratch notes, with mode `0600`, and remain outside the repository. Reproduce the audit with `node scripts/audit-browser-benchmark.mjs <scored-report> <audited-report>`.

## Follow-up: keyed page identity and outcome gate

The follow-up completed **32 valid trials, 16 per condition**, with no runner-failure pairs excluded. It used a frozen nine-note bank from independently successful scripted warmups: eight supported selector facts received live state/value proofs; one workflow candidate was withheld. The oracle verified actual click order (`add,add,add,remove`), resulting DOM state, and the requested table row. Real Zod schemas and an explicit UID-versus-CSS distinction were provided equally to both conditions.

| Metric | Memory off | Memory on |
| --- | ---: | ---: |
| Completed | 14/16 (87.5%) | 13/16 (81.25%) |
| Attempted tool calls | 92 | 83 |
| Browser action errors | 0 | 2 |
| Rejected action proposals | 1 | 0 |

| Task | Completed, off | Completed, on | Calls, off | Calls, on |
| --- | ---: | ---: | ---: | ---: |
| Dropdown | 2/2 | 2/2 | 8 | 6 |
| Checkboxes | 1/2 | 2/2 | 12 | 10 |
| Add/remove controls | 2/2 | 2/2 | 19 | 23 |
| Numeric input | 2/2 | 2/2 | 8 | 9 |
| Delayed input enablement | 1/2 | 0/2 | 15 | 12 |
| Delayed rendering | 2/2 | 1/2 | 8 | 8 |
| Table reading | 2/2 | 2/2 | 5 | 4 |
| Nested frames | 2/2 | 2/2 | 17 | 11 |

All injected note ids were audited against the independently verified notes for their task: **zero unverified or cross-page hints**. The two long routes now have different keyed identities despite both readable paths remaining `/*`. Add/remove failures disappeared, but overall reliability still did not improve. The small sample and changed harness/bank prevent attributing the before/after improvement to one implementation change.

The remaining failures expose a separate limitation: verified historical locator success does not encode every prerequisite. In the delayed enablement task, the planner filled before the control finished enabling and treated successful RPCs or generic DOM stability as completion. In one memory-on delayed-rendering run it ignored the observed selector, proposed unsupported `:contains()` CSS, then declared completion after a timeout. These are task failures, retained in the score. Better prerequisite handling and completion/error recovery need a separately evaluated change; this result does not justify a gold-standard claim.

To shorten the run, the first three task groups ran serially and the remaining five ran in three independent processes with separate background tabs. The model, frozen bank, schemas, oracles, budgets and original task-based alternating order were identical. Task ownership was decided before those processes ran; results were combined by the declared task groups, never by success. Four surplus runs from stopping the original loop outside its assigned group were omitted, and an earlier preflight was excluded entirely. Wall-clock latency should not be compared across concurrent groups.

All owned tabs were closed. The active-tab guard failed during these runs; no focus/activation tool was allowed, so this report does **not** claim browser focus was preserved. Production navigation events and feedback were routed only to scratch memory. A full-store byte guard differed in the longest shard because the daemon advanced its hourly `lastConsolidateAt` metadata; production note fields were separately checked unchanged using overlapping snapshots. The harness now hashes note content separately from metadata and records the active-tab ids for future diagnostics.

The frozen bank is `/private/tmp/zen-browser-promoted-bank.json`. The combined raw report is `/private/tmp/zen-browser-gated-combined.json`; the audited report is `/private/tmp/zen-browser-gated-audited.json`. The explicit group manifest is `/private/tmp/zen-browser-gated-manifest.json`. All reports remain local with mode `0600`. Reproduce the combination with `node scripts/merge-browser-benchmarks.mjs <manifest> <combined-output>`, then run the audit script. The audited artifact also records the hint-scope and note-content checks.

Deployment verification preserved all **378** production note ids. They are candidates until a relevant state/value outcome is verified on their page; no existing note is automatically trusted because of confidence, seeding or repetition. The daemon was reloaded and the live Zen scratch probe passed after reload. Existing MCP processes must reconnect to expose the new feedback assertion schema and stable keyed identity.
