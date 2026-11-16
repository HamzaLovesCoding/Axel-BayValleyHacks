// Lives here rather than next to lib/voice/wake-phrase.ts: the app's tsconfig can't allow ".ts"
// imports (it sends next dev into a rebuild loop), and the bridge's test setup already runs these.
import assert from "node:assert/strict";
import { test } from "node:test";
import { matchWake, saysStop } from "../lib/voice/wake-phrase.ts";

test("wakes on Hey Axel and the spellings Whisper actually produces", () => {
  assert.equal(matchWake(" Hey Axel, bring me the glasses."), "bring me the glasses");
  assert.equal(matchWake(" Hey Axle, bring me the glasses.\n"), "bring me the glasses");
  assert.equal(matchWake("Axel."), "");
  assert.equal(matchWake("Okay, Axel. Put it back."), "put it back");
  assert.equal(matchWake("Hey Excel, I'm thirsty"), "i'm thirsty");
});

test("ignores ordinary speech, sound-alikes without hey, and Whisper's noise tags", () => {
  assert.equal(matchWake("I think I'll watch some TV later."), null);
  assert.equal(matchWake("Excel crashed again"), null);
  assert.equal(matchWake("The axle on the car is broken"), null);
  assert.equal(matchWake("[BLANK_AUDIO]"), null);
  assert.equal(matchWake(""), null);
});

test("hears stop with or without the wake phrase", () => {
  assert.ok(saysStop("Stop!"));
  assert.ok(saysStop("Hey Axel, stop."));
  assert.ok(!saysStop("I'm stopping by later"));
});
