import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { StopBar } from "../components/stop-bar.tsx";
import { useAssistant } from "../lib/store.ts";
import { listenForStop } from "../lib/voice/listen.ts";
import { earFor, heardStop } from "../lib/voice/wake-phrase.ts";

if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
const base = { mode: "moving", stopping: false, speaking: false, handsFree: false, whisper: false, browser: false };

test("while the arm moves the stop ear is on with Hands-free off, on Whisper and on the browser engine", () => {
  assert.equal(earFor({ ...base, whisper: true }), "stop-whisper");
  assert.equal(earFor({ ...base, whisper: true, speaking: true }), "stop-whisper", "Whisper keeps listening while Axel talks");
  assert.equal(earFor({ ...base, browser: true }), "stop-browser");
  assert.equal(earFor({ ...base, browser: true, speaking: true }), "off", "the browser recogniser waits for the line to end");
  assert.equal(earFor({ ...base, whisper: true, browser: true }), "stop-whisper");
  assert.equal(earFor(base), "off", "no engine at all");
  assert.equal(earFor({ ...base, whisper: true, stopping: true }), "off", "rests while a Stop is being confirmed");
  // Not moving: nothing listens unless Hands-free is on, exactly as before.
  for (const mode of ["idle", "listening", "thinking"]) assert.equal(earFor({ ...base, mode, whisper: true, browser: true }), "off");
  assert.equal(earFor({ ...base, mode: "idle", handsFree: true, whisper: true }), "wake");
  assert.equal(earFor({ ...base, mode: "idle", handsFree: true, whisper: true, speaking: true }), "off");
  assert.equal(earFor({ ...base, mode: "idle", handsFree: true, browser: true }), "off", "Hey Axel still needs Whisper");
});

test("stop is heard in any sentence, but not when it may be Axel's own line", () => {
  for (const text of ["stop", "Stop!", "please stop it", "wait", "[noise] halt"]) assert.equal(heardStop(text, null), true);
  assert.equal(heardStop("bring me the water", null), false);
  assert.equal(heardStop("stop", "Bringing your glasses right over."), true);
  assert.equal(heardStop("say stop if you need me to", "I'm still moving. Say “stop” if you need me to."), false);
});

test("the browser stop ear reports every transcript, restarts when the recogniser ends, and shuts off cleanly", async (t) => {
  const made = [];
  class Recognition {
    constructor() { made.push(this); }
    start() { this.started = true; }
    abort() { this.aborted = true; }
  }
  t.mock.property(globalThis, "window", { webkitSpeechRecognition: Recognition });
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timeout(fn, Math.min(ms, 1), ...args));
  const heard = [];
  const end = listenForStop((text) => heard.push(text));
  assert.equal(made.length, 1);
  assert.ok(made[0].started && made[0].continuous && made[0].interimResults);
  made[0].onresult({ results: [[{ transcript: "please" }], [{ transcript: "stop" }]] });
  assert.deepEqual(heard, ["please stop"]);
  made[0].onend();
  await new Promise((r) => timeout(r, 10));
  assert.equal(made.length, 2, "started again after the recogniser ended on its own");
  end();
  assert.equal(made[1].aborted, true);
  made[1].onresult({ results: [[{ transcript: "stop" }]] });
  made[1].onend();
  await new Promise((r) => timeout(r, 10));
  assert.equal(heard.length, 1, "nothing is reported after shut-off");
  assert.equal(made.length, 2, "and it does not restart");

  // Permission refused: give up rather than ask again and again.
  const denied = listenForStop(() => {});
  made[2].onerror({ error: "not-allowed" });
  made[2].onend();
  await new Promise((r) => timeout(r, 10));
  assert.equal(made.length, 3);
  denied();
});

test("a spoken stop ends the store's stopping flag only once the Stop is answered", async (t) => {
  const initial = useAssistant.getState();
  t.after(() => useAssistant.setState({ ...initial, speakReplies: false }));
  useAssistant.setState({ ...initial, speakReplies: false, mode: "moving" });
  useAssistant.getState().stopArm();
  assert.equal(useAssistant.getState().stopping, true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(useAssistant.getState().stopping, false);
});

test("Settings shows a Stop button while the arm moves, and only then", (t) => {
  // Server rendering reads the store's initial-state object, so set the mode on that.
  const initial = useAssistant.getInitialState();
  t.after(() => { initial.mode = "idle"; });
  const render = (mode) => {
    initial.mode = mode;
    return renderToString(createElement(StopBar));
  };
  assert.match(render("moving"), /<button[^>]*aria-label="Stop the arm"/);
  for (const mode of ["idle", "listening", "thinking"]) assert.equal(render(mode), "");
});
