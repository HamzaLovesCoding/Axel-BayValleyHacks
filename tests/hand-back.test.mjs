import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { interpretKeywords } from "../lib/assistant.ts";
import { parseAssistantRequest, parseCommand } from "../lib/command.ts";
import { createSimLink } from "../lib/robot/sim.ts";
import { DEFAULT_TRAY } from "../lib/tray.ts";
import { useAssistant } from "../lib/store.ts";
import { DryArm } from "../bridge/arm.ts";
import { loadConfig, resolve } from "../bridge/config.ts";
import { createBridge } from "../bridge/server.ts";

const initial = useAssistant.getState();
const request = (text, extra = {}) => ({ text, tray: DEFAULT_TRAY, holding: null, presenting: null, lastFetched: 2, history: [], ...extra });
function reset(t) {
  useAssistant.setState({ ...initial, speakReplies: false });
  t.after(() => useAssistant.setState({ ...initial, speakReplies: false }));
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => timeout(fn, Math.min(ms, 5), ...args));
}
function keywords(url, options) {
  if (url === "/api/assistant") return Promise.resolve(Response.json(interpretKeywords(JSON.parse(options.body))));
  throw new Error(`Unexpected fetch ${url}`);
}

test("take parser and keyword confirmations only close while presenting", () => {
  assert.deepEqual(parseCommand({ action: "take", position: 2 }, DEFAULT_TRAY), { action: "take", position: 2 });
  assert.equal(parseCommand({ action: "take", position: 8 }, DEFAULT_TRAY), null);
  assert.equal(parseAssistantRequest(request("go", { presenting: 2 })).presenting, 2);
  for (const phrase of ["go", "ok", "okay", "got it", "take it", "Hey Axel, go!"]) {
    assert.deepEqual(interpretKeywords(request(phrase, { presenting: 2 })).command, { action: "take", position: 2 });
    assert.notEqual(interpretKeywords(request(phrase)).command?.action, "take");
  }
  assert.deepEqual(interpretKeywords(request("stop", { presenting: 2 })).command, { action: "stop" });
});

test("sim presents an empty gripper, takes it back and cancels waiting on release", async () => {
  let state = { holding: null, presenting: null };
  const link = createSimLink(() => state, 0.001);
  const phases = [];
  const run = (message) => link.run(message, ({ phase }) => phases.push(phase), new AbortController().signal);
  await run({ action: "return", position: 2, angle: 30, item: "Glasses" });
  assert.deepEqual(phases.splice(0), ["presenting"]);
  state = { holding: null, presenting: 2 };
  await run({ action: "take", position: 2, angle: 30, item: "Glasses" });
  assert.deepEqual(phases.splice(0), ["gripping", "returning", "placing", "stowing", "stowed"]);
  await run({ action: "release" });
  assert.deepEqual(phases, ["stowing", "stowed"]);
});

test("store hand-back works for voice transcripts, typing and tap confirmations in the simulator", async (t) => {
  reset(t);
  t.mock.method(globalThis, "fetch", keywords);
  for (const via of ["voice", "text", "tap"]) {
    useAssistant.setState({ holding: null, presenting: null, away: [2] });
    await useAssistant.getState().ask("Put the glasses back", via);
    assert.equal(useAssistant.getState().presenting, 2);
    assert.equal(useAssistant.getState().holding, null);
    assert.match(useAssistant.getState().line.text, /Put the glasses in my hand and say go/);
    assert.match(useAssistant.getState().turns.at(-1).text, /Put the glasses in my hand and say go/);
    await useAssistant.getState().ask(via === "tap" ? "Take it" : "go", via);
    assert.equal(useAssistant.getState().presenting, null);
    assert.equal(useAssistant.getState().phase, "stowed");
    assert.deepEqual(useAssistant.getState().away, []);
  }
});

test("store respects bridge state preconditions and release cancels a presentation", async (t) => {
  reset(t);
  t.mock.method(globalThis, "fetch", keywords);
  useAssistant.setState({ presenting: 2 });
  await useAssistant.getState().ask("Bring me the medication", "text");
  assert.equal(useAssistant.getState().line.text, "I'm waiting for you to hand something back first.");
  await useAssistant.getState().ask("Put the glasses back", "text");
  assert.equal(useAssistant.getState().line.text, "I'm already waiting for you to hand it to me.");
  await useAssistant.getState().ask("release", "tap");
  assert.equal(useAssistant.getState().presenting, null);
  assert.equal(useAssistant.getState().phase, "stowed");
  useAssistant.setState({ holding: 1 });
  await useAssistant.getState().ask("Put the glasses back", "text");
  assert.equal(useAssistant.getState().line.text, "I'm holding something else. Release it or put it back first.");
});

