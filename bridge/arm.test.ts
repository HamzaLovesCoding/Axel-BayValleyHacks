import assert from "node:assert/strict";
import { test } from "node:test";
import { DryArm } from "./arm.ts";

test("DryArm uses peak speed, synchronized smoothstep, and rounds duration up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const arm = new DryArm([90, 120, 30, 90, 90]);
  let done = false;
  const move = arm.move([90, 110, 35, 90, 90], 60).then(() => { done = true; });
  now = 125;
  t.mock.timers.tick(125);
  assert.deepEqual(arm.position(), [90, 115, 32.5, 90, 90]);
  now = 249;
  t.mock.timers.tick(124);
  await Promise.resolve();
  assert.equal(done, false);
  now = 250;
  t.mock.timers.tick(1);
  await move;
  assert.equal(done, true);
  assert.deepEqual(arm.position(), [90, 110, 35, 90, 90]);

  done = false;
  const rounded = arm.move([90, 111, 35, 90, 90], 7).then(() => { done = true; });
  now += 214;
  t.mock.timers.tick(214);
  await Promise.resolve();
  assert.equal(done, false);
  now++;
  t.mock.timers.tick(1);
  await rounded;
  assert.equal(done, true);
});
