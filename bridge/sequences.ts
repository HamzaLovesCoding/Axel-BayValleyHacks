import { setTimeout as sleep } from "node:timers/promises";
import type { Phase, RobotMessage } from "../lib/robot/types.ts";
import { HANDOFF_ANGLE, REST_ANGLE } from "../lib/tray.ts";
import type { Arm } from "./arm.ts";
import { type ArmConfig, only, type Pose, resolve, withJoints } from "./config.ts";

// What each command does, step by step, and which phases it reports. The table in
// docs/contracts.md §1 is the spec; tests in sequences.test.ts hold this file to it.

export type ArmState = {
  // Tray position of the item in the gripper.
  holding: number | null;
  grip: "empty" | "closing" | "held" | "opening";
  // Waiting at the person with the gripper open for this item to be handed back.
  presenting: number | null;
  // Position unknown or unsafe (after a stop, or at start-up): run the recovery move first.
  needsRecovery: boolean;
};

export const initialState = (): ArmState => ({ holding: null, grip: "empty", presenting: null, needsRecovery: true });

// With no sensors this verifies commanded setpoints, never physical contact or arrival.
export const atHandoff = (arm: Arm, config: ArmConfig) =>
  config.poses.handoff.slice(0, 4).every((angle, j) => angle != null && Math.abs(arm.position()[j] - angle) < 0.5);

export const canRelease = (arm: Arm, config: ArmConfig, state: ArmState) =>
  (state.holding != null || state.presenting != null) && (state.needsRecovery || atHandoff(arm, config));

// A command that doesn't fit the arm's state. `status` is the HTTP status the server answers with.
export class CommandError extends Error {
  name = "CommandError";
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export type Emit = (phase: Phase, angle: number) => void;

type Context = { arm: Arm; config: ArmConfig; state: ArmState; emit: Emit; signal: AbortSignal };

// Validates an untrusted request body. Same rules as app/api/robot/route.ts.
export function parseMessage(raw: unknown): RobotMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (body.action === "release" || body.action === "stop") return { action: body.action };
  if (body.action !== "fetch" && body.action !== "return" && body.action !== "take") return null;
  const { position } = body;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 1 || position > 7) return null;
  const angle = typeof body.angle === "number" && Number.isFinite(body.angle) ? body.angle : (position - 1) * 30;
  const item = typeof body.item === "string" ? body.item.slice(0, 40) : "";
  return { action: body.action, position, angle, item };
}

const named = (item: string, fallback = "that") => item.trim().toLowerCase() || fallback;

// Refuses commands that don't fit what the arm is doing, before anything moves.
export function check(message: RobotMessage, state: ArmState): CommandError | null {
  switch (message.action) {
    case "stop":
      return null;
    case "fetch":
      if (state.holding != null) return new CommandError("I'm already holding something. Release it or put it back first.");
      if (state.presenting != null) return new CommandError("I'm waiting for you to hand something back first.");
      return null;
    case "release":
      if (state.holding == null && state.presenting == null) return new CommandError("I'm not holding anything.");
      return null;
    case "return":
      if (state.presenting != null) return new CommandError("I'm already waiting for you to hand it to me.");
      if (state.holding != null && state.holding !== message.position)
        return new CommandError("I'm holding something else. Release it or put it back first.");
      return null;
    case "take":
      if (state.presenting !== message.position)
        return new CommandError(`I'm not waiting for the ${named(message.item)} right now.`);
      return null;
  }
}

