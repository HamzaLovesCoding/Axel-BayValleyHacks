import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { bridgeLink, BridgeError, checkRobot } from "../lib/robot/bridge.ts";
import { useAssistant } from "../lib/store.ts";
import { interpretKeywords } from "../lib/assistant.ts";

const message = { action: "fetch", position: 2, angle: 30, item: "Glasses" };
const stopError = "I couldn't confirm the arm stopped. Switch off its power.";
const initial = useAssistant.getState();
const refusals = [
  [400, "Unknown command."], [401, "Bad token"], [409, "I'm still moving."],
  [409, "I'm already holding something. Release it or put it back first."],
  [409, "I'm waiting for you to hand something back first."], [409, "I'm not holding anything."],
  [409, "I'm already waiting for you to hand it to me."],
  [409, "I'm holding something else. Release it or put it back first."],
  [409, "I'm not waiting for the glasses right now."],
  [503, "The arm isn't connected."],
  [503, "The arm isn't calibrated yet. Teach its poses with npm run jog first."], [503, stopError],
];

function setup(t) {
  const spoken = [];
  t.mock.property(globalThis, "window", { speechSynthesis: {
    speak: (utterance) => { spoken.push(utterance.text); queueMicrotask(() => utterance.onend?.()); },
    cancel() {}, getVoices: () => [],
  } });
  t.mock.property(globalThis, "SpeechSynthesisUtterance", class { constructor(text) { this.text = text; } });
  useAssistant.setState({ ...initial, speakReplies: false });
  useAssistant.getState().setRobotMode("sim");
  useAssistant.setState({ robotMode: "robot", speakReplies: true });
  t.after(() => useAssistant.setState({ ...initial, speakReplies: false }));
  return spoken;
}

// Properties are installed before test mocks because Node only mocks existing properties.
if (!("window" in globalThis)) Object.defineProperty(globalThis, "window", { value: undefined, configurable: true });
if (!("SpeechSynthesisUtterance" in globalThis)) Object.defineProperty(globalThis, "SpeechSynthesisUtterance", { value: undefined, configurable: true });

test("every HTTP refusal and NDJSON error reaches the client as the exact bridge sentence", async (t) => {
  for (const [status, error] of refusals) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error }, { status }));
    await assert.rejects(bridgeLink.run(message, () => {}, new AbortController().signal), (e) => e instanceof BridgeError && e.message === error);
    mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => new Response('{"phase":"turning"}\n{"error":"Something went wrong moving the arm."}\n'));
  await assert.rejects(bridgeLink.run(message, () => {}, new AbortController().signal), new BridgeError("Something went wrong moving the arm."));
});

test("store speaks each bridge refusal verbatim and uses the generic line for network failures", async (t) => {
  const spoken = setup(t);
  let failure = "";
  let network = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/assistant") return Response.json(interpretKeywords(JSON.parse(options.body)));
    if (!options?.method) return Response.json({ configured: true, reachable: true });
    if (network) throw new TypeError("fetch failed");
    return Response.json({ error: failure }, { status: 503 });
  });
  for (const [, error] of refusals) {
    failure = error;
    await useAssistant.getState().ask("Bring me the glasses", "text");
    assert.equal(useAssistant.getState().line.text, error);
    assert.ok(spoken.includes(error), error);
  }
  network = true;
  await useAssistant.getState().ask("Bring me the glasses", "text");
  assert.equal(useAssistant.getState().line.text, "I couldn't reach the arm. Check the robot connection in Setup.");
});

test("Stop sends immediately, catches rejection, speaks the exact failure and never claims confirmation", async (t) => {
  const spoken = setup(t);
  const calls = [];
  let rejectStop;
  t.mock.method(globalThis, "fetch", (url, options) => {
    calls.push({ url, options });
    return new Promise((yes) => { rejectStop = () => yes(Response.json({ error: stopError }, { status: 503 })); });
  });
  useAssistant.setState({ mode: "moving", presenting: 2 });
  useAssistant.getState().stopArm();
  assert.equal(calls.length, 1, "request starts before stopArm returns");
  assert.equal(JSON.parse(calls[0].options.body).action, "stop");
  assert.equal(calls[0].options.keepalive, true);
  assert.equal(useAssistant.getState().line.text, "Stopping.");
  useAssistant.getState().stopArm();
  assert.equal(calls.length, 1, "concurrent stops share the pending confirmation");
  rejectStop();
  await sleep(10);
  assert.equal(useAssistant.getState().line.text, stopError);
  assert.equal(useAssistant.getState().health.reachable, false);
  assert.equal(useAssistant.getState().presenting, null);
  assert.ok(spoken.includes(stopError));
  assert.ok(!spoken.includes("Stopped. Tell me what to do next."));
});

