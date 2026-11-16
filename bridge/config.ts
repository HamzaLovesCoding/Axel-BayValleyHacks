import { readFile } from "node:fs/promises";

// Calibration and pose table for the arm (bridge/arm.json). Contract: docs/contracts.md §3.

export const JOINTS = ["yaw", "shoulder", "elbow", "wrist", "grip"] as const;
export type Joint = (typeof JOINTS)[number];

// Servo degrees (0–180) per joint, in JOINTS order. `null` leaves that joint where it is, so one
// `carry` pose works at whatever yaw the arm is at.
export type Pose = readonly (number | null)[];
// A pose with every joint filled in: what actually gets sent to the arm.
export type Angles = readonly number[];

export type JointConfig = { pin: number; us: readonly [number, number]; min: number; max: number };
// `taught` is per spot so a demo can use two taught spots while the rest still hold placeholders.
export type Spot = { yaw: number; above: Pose; pick: Pose; taught: boolean };
export type Grip = { open: number; close: number };

export type ArmConfig = {
  // False until every pose has been taught on the real arm. The bridge won't run commands on real
  // servos while it's false; the jog tool still works.
  taught: boolean;
  joints: Record<Joint, JointConfig>;
  speed: { normal: number; nearPerson: number; grasp: number };
  timing: { gripSettleMs: number; releaseWaitMs: number };
  poses: { stow: Pose; carry: Pose; handoff: Pose };
  spots: Record<string, Spot>;
  grip: Record<string, Grip>;
};

export const POSITIONS = [1, 2, 3, 4, 5, 6, 7] as const;

export class ConfigError extends Error {
  name = "ConfigError";
}

export async function loadConfig(path: string): Promise<ArmConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Couldn't read ${path}: ${(error as Error).message}`);
  }
  return parseConfig(raw);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function field(obj: Record<string, unknown>, key: string, at: string): Record<string, unknown> {
  const value = obj[key];
  if (!isObject(value)) throw new ConfigError(`${at}.${key} must be an object`);
  return value;
}

function number(value: unknown, at: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new ConfigError(`${at} must be a number from ${min} to ${max}`);
  return value;
}

// Which joints a pose may leave as null (`free`) and which it must leave as null (`fixed`).
type PoseRule = { mustSet?: readonly Joint[]; mustBeNull?: readonly Joint[] };

function pose(value: unknown, at: string, joints: Record<Joint, JointConfig>, rule: PoseRule = {}): Pose {
  if (!Array.isArray(value) || value.length !== JOINTS.length)
    throw new ConfigError(`${at} must be [yaw, shoulder, elbow, wrist, grip]`);
  return JOINTS.map((joint, i) => {
    const angle = value[i];
    const where = `${at}[${i}] (${joint})`;
    if (angle === null) {
      if (rule.mustSet?.includes(joint)) throw new ConfigError(`${where} can't be null`);
      return null;
    }
    if (rule.mustBeNull?.includes(joint)) throw new ConfigError(`${where} must be null`);
    const { min, max } = joints[joint];
    return number(angle, `${where}, outside the joint's limits,`, min, max);
  });
}

