import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Phase, RobotMessage } from "../lib/robot/types.ts";
import { DryArm, StoppedError } from "./arm.ts";
import { ConfigError, loadConfig, parseConfig, resolve } from "./config.ts";
import { type ArmState, CommandError, initialState, parseMessage, runCommand } from "./sequences.ts";

const fixture = fileURLToPath(new URL("./fixtures/test-arm.json", import.meta.url));
const config = await loadConfig(fixture);
const stow = resolve(config.poses.stow, [], config);
const handoff = resolve(config.poses.handoff, stow, config);

function rig({ state = initialState(), timeScale = 0.001, start = stow }: { state?: ArmState; timeScale?: number; start?: readonly number[] } = {}) {
  const arm = new DryArm(start, { timeScale });
  const phases: Phase[] = [];
  const controller = new AbortController();
  const run = (message: RobotMessage) =>
    runCommand({ arm, config, state, signal: controller.signal, emit: (phase) => phases.push(phase) }, message);
  return { arm, phases, state, run, controller };
}

const item = (action: "fetch" | "return" | "take", position = 2): RobotMessage => ({
  action,
  position,
  angle: (position - 1) * 30,
  item: "Glasses",
});

const near = (a: readonly number[], b: readonly number[]) => a.every((v, i) => Math.abs(v - b[i]) < 0.5);

test("fetch brings the item to the person and holds it", async () => {
  const { arm, phases, state, run } = rig();
  await run(item("fetch"));
  assert.deepEqual(phases, ["turning", "gripping", "bringing", "holding"]);
  assert.equal(state.holding, 2);
  assert.ok(near(arm.position().slice(0, 4), handoff.slice(0, 4)), "ends at the hand-off pose");
  assert.equal(arm.position()[4], config.grip[2].close, "gripper still closed on the item");
});

test("release lets go and stows", async () => {
  const { arm, phases, state, run } = rig();
  await run(item("fetch"));
  phases.length = 0;
  await run({ action: "release" });
  assert.deepEqual(phases, ["releasing", "stowing", "stowed"]);
  assert.equal(state.holding, null);
  assert.ok(near(arm.position(), stow));
});

test("return while holding puts it back on its spot", async () => {
  const { arm, phases, state, run } = rig();
  await run(item("fetch", 5));
  phases.length = 0;
  await run(item("return", 5));
  assert.deepEqual(phases, ["returning", "placing", "stowing", "stowed"]);
  assert.equal(state.holding, null);
  // The gripper opened at the spot's own yaw.
  const opened = arm.history.find((m) => m.target[4] === config.grip[5].open && m.target[0] === config.spots[5].yaw);
  assert.ok(opened, "opened the gripper over spot 5");
});

test("return with an empty gripper presents, then take puts it back", async () => {
  const { phases, state, run } = rig();
  await run(item("return", 3));
  assert.deepEqual(phases, ["presenting"]);
  assert.equal(state.presenting, 3);
  phases.length = 0;
  await run(item("take", 3));
  assert.deepEqual(phases, ["gripping", "returning", "placing", "stowing", "stowed"]);
  assert.equal(state.presenting, null);
  assert.equal(state.holding, null);
});

test("release while presenting gives up and stows", async () => {
  const { phases, state, run } = rig();
  await run(item("return", 3));
  phases.length = 0;
  await run({ action: "release" });
  assert.deepEqual(phases, ["stowing", "stowed"]);
  assert.equal(state.presenting, null);
});

test("commands that don't fit the arm's state are refused before anything moves", async () => {
  const { arm, run } = rig();
  await assert.rejects(run({ action: "release" }), CommandError);
  await assert.rejects(run(item("take", 4)), CommandError);
  assert.equal(arm.history.length, 0, "nothing moved");

  await run(item("fetch", 1));
  await assert.rejects(run(item("fetch", 2)), (e: unknown) => e instanceof CommandError && e.status === 409);
  await assert.rejects(run(item("return", 2)), CommandError, "holding a different item");
});

test("recovering from anywhere but stow lifts wrist and elbow, then the shoulder, before any yaw", async () => {
  const start = [stow[0], 80, 70, 70, stow[4]];
  const { arm, run } = rig({ start });
  await run(item("fetch", 7));
  const [first, second] = arm.history;
  const carry = config.poses.carry;
  assert.deepEqual(first.target, [start[0], start[1], carry[2], carry[3], start[4]]);
  assert.deepEqual(second.target, [start[0], carry[1], carry[2], carry[3], start[4]]);
});

