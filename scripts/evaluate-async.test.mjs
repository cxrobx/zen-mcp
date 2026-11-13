// evaluate_script refuses `await`/`async` before anything reaches the page (server/src/tools.ts
// findAsyncSyntax). The page evaluator is a synchronous ES5 interpreter, where both are a
// SyntaxError; a Promise-returning async wrapper was tried 2026-11-13 and resolves to null in eval5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findAsyncSyntax } from "../server/dist/tools.js";

const cases = [
  ["const x = await fetch(u); return 1;", "await"],
  ["return [1].map(async n => n);", "async"],
  ["return (async () => 1)();", "async"],
  ["return (async function () { return 1; })();", "async"],
  ['fetch("https://a.com"); await x;', "await"],
  ['return document.querySelector("script").async;', null],
  ["return {async: true};", null],
  ["// await later\nreturn 1;", null],
  ["/* await */ return 1;", null],
  ['return "please await the result";', null],
  ["return `async ${1}`;", null],
  ["return document.title;", null],
  ["const isAsync = 1; return isAsync;", null],
];

for (const [code, want] of cases) {
  test(`${JSON.stringify(code)} -> ${want}`, () => assert.equal(findAsyncSyntax(code), want));
}