test("Stop during model interpretation prevents a late answer from starting motion", async (t) => {
  reset(t);
  let resolve;
  t.mock.method(globalThis, "fetch", () => new Promise((yes) => { resolve = yes; }));
  const ask = useAssistant.getState().ask("Bring me the medication", "text");
  assert.equal(useAssistant.getState().mode, "thinking");
  await useAssistant.getState().ask("stop", "voice");
  resolve(Response.json(interpretKeywords(request("Bring me the medication"))));
  await ask;
  assert.equal(useAssistant.getState().phase, "stopped");
  assert.equal(useAssistant.getState().mode, "idle");
  assert.equal(useAssistant.getState().holding, null);
});

test("store hand-back and reload reconciliation work against a real HTTP DryArm bridge", async (t) => {
  reset(t);
  const config = await loadConfig("bridge/fixtures/test-arm.json");
  const arm = new DryArm(resolve(config.poses.stow, [], config), { timeScale: 0.001 });
  const bridge = createBridge({ arm, config });
  await new Promise((yes) => bridge.server.listen(0, "127.0.0.1", yes));
  t.after(() => bridge.server.close());
  const url = `http://127.0.0.1:${bridge.server.address().port}`;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    if (input === "/api/assistant") return keywords(input, options);
    if (input === "/api/robot" && !options?.method) {
      const res = await fetch(`${url}/status`);
      return Response.json({ configured: true, reachable: res.ok, ...await res.json() });
    }
    if (input === "/api/robot") return fetch(`${url}/command`, options);
    throw new Error(`Unexpected fetch ${input}`);
  });
  useAssistant.setState({ robotMode: "robot" });
  for (const via of ["voice", "text", "tap"]) {
    await useAssistant.getState().ask("Put the glasses back", via);
    assert.equal(bridge.state.presenting, 2);
    useAssistant.setState({ presenting: null, holding: null });
    await useAssistant.getState().refreshHealth();
    assert.equal(useAssistant.getState().presenting, 2, "reload learns the bridge's presentation");
    await useAssistant.getState().ask(via === "tap" ? "Take it" : "ok", via);
    assert.equal(bridge.state.presenting, null);
    assert.equal(bridge.state.holding, null);
    assert.equal(useAssistant.getState().phase, "stowed");
  }
  await useAssistant.getState().ask("Bring me the glasses", "text");
  assert.equal(bridge.state.holding, 2);
  useAssistant.setState({ holding: null, presenting: null });
  await useAssistant.getState().refreshHealth();
  assert.equal(useAssistant.getState().holding, 2);
  await useAssistant.getState().ask("release", "tap");
  assert.deepEqual(useAssistant.getState().away, [2]);
  await sleep(10);
});


test("status busy exposes Stop after reload, and ready status never turns a stopped pose into stowed", async (t) => {
  reset(t);
  useAssistant.setState({ robotMode: "robot", phase: "stopped", angle: 42 });
  let busy = true;
  t.mock.method(globalThis, "fetch", async () => Response.json({ configured: true, reachable: true, busy, holding: null, presenting: null }));
  await useAssistant.getState().refreshHealth();
  assert.equal(useAssistant.getState().mode, "moving");
  assert.equal(useAssistant.getState().phase, "stopped");
  assert.equal(useAssistant.getState().angle, 42);
  busy = false;
  await useAssistant.getState().refreshHealth();
  assert.equal(useAssistant.getState().mode, "idle");
  assert.equal(useAssistant.getState().phase, "stopped");
});

test("release availability follows bridge status after Stop, rather than the last app phase", async (t) => {
  reset(t);
  useAssistant.setState({ robotMode: "robot", holding: null, phase: "stowed" });
  let canRelease = true;
  t.mock.method(globalThis, "fetch", async () => Response.json({ configured: true, reachable: true, holding: 2, presenting: null, needsRecovery: true, canRelease }));
  await useAssistant.getState().refreshHealth();
  assert.equal(useAssistant.getState().holding, 2, "learns an interrupted grip from the bridge");
  assert.equal(useAssistant.getState().phase, "stopped");
  assert.equal(useAssistant.getState().health.canRelease, true);
  canRelease = false;
  await useAssistant.getState().refreshHealth();
  assert.equal(useAssistant.getState().health.canRelease, false);
});

test("a status response begun before Stop cannot resurrect stale release availability", async (t) => {
  reset(t);
  useAssistant.setState({ robotMode: "robot", health: { configured: true, reachable: true, canRelease: false } });
  let resolveStatus;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    if (options?.method) return Response.json({ ok: true, stopped: true });
    return new Promise((yes) => { resolveStatus = yes; });
  });
  const poll = useAssistant.getState().refreshHealth();
  const stale = resolveStatus;
  useAssistant.getState().stopArm();
  stale(Response.json({ configured: true, reachable: true, holding: 2, presenting: null, canRelease: true }));
  await poll;
  await sleep(5);
  assert.equal(useAssistant.getState().health.canRelease, false);
  assert.equal(useAssistant.getState().holding, null);
});