test("a fetch turns the base before it lowers, both to the spot and to the person", async () => {
  // Start-up at stow is already the clearest pose, so it skips recovery and turns first.
  const { arm, run } = rig();
  await run(item("fetch", 7));
  const spotYaw = config.spots[7].yaw;
  const [turn, lower] = arm.history;
  assert.deepEqual(turn.target.slice(1, 4), stow.slice(1, 4), "arm stays folded up while turning");
  assert.equal(turn.target[0], spotYaw);
  assert.equal(lower.target[0], spotYaw, "lowering happens at the spot's yaw");
  const swing = arm.history.findIndex((m) => m.target[0] === config.poses.handoff[0]);
  assert.deepEqual(arm.history[swing].target.slice(1, 4), config.poses.carry.slice(1, 4), "swing at carry height");
  assert.deepEqual(arm.history.at(-1)!.target.slice(0, 4), config.poses.handoff.slice(0, 4));
});

test("a stop mid-move rejects and leaves the arm needing recovery", async () => {
  // Start already recovered, so the check below can't depend on how long recovery takes.
  const { arm, run, controller, state } = rig({ state: { ...initialState(), needsRecovery: false }, timeScale: 0.05 });
  const moving = run(item("fetch"));
  await new Promise((r) => setTimeout(r, 30));
  controller.abort();
  await arm.stop();
  await assert.rejects(moving, (e: unknown) => e instanceof StoppedError || (e as Error).name === "AbortError");
  assert.equal(state.needsRecovery, false, "the sequence itself doesn't set it; the server does on stop");
});

