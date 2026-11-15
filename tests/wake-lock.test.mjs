import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { holdScreenAwake, needsScreenAwake } from "../lib/wake-lock.ts";

const idle = { mode: "idle", phase: "stowed", presenting: null, handsFree: false, engines: { wake: "none" } };
const page = () => Object.assign(new EventTarget(), { visibilityState: "visible" });
class Sentinel extends EventTarget {
  released = false;
  async release() { this.released = true; this.dispatchEvent(new Event("release")); }
}

test("wake lock is required for motion, holding and presentation with Hands-free off", () => {
  assert.equal(needsScreenAwake(idle), false);
  for (const patch of [{ mode: "moving" }, { presenting: 2 }, { phase: "presenting" }, { phase: "holding" }])
    assert.equal(needsScreenAwake({ ...idle, ...patch }), true);
  assert.equal(needsScreenAwake({ ...idle, handsFree: true, engines: { wake: "whisper" } }), true);
});

test("wake lock reacquires after foregrounding or revocation and releases on cleanup", async () => {
  const doc = page();
  const locks = [];
  const end = holdScreenAwake(doc, { request: async () => { const lock = new Sentinel(); locks.push(lock); return lock; } });
  await setImmediate();
  assert.equal(locks.length, 1);
  doc.dispatchEvent(new Event("visibilitychange"));
  await setImmediate();
  assert.equal(locks.length, 1, "does not request duplicate locks");
  doc.visibilityState = "hidden";
  await locks[0].release();
  await setImmediate();
  assert.equal(locks.length, 1);
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  await setImmediate();
  assert.equal(locks.length, 2);
  await locks[1].release();
  await setImmediate();
  assert.equal(locks.length, 3, "visible revocation reacquires");
  end();
  assert.equal(locks[2].released, true);
  doc.dispatchEvent(new Event("visibilitychange"));
  await setImmediate();
  assert.equal(locks.length, 3, "cleanup never reacquires");
});

test("late wake-lock results are released, concurrent requests deduplicate, and rejection is handled", async () => {
  const doc = page();
  let resolve;
  let requests = 0;
  const end = holdScreenAwake(doc, { request: () => { requests++; return new Promise((yes) => { resolve = yes; }); } });
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(requests, 1);
  end();
  const sentinel = new Sentinel();
  resolve(sentinel);
  await setImmediate();
  assert.equal(sentinel.released, true);
  const denied = holdScreenAwake(doc, { request: async () => { throw new Error("Denied"); } });
  await setImmediate();
  denied();
});