export async function runCommand(ctx: Context, message: RobotMessage): Promise<void> {
  const problem = check(message, ctx.state);
  if (problem) throw problem;
  if (message.action === "stop") return;

  const { config, state, emit } = ctx;
  const { normal, nearPerson, grasp } = config.speed;
  const { stow, carry, handoff } = config.poses;
  const move = async (pose: Pose, speed: number) => {
    ctx.signal.throwIfAborted();
    // There is no measured person exclusion zone. Cap the whole path, including crossings whose
    // endpoints are away from handoff, until calibration can establish a narrower safe boundary.
    await ctx.arm.move(resolve(pose, ctx.arm.position(), config), Math.min(speed, nearPerson));
    ctx.signal.throwIfAborted();
  };
  const pause = (ms: number) => sleep(ms, undefined, { signal: ctx.signal });
  const closeGrip = async (p: number) => {
    state.holding = p;
    state.grip = "closing";
    await move(only({ grip: config.grip[p].close }), Math.min(grasp, nearPerson));
    await pause(config.timing.gripSettleMs);
    state.grip = "held";
  };
  const openGrip = async (p: number) => {
    state.grip = "opening";
    await move(only({ grip: config.grip[p].open }), Math.min(grasp, nearPerson));
    await pause(config.timing.gripSettleMs);
    state.holding = null;
    state.grip = "empty";
  };

  if (message.action === "release" && !canRelease(ctx.arm, config, state))
    throw new CommandError("I'm not at the hand-off. Put the item back first.");

  // After a stop the arm can be anywhere, including beside the person, so recovery is slow.
  const recovered = state.needsRecovery;
  const finishingOpen = recovered && state.grip === "opening";
  // Already folded up at stow with nothing held (e.g. just after power-up): that is the clearest
  // pose there is, so "recovering" to carry would only lower the arm before it has turned.
  const atStow = stow.every((angle, j) => angle == null || Math.abs(ctx.arm.position()[j] - angle) < 0.5);
  if (recovered && atStow && state.holding == null && state.grip === "empty") state.needsRecovery = false;
  else if (recovered) {
    // Finish an interrupted grip at its original supported location before lifting or yawing.
    if (state.holding != null && state.grip === "closing") await closeGrip(state.holding);
    if (state.holding != null && state.grip === "opening") await openGrip(state.holding);
    // Lift clear before anything swings: wrist and elbow first, then the shoulder, yaw untouched.
    await move(only({ elbow: carry[2], wrist: carry[3] }), nearPerson);
    await move(only({ shoulder: carry[1] }), nearPerson);
    state.needsRecovery = false;
  }

  // `speed` is nearPerson when the arm starts at the hand-off: it stays slow until it has turned away.
  const stowAway = async (speed: number) => {
    emit("stowing", REST_ANGLE);
    await move(carry, speed);
    await move(stow, speed);
    emit("stowed", REST_ANGLE);
  };

  // Holding item `p`: take it to its spot and set it down.
  const putBack = async (p: number, angle: number) => {
    const spot = config.spots[p];
    emit("returning", angle);
    // These two start at the hand-off, beside the person.
    await move(carry, nearPerson);
    await move(only({ yaw: spot.yaw }), nearPerson);
    emit("placing", angle);
    await move(spot.above, normal);
    await move(spot.pick, grasp);
    await openGrip(p);
    await move(spot.above, grasp);
    await stowAway(normal);
  };

  switch (message.action) {
    case "fetch": {
      const p = message.position;
      const spot = config.spots[p];
      const grip = config.grip[p];
      emit("turning", message.angle);
      // Turn first, then lower: the arm only comes down once the base faces the spot. Every fetch
      // starts from stow or from recovery's carry height, never below it.
      await move(only({ yaw: spot.yaw, grip: grip.open }), normal);
      await move(carry, normal);
      emit("gripping", message.angle);
      await move(spot.above, normal);
      await move(spot.pick, grasp);
      // Once the gripper starts to close it may have the item, even if a stop comes next.
      await closeGrip(p);
      await move(spot.above, grasp);
      emit("bringing", HANDOFF_ANGLE);
      await move(carry, normal);
      // Swing at carry height, then reach out only once the base faces the person.
      await move(only({ yaw: handoff[0] }), nearPerson);
      await move(handoff, nearPerson);
      emit("holding", HANDOFF_ANGLE);
      return;
    }

    case "release": {
      if (state.presenting != null || state.holding == null) {
        // Nothing was handed back: give up waiting and put the arm away.
        state.presenting = null;
        return stowAway(nearPerson);
      }
      const p = state.holding as number;
      if (recovered) {
        // Stopped part-way with the item: never open the gripper mid-air. Take it to the person first.
        emit("bringing", HANDOFF_ANGLE);
        await move(handoff, nearPerson);
      }
      if (!atHandoff(ctx.arm, config))
        throw new CommandError("I'm not at the hand-off. Put the item back first.");
      emit("releasing", HANDOFF_ANGLE);
      await openGrip(p);
      await pause(config.timing.releaseWaitMs);
      return stowAway(nearPerson);
    }

    case "return": {
      const p = message.position;
      if (finishingOpen) return stowAway(nearPerson);
      if (state.holding === p) return putBack(p, message.angle);
      // Not holding it: the person has it. Go to them with the gripper open and wait for "take".
      emit("presenting", HANDOFF_ANGLE);
      await move(carry, normal);
      await move(withJoints(handoff, { grip: config.grip[p].open }), nearPerson);
      state.presenting = p;
      return;
    }

    case "take": {
      const p = message.position;
      emit("gripping", HANDOFF_ANGLE);
      // As in fetch: the item counts as held from the moment the gripper starts to close.
      state.presenting = null;
      await closeGrip(p);
      return putBack(p, message.angle);
    }
  }
}