test("config validation catches poses that would move the gripper or break limits", () => {
  const raw = structuredClone(JSON.parse(JSON.stringify(config)));
  raw.poses.carry[4] = 90;
  assert.throws(() => parseConfig(raw), ConfigError);

  const raw2 = structuredClone(JSON.parse(JSON.stringify(config)));
  raw2.joints.shoulder.max = 100;
  raw2.poses.stow[1] = 120;
  assert.throws(() => parseConfig(raw2), /outside the joint's limits/);
});

test("parseMessage accepts the contract and nothing else", () => {
  assert.deepEqual(parseMessage({ action: "take", position: 2, angle: 30, item: "Glasses" }), {
    action: "take",
    position: 2,
    angle: 30,
    item: "Glasses",
  });
  assert.equal(parseMessage({ action: "fetch", position: 8 }), null);
  assert.equal(parseMessage({ action: "dance" }), null);
  assert.deepEqual(parseMessage({ action: "stop", position: 3 }), { action: "stop" });
});

test("every move that starts at the hand-off, and all of recovery, stays at near-person speed", async () => {
  const { arm, run } = rig();
  await run(item("fetch"));
  for (const next of [{ action: "release" } as const, item("return")]) {
    const before = arm.history.length;
    const from = arm.position()[0];
    await run(next);
    // Until the yaw has turned away from the hand-off, nothing may exceed nearPerson.
    for (const move of arm.history.slice(before)) {
      assert.ok(move.speed <= config.speed.nearPerson, `left the hand-off at ${move.speed}`);
      if (move.target[0] !== from) break;
    }
    if (next.action === "release") await run(item("fetch"));
  }
  const fresh = rig();
  await fresh.run(item("fetch"));
  assert.ok(fresh.arm.history.slice(0, 2).every((m) => m.speed <= config.speed.nearPerson), "recovery is slow");
});

test("release after a stop takes the item to the person before opening the gripper", async () => {
  const { arm, phases, state, run } = rig();
  await run(item("fetch"));
  await run(item("return")).catch(() => {});
  // As the server does on Stop, part-way back to the tray with the item still held.
  state.holding = 2;
  state.needsRecovery = true;
  phases.length = 0;
  const before = arm.history.length;
  await run({ action: "release" });
  assert.deepEqual(phases, ["bringing", "releasing", "stowing", "stowed"]);
  const opened = arm.history.slice(before).find((m) => m.target[4] === config.grip[2].open);
  assert.ok(opened && near(opened.target.slice(0, 4), handoff.slice(0, 4)), "opened only at the hand-off pose");
});

test("near-person speed above 30 °/s is refused", () => {
  const raw = structuredClone(JSON.parse(JSON.stringify(config)));
  raw.speed.nearPerson = 31;
  assert.throws(() => parseConfig(raw), ConfigError);
});

test("release refuses a known non-handoff pose before any motion", async () => {
  const { arm, run } = rig({ state: { ...initialState(), holding: 2, grip: "held", needsRecovery: false } });
  await assert.rejects(run({ action: "release" }), /not at the hand-off/);
  assert.equal(arm.history.length, 0);
});

test("Stop during fetch or take close retains the item and finishes grip in place before recovery", async () => {
  for (const action of ["fetch", "take"] as const) {
    const state = initialState();
    const arm = new DryArm(stow, { timeScale: 0 });
    const run = (command: RobotMessage) => runCommand({ arm, config, state, signal: new AbortController().signal, emit: () => {} }, command);
    if (action === "take") await run(item("return"));
    const original = arm.move.bind(arm);
    let interrupted = false;
    let interruptedAt: readonly number[] = [];
    arm.move = async (target, speed) => {
      if (!interrupted && state.grip === "closing") {
        interrupted = true;
        await original(target.map((v, j) => j === 4 ? (v + arm.position()[4]) / 2 : v), speed);
        interruptedAt = arm.position();
        state.needsRecovery = true;
        throw new StoppedError();
      }
      return original(target, speed);
    };
    await assert.rejects(run(item(action)), StoppedError);
    assert.equal(state.holding, 2);
    assert.equal(state.grip, "closing");
    await assert.rejects(run(item("fetch", 3)), /already holding/);
    const before = arm.history.length;
    await run({ action: "release" });
    const recovery = arm.history.slice(before);
    assert.deepEqual(recovery[0].target.slice(0, 4), interruptedAt.slice(0, 4), "finish close without lifting");
    assert.equal(recovery[0].target[4], config.grip[2].close);
    assert.ok(recovery[0].speed <= config.speed.nearPerson);
    const opened = recovery.find((m) => m.target[4] === config.grip[2].open);
    assert.ok(opened && near(opened.target.slice(0, 4), handoff.slice(0, 4)));
    assert.equal(state.grip, "empty");
  }
});

test("interrupted opening finishes at the supported location before recovery", async () => {
  const state = { ...initialState(), holding: 2, grip: "opening" as const };
  const start = resolve(config.spots[2].pick, [config.spots[2].yaw, ...stow.slice(1)], config);
  const arm = new DryArm(start, { timeScale: 0 });
  await runCommand({ arm, config, state, signal: new AbortController().signal, emit: () => {} }, item("return"));
  assert.deepEqual(arm.history[0].target.slice(0, 4), start.slice(0, 4));
  assert.equal(arm.history[0].target[4], config.grip[2].open);
  assert.equal(state.holding, null);
  assert.equal(state.presenting, null, "does not start a new hand-back after finishing the interrupted placement");
});

test("all autonomous paths obey nearPerson even with faster grasp, overlapping yaw and interrupted recovery", async () => {
  const slow = structuredClone(config);
  slow.speed.nearPerson = 12;
  slow.speed.grasp = 80;
  slow.spots[2].yaw = handoff[0];
  const arm = new DryArm(stow, { timeScale: 0 });
  const state = initialState();
  const run = (message: RobotMessage) => runCommand({ arm, config: slow, state, signal: new AbortController().signal, emit: () => {} }, message);
  await run(item("fetch"));
  await run({ action: "release" });
  await run(item("return"));
  await run(item("take"));
  await run(item("fetch"));
  state.needsRecovery = true;
  await run(item("return"));
  await run(item("return"));
  await run({ action: "release" });
  await run(item("fetch"));
  state.needsRecovery = true;
  await run({ action: "release" });
  assert.ok(arm.history.length > 40, "covers recovery, stowAway, putBack, release, return and take");
  for (const move of arm.history) assert.ok(move.speed <= 12, `unsafe speed ${move.speed}`);
  for (const invalid of [30.01, 31, 180, Infinity, NaN, 0]) {
    assert.throws(() => parseConfig({ ...config, speed: { ...config.speed, nearPerson: invalid } }), /speed.nearPerson/);
  }
  assert.equal(parseConfig({ ...config, speed: { ...config.speed, nearPerson: 30 } }).speed.nearPerson, 30);
});

test("held-load recovery preserves wrist/elbow then shoulder then yaw without opening the grip", async () => {
  const start = [45, 95, 75, 80, config.grip[2].close];
  const arm = new DryArm(start, { timeScale: 0 });
  const state: ArmState = { ...initialState(), holding: 2, grip: "held" };
  await runCommand({ arm, config, state, signal: new AbortController().signal, emit: () => {} }, item("return"));
  const [first, second] = arm.history;
  assert.deepEqual(first.target, [45, 95, config.poses.carry[2], config.poses.carry[3], start[4]]);
  assert.deepEqual(second.target, [45, config.poses.carry[1], config.poses.carry[2], config.poses.carry[3], start[4]]);
  const yaw = arm.history.findIndex((move) => move.target[0] !== 45);
  assert.ok(yaw >= 2);
  assert.ok(arm.history.slice(0, yaw + 1).every((move) => move.target[4] === start[4]));
});
