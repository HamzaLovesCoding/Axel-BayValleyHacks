import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Arm, DryArm } from "./arm.ts";
import { loadConfig, resolve } from "./config.ts";
import { createBridge } from "./server.ts";

const config = await loadConfig(fileURLToPath(new URL("./fixtures/test-arm.json", import.meta.url)));
const stow = resolve(config.poses.stow, [], config);
const open: { close: () => void }[] = [];
after(() => open.forEach((s) => s.close()));

async function start(options: { arm?: Arm; token?: string; taught?: boolean; timeScale?: number; untaught?: number[] } = {}) {
  const arm = options.arm ?? new DryArm(stow, { timeScale: options.timeScale ?? 0.002 });
  const spots = Object.fromEntries(Object.entries(config.spots).map(([p, spot]) =>
    [p, { ...spot, taught: !options.untaught?.includes(Number(p)) }]));
  const bridge = createBridge({ arm, config: { ...config, spots, taught: options.taught ?? config.taught }, token: options.token });
  await new Promise<void>((resolve) => bridge.server.listen(0, resolve));
  open.push(bridge.server);
  const url = `http://127.0.0.1:${(bridge.server.address() as AddressInfo).port}`;
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}/command`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { ...bridge, url, send };
}

const lines = async (res: Response) =>
  (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase?: string; angle?: number; error?: string });

const fetchGlasses = { action: "fetch", position: 2, angle: 30, item: "Glasses" };

test("streams one NDJSON line per phase, with display angles", async () => {
  const { send, url } = await start();
  const res = await send(fetchGlasses);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/x-ndjson");
  assert.deepEqual(await lines(res), [
    { phase: "turning", angle: 30 },
    { phase: "gripping", angle: 30 },
    { phase: "bringing", angle: 270 },
    { phase: "holding", angle: 270 },
  ]);
  const status = (await (await fetch(`${url}/status`)).json()) as { holding: number | null; busy: boolean };
  assert.equal(status.holding, 2);
  assert.equal(status.busy, false);
});

test("a second command while moving gets 409; stop always gets through", async () => {
  const { send, state } = await start({ timeScale: 0.05 });
  const first = send(fetchGlasses);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal((await send({ action: "release" })).status, 409);

  const stop = await send({ action: "stop" });
  assert.deepEqual(await stop.json(), { ok: true, stopped: true });
  const streamed = await lines(await first);
  assert.ok(!streamed.some((l) => l.phase === "holding"), "the fetch never finished");
  assert.equal(state.needsRecovery, true);
});

test("refusals come back as JSON errors before anything moves", async () => {
  const { send } = await start();
  const res = await send({ action: "release" });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /not holding/);
  assert.equal((await send({ action: "fetch", position: 9 })).status, 400);
});

test("the token is required when one is set", async () => {
  const { send } = await start({ token: "secret" });
  assert.equal((await send(fetchGlasses)).status, 401);
  assert.equal((await send(fetchGlasses, { authorization: "Bearer secret" })).status, 200);
});

test("real servos refuse to move until the poses are taught", async () => {
  const fakeSerial: Arm = {
    mode: "serial",
    ready: () => true,
    position: () => stow,
    move: async () => {},
    stop: async () => {},
    close: async () => {},
  };
  const { send } = await start({ arm: fakeSerial, taught: false });
  const res = await send(fetchGlasses);
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: string }).error, /calibrated/);
});

test("real servos refuse an untaught spot even when the arm is marked taught", async () => {
  const moves: unknown[] = [];
  const fakeSerial: Arm = {
    mode: "serial", ready: () => true, position: () => stow,
    move: async (target) => { moves.push(target); },
    stop: async () => {}, close: async () => {},
  };
  const { send, url } = await start({ arm: fakeSerial, taught: true, untaught: [2, 3, 4, 5, 6, 7] });
  const status = (await (await fetch(`${url}/status`)).json()) as { taughtSpots: number[] };
  assert.deepEqual(status.taughtSpots, [1]);
  for (const action of ["fetch", "return", "take"]) {
    const res = await send({ ...fetchGlasses, action });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /haven't learned that spot/);
  }
  assert.equal(moves.length, 0, "no motion before the refusal");
});

test("the dry-run arm still serves every spot, taught or not", async () => {
  const { send } = await start({ untaught: [1, 2, 3, 4, 5, 6, 7] });
  const res = await send(fetchGlasses);
  assert.equal(res.status, 200);
  assert.ok((await lines(res)).some((line) => line.phase === "holding"));
});

test("failed stop and failed cleanup latch not-ready even if a driver still claims ready", async () => {
  const arm: Arm = {
    mode: "serial", ready: () => true, position: () => stow,
    move: async () => {},
    stop: async () => { throw new Error("Stop failed"); },
    close: async () => { throw new Error("Close failed"); },
  };
  const { send, url, state, stop } = await start({ arm, taught: true });
  state.needsRecovery = false;
  const response = await send({ action: "stop" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "I couldn't confirm the arm stopped. Switch off its power." });
  assert.equal(state.needsRecovery, true);
  assert.equal((await fetch(`${url}/status`)).status, 503);
  assert.equal((await send(fetchGlasses)).status, 503);
  assert.equal(await stop(), false, "shutdown callers also receive a handled failure");
});
