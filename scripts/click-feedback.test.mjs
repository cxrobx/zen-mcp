// The page line printed after an interaction is read the instant the action returns, before
// a full page load commits - so a click on a real link reports the page it LEFT. A bare
// `page: <old url>` read as "the click did nothing", and the natural next move was to click
// again. These pin the wording that stops that: a click says when its line was read and, when
// the URL has not moved yet, why that proves nothing. Non-click actions stay unannotated, so
// a fill is never told to wait for a navigation it cannot have started.
import assert from "node:assert/strict";
import test from "node:test";

import { feedbackLine } from "../server/dist/feedback.js";

const PENDING = /url unchanged so far - if this click should load a new page, that load would not show here yet/;

function result(feedback, extra = {}) {
  return { tabId: 1, ...(feedback ? { feedback } : {}), ...extra };
}

test("a click whose url has not moved says the load may still be pending", () => {
  const line = feedbackLine(
    result({ url: "https://example.com/list", title: "List", navigated: false }),
    { click: true },
  );
  assert.match(line, /^\npage right after the click: "List" https:\/\/example\.com\/list\n/);
  assert.match(line, PENDING);
  assert.match(line, /wait_for its url or text before concluding it did nothing/);
});

test("a click that already navigated carries no pending note", () => {
  const line = feedbackLine(
    result({ url: "https://example.com/detail", title: "Detail", navigated: true }),
    { click: true },
  );
  assert.equal(line, '\npage right after the click: "Detail" https://example.com/detail navigated');
});

test("a non-click action keeps the plain page line and is never told to wait", () => {
  const line = feedbackLine(
    result({
      url: "https://example.com/form",
      title: "Form",
      navigated: false,
      activeElement: { tag: "input", name: "Email" },
    }),
  );
  assert.equal(line, '\npage: "Form" https://example.com/form active=input name="Email"');
  assert.doesNotMatch(line, PENDING);
});

test("the pending note sits on its own line, before the occlusion and new-tab notes", () => {
  const line = feedbackLine(
    result(
      { url: "https://example.com/", title: "", navigated: false, activeElement: { tag: "a" } },
      { occludedBy: 'div "Cookie consent"', opensNewTab: "https://example.org/report" },
    ),
    { click: true },
  );
  const lines = line.split("\n").slice(1);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "page right after the click: https://example.com/ active=a");
  assert.match(lines[1], PENDING);
  assert.match(lines[2], /^covered by div "Cookie consent"/);
  assert.match(lines[3], /^opens in a new tab: https:\/\/example\.org\/report/);
});

test("no feedback means no page line at all, click or not", () => {
  assert.equal(feedbackLine(result(null), { click: true }), "");
  assert.equal(feedbackLine(result(null)), "");
});
