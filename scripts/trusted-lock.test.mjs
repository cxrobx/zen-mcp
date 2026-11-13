// A locked screen must refuse a trusted click or key with the REAL reason. Before this, the
// helper's lock went unreported, every attempt failed as "the browser window is not focused",
// and an agent spent its time hunting a focus bug that did not exist (2026-11-13, Mac mini).
import assert from "node:assert/strict";
import test from "node:test";

import { lockedRefusal } from "../server/dist/trusted.js";

test("a locked screen refuses with the lock as the reason, not focus", () => {
  const err = lockedRefusal({ bundleId: "com.example.other", pid: 1, locked: true }, "click");
  assert.ok(err);
  assert.equal(err.code, "BAD_PERMS");
  assert.match(err.message, /screen is locked/);
  assert.doesNotMatch(err.message, /not focused/);
  assert.match(err.message, /Nothing was clicked/);
  assert.match(err.hint, /zen-laptop/);
  assert.match(err.hint, /Tab ids differ/);
});

test("a key says pressed, not clicked", () => {
  assert.match(lockedRefusal({ locked: true }, "key").message, /no real key .*Nothing was pressed/);
});

test("unlocked, or an older helper that does not report the lock, is not refused", () => {
  assert.equal(lockedRefusal({ bundleId: "x", pid: 1, locked: false }), null);
  assert.equal(lockedRefusal({ bundleId: "x", pid: 1 }), null);
});