export function parseConfig(raw: unknown): ArmConfig {
  if (!isObject(raw)) throw new ConfigError("arm.json must be an object");
  if (typeof raw.taught !== "boolean") throw new ConfigError("taught must be true or false");

  const jointsRaw = field(raw, "joints", "arm");
  const joints = Object.fromEntries(
    JOINTS.map((joint) => {
      const j = field(jointsRaw, joint, "joints");
      const at = `joints.${joint}`;
      const us = j.us;
      if (!Array.isArray(us) || us.length !== 2) throw new ConfigError(`${at}.us must be [µs at 0°, µs at 180°]`);
      const min = number(j.min, `${at}.min`, 0, 180);
      const max = number(j.max, `${at}.max`, 0, 180);
      if (min >= max) throw new ConfigError(`${at}.min must be below max`);
      return [
        joint,
        {
          pin: number(j.pin, `${at}.pin`, 0, 69),
          us: [number(us[0], `${at}.us[0]`, 400, 2600), number(us[1], `${at}.us[1]`, 400, 2600)] as const,
          min,
          max,
        },
      ];
    }),
  ) as Record<Joint, JointConfig>;

  const speedRaw = field(raw, "speed", "arm");
  const speed = {
    normal: number(speedRaw.normal, "speed.normal", 1, 180),
    // AGENTS.md safety rule: never faster than 30 °/s beside the person.
    nearPerson: number(speedRaw.nearPerson, "speed.nearPerson", 1, 30),
    grasp: number(speedRaw.grasp, "speed.grasp", 1, 180),
  };

  const timingRaw = field(raw, "timing", "arm");
  const timing = {
    gripSettleMs: number(timingRaw.gripSettleMs, "timing.gripSettleMs", 0, 5000),
    releaseWaitMs: number(timingRaw.releaseWaitMs, "timing.releaseWaitMs", 0, 10000),
  };

  // Poses that carry an item must never touch the gripper: the item's own open/close values do.
  const posesRaw = field(raw, "poses", "arm");
  const poses = {
    stow: pose(posesRaw.stow, "poses.stow", joints, { mustSet: JOINTS }),
    carry: pose(posesRaw.carry, "poses.carry", joints, { mustSet: ["shoulder", "elbow", "wrist"], mustBeNull: ["yaw", "grip"] }),
    handoff: pose(posesRaw.handoff, "poses.handoff", joints, { mustSet: ["yaw", "shoulder", "elbow", "wrist"], mustBeNull: ["grip"] }),
  };

  const spotsRaw = field(raw, "spots", "arm");
  const gripRaw = field(raw, "grip", "arm");
  const spots: Record<string, Spot> = {};
  const grip: Record<string, Grip> = {};
  for (const p of POSITIONS) {
    const s = field(spotsRaw, String(p), "spots");
    const arm = { mustSet: ["shoulder", "elbow", "wrist"], mustBeNull: ["yaw", "grip"] } as const;
    // Missing means untaught: a spot is only fetchable on real servos once a person marks it.
    if (s.taught !== undefined && typeof s.taught !== "boolean")
      throw new ConfigError(`spots.${p}.taught must be true or false`);
    spots[p] = {
      taught: s.taught === true,
      yaw: number(s.yaw, `spots.${p}.yaw`, joints.yaw.min, joints.yaw.max),
      above: pose(s.above, `spots.${p}.above`, joints, arm),
      pick: pose(s.pick, `spots.${p}.pick`, joints, arm),
    };
    const g = field(gripRaw, String(p), "grip");
    grip[p] = {
      open: number(g.open, `grip.${p}.open`, joints.grip.min, joints.grip.max),
      close: number(g.close, `grip.${p}.close`, joints.grip.min, joints.grip.max),
    };
  }

  return { taught: raw.taught, joints, speed, timing, poses, spots, grip };
}

// A pose that only sets the given joints.
export function only(values: Partial<Record<Joint, number | null>>): Pose {
  return JOINTS.map((joint) => values[joint] ?? null);
}

// `base`, with some joints replaced.
export function withJoints(base: Pose, values: Partial<Record<Joint, number | null>>): Pose {
  return JOINTS.map((joint, i) => (joint in values ? (values[joint] ?? null) : base[i]));
}

// Fills the nulls in `target` from `current`, and refuses anything outside the joint limits. The
// firmware clamps too; this is the first of two checks.
export function resolve(target: Pose, current: Angles, config: ArmConfig): Angles {
  return JOINTS.map((joint, i) => {
    const angle = target[i] ?? current[i];
    const { min, max } = config.joints[joint];
    if (angle < min || angle > max) throw new ConfigError(`${joint} ${angle}° is outside ${min}–${max}°`);
    return angle;
  });
}