test("voice stop bypasses a pending AI call; successful Stop is spoken only after confirmation", async (t) => {
  setup(t);
  const calls = [];
  let confirm;
  t.mock.method(globalThis, "fetch", (url, options) => {
    calls.push(JSON.parse(options.body));
    return new Promise((yes) => { confirm = () => yes(Response.json({ ok: true, stopped: true })); });
  });
  useAssistant.setState({ mode: "thinking" });
  await useAssistant.getState().ask("stop", "voice");
  assert.deepEqual(calls, [{ action: "stop" }]);
  assert.equal(useAssistant.getState().line.text, "Stopping.");
  confirm();
  await sleep(10);
  assert.equal(useAssistant.getState().line.text, "Stopped. Tell me what to do next.");
});

test("status recovery speaks a deadman Stop failure once and keeps holding/presenting state", async (t) => {
  const spoken = setup(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({ configured: true, reachable: false, holding: 2, presenting: null, error: stopError }));
  await useAssistant.getState().refreshHealth();
  assert.equal(useAssistant.getState().holding, 2);
  assert.equal(useAssistant.getState().presenting, null);
  assert.equal(useAssistant.getState().line.text, stopError);
  const count = spoken.filter((line) => line === stopError).length;
  await useAssistant.getState().refreshHealth();
  assert.equal(spoken.filter((line) => line === stopError).length, count);
});

test("malformed status is not trusted; relay network errors use the generic transport category", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ configured: true, reachable: true, holding: 99, presenting: "2" }));
  assert.equal((await checkRobot()).holding, undefined);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Couldn't reach the robot bridge.", network: true }, { status: 502 }));
  await assert.rejects(bridgeLink.run(message, () => {}, new AbortController().signal), (e) => !(e instanceof BridgeError));
});

test("failed Stop always speaks locally with replies muted and ElevenLabs selected, on every error path", async (t) => {
  const spoken = setup(t);
  useAssistant.setState({ speakReplies: false, engines: { stt: "browser", tts: "elevenlabs", wake: "none" } });
  let speakRequests = 0;
  let statusFailure = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url === "/api/speak") {
      speakRequests++;
      return new Promise(() => {}); // Never resolves: the warning must bypass it.
    }
    if (url === "/api/assistant") return Response.json(interpretKeywords(JSON.parse(options.body)));
    if (!options?.method) return Response.json({ configured: true, reachable: !statusFailure, holding: null, presenting: null, ...(statusFailure ? { error: stopError } : {}) });
    return Response.json({ error: stopError }, { status: 503 });
  });
  useAssistant.getState().stopArm();
  await sleep(10);
  assert.equal(spoken.filter((s) => s === stopError).length, 1, "HTTP Stop failure is spoken despite mute");
  // A subsequent ready poll clears the deduplication latch.
  await useAssistant.getState().refreshHealth();
  statusFailure = true;
  await useAssistant.getState().refreshHealth();
  assert.equal(spoken.filter((s) => s === stopError).length, 2, "deadman status warning is spoken before refresh returns");
  statusFailure = false;
  await useAssistant.getState().ask("Bring me the glasses", "text");
  assert.equal(spoken.filter((s) => s === stopError).length, 3, "motion refusal with the stop error also bypasses mute and ElevenLabs");
  assert.equal(speakRequests, 0);
});

test("lost Stop transport or invalid acknowledgement speaks the power-off warning despite muted replies", async (t) => {
  const spoken = setup(t);
  useAssistant.setState({ speakReplies: false, engines: { stt: "browser", tts: "elevenlabs", wake: "none" } });
  for (const malformed of [false, true]) {
    const mock = t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.notEqual(url, "/api/speak");
      if (!options?.method) return Response.json({ configured: true, reachable: false });
      if (malformed) return Response.json({ ok: true });
      throw new TypeError("Network unavailable");
    });
    useAssistant.getState().stopArm();
    await sleep(10);
    assert.equal(useAssistant.getState().line.text, stopError);
    mock.mock.restore();
  }
  assert.equal(spoken.filter((line) => line === stopError).length, 2);
});
