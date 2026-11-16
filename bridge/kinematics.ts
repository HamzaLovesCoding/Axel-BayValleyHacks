// Forward and inverse kinematics for Axel's 4-DOF positioning chain (yaw, shoulder, elbow, wrist
// pitch; the gripper is a separate 1-DOF jaw). Pure math: no I/O, no servo calls. See
// docs/kinematics.md for the derivation and for what is and isn't calibrated on the real arm.
//
// Frames and conventions
// - World: origin on the yaw axis at the base underside, +z up, +x where yaw = 0. Units: mm, rad.
// - Yaw ψ turns the arm plane about +z. The gripper plane sits `offset` mm to the arm's left of the
//   yaw axis (CAD: ≈8 mm), so the reach direction and the yaw angle differ by atan2(offset, r).
// - In the arm plane, r is horizontal distance from the yaw axis and h is height. θ1 (shoulder) is
//   measured from horizontal; θ2 (elbow) and θ3 (wrist) are relative to the previous link. The
//   gripper pitch is φ = θ1 + θ2 + θ3 (0 = level, negative = pointing down).

export type Geometry = {
  /** Shoulder axis height above the base underside. */
  base: number;
  /** Shoulder → elbow. */
  upper: number;
  /** Elbow → wrist. */
  fore: number;
  /** Wrist axis → grip centre (middle of the pads). */
  hand: number;
  /** Sideways offset of the gripper plane from the yaw axis, + to the arm's left. */
  offset: number;
};

/** From `Full Arm Assembly.step` (docs/arm-plan.md §1). The offset sign is still to be checked on the arm. */
export const AXEL: Geometry = { base: 95, upper: 120, fore: 120, hand: 104, offset: 8 };

export type JointAngles = { yaw: number; shoulder: number; elbow: number; wrist: number };
export type ToolPose = { x: number; y: number; z: number; pitch: number };
export type Elbow = "up" | "down";

export class Unreachable extends Error {
  override name = "Unreachable";
}

const EPS = 1e-9;
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Planar chain in the arm plane: horizontal reach r, height h and pitch φ of the grip centre. */
function planar(q: JointAngles, g: Geometry) {
  const a1 = q.shoulder;
  const a2 = a1 + q.elbow;
  const a3 = a2 + q.wrist;
  return {
    r: g.upper * Math.cos(a1) + g.fore * Math.cos(a2) + g.hand * Math.cos(a3),
    h: g.base + g.upper * Math.sin(a1) + g.fore * Math.sin(a2) + g.hand * Math.sin(a3),
    a1, a2, a3,
  };
}

/** Forward kinematics: joint angles → grip-centre position and pitch. */
export function forward(q: JointAngles, g: Geometry = AXEL): ToolPose {
  const { r, h, a3 } = planar(q, g);
  const c = Math.cos(q.yaw);
  const s = Math.sin(q.yaw);
  // Rotate (r, offset) from the arm plane into the world by ψ.
  return { x: r * c - g.offset * s, y: r * s + g.offset * c, z: h, pitch: a3 };
}

/**
 * Closed-form inverse kinematics. Decouples into yaw (with the side-offset correction), a 2-link
 * planar problem for the wrist centre (law of cosines), and the wrist angle that sets the pitch.
 * Throws Unreachable when the wrist centre is outside the annulus |L1 − L2| … L1 + L2.
 */
export function inverse(p: ToolPose, elbow: Elbow = "up", g: Geometry = AXEL): JointAngles {
  const R2 = p.x * p.x + p.y * p.y;
  if (R2 < g.offset * g.offset) throw new Unreachable("Target is inside the gripper's side-offset circle.");
  const r = Math.sqrt(R2 - g.offset * g.offset);
  // The target's bearing is ψ + atan2(offset, r), so subtract the offset's share.
  const yaw = wrapPi(Math.atan2(p.y, p.x) - Math.atan2(g.offset, r));

  // Wrist centre: step back from the grip centre along the hand by L3 at the requested pitch.
  const rw = r - g.hand * Math.cos(p.pitch);
  const hw = p.z - g.base - g.hand * Math.sin(p.pitch);
  const c2 = (rw * rw + hw * hw - g.upper ** 2 - g.fore ** 2) / (2 * g.upper * g.fore);
  if (c2 > 1 + 1e-12 || c2 < -1 - 1e-12) {
    const d = Math.hypot(rw, hw);
    throw new Unreachable(`Wrist centre ${d.toFixed(1)} mm away; reachable is ${Math.abs(g.upper - g.fore)}–${g.upper + g.fore} mm.`);
  }
  // Elbow up bends the elbow above the shoulder–wrist line: a negative relative angle.
  const e = (elbow === "up" ? -1 : 1) * Math.acos(Math.min(1, Math.max(-1, c2)));
  const shoulder = Math.atan2(hw, rw) - Math.atan2(g.fore * Math.sin(e), g.upper + g.fore * Math.cos(e));
  return { yaw, shoulder: wrapPi(shoulder), elbow: e, wrist: wrapPi(p.pitch - shoulder - e) };
}

// ---------- differential kinematics ----------

export type Matrix = number[][];

/**
 * Analytic Jacobian ∂(x, y, z, φ)/∂(ψ, θ1, θ2, θ3), 4×4. Rows are the tool-pose rates, columns the
 * joint rates. Its transpose maps a force at the grip centre to joint torques.
 */
export function jacobian(q: JointAngles, g: Geometry = AXEL): Matrix {
  const { r, a1, a2, a3 } = planar(q, g);
  const c = Math.cos(q.yaw);
  const s = Math.sin(q.yaw);
  const s1 = g.upper * Math.sin(a1), s2 = g.fore * Math.sin(a2), s3 = g.hand * Math.sin(a3);
  const c1 = g.upper * Math.cos(a1), c2 = g.fore * Math.cos(a2), c3 = g.hand * Math.cos(a3);
  const dr = [-(s1 + s2 + s3), -(s2 + s3), -s3];
  const dh = [c1 + c2 + c3, c2 + c3, c3];
  return [
    [-(r * s + g.offset * c), dr[0] * c, dr[1] * c, dr[2] * c],
    [r * c - g.offset * s, dr[0] * s, dr[1] * s, dr[2] * s],
    [0, dh[0], dh[1], dh[2]],
    [0, 1, 1, 1],
  ];
}

export const transpose = (m: Matrix): Matrix => m[0].map((_, j) => m.map((row) => row[j]));

export const multiply = (a: Matrix, b: Matrix): Matrix =>
  a.map((row) => b[0].map((_, j) => row.reduce((sum, v, k) => sum + v * b[k][j], 0)));

/** Solves A·x = b by Gaussian elimination with partial pivoting. Throws on a singular matrix. */
export function solve(a: Matrix, b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < EPS) throw new Error("Singular matrix.");
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = col + 1; row < n; row++) {
      const f = m[row][col] / m[col][col];
      for (let k = col; k <= n; k++) m[row][k] -= f * m[col][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row][n];
    for (let k = row + 1; k < n; k++) sum -= m[row][k] * x[k];
    x[row] = sum / m[row][row];
  }
  return x;
}

/** Determinant by LU elimination. */
export function determinant(a: Matrix): number {
  const m = a.map((row) => [...row]);
  const n = m.length;
  let det = 1;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < EPS) return 0;
    if (pivot !== col) { [m[col], m[pivot]] = [m[pivot], m[col]]; det = -det; }
    det *= m[col][col];
    for (let row = col + 1; row < n; row++) {
      const f = m[row][col] / m[col][col];
      for (let k = col; k < n; k++) m[row][k] -= f * m[col][k];
    }
  }
  return det;
}

/**
 * Yoshikawa manipulability √det(J·Jᵀ). For a square J this is |det J|. It falls to zero at a
 * singularity (arm fully stretched or folded), where small tool motions need huge joint motions.
 */
export const manipulability = (q: JointAngles, g: Geometry = AXEL) => Math.abs(determinant(jacobian(q, g)));

const toVector = (q: JointAngles) => [q.yaw, q.shoulder, q.elbow, q.wrist];
const fromVector = (v: number[]): JointAngles => ({ yaw: v[0], shoulder: v[1], elbow: v[2], wrist: v[3] });

/**
 * Damped-least-squares (Levenberg–Marquardt) refinement: Δq = Jᵀ(J·Jᵀ + λ²I)⁻¹·e. Stays well
 * behaved near singularities where the plain inverse blows up. Used to polish a closed-form seed
 * against a geometry that has been corrected after calibration, or to step along a path.
 */
export function refine(
  target: ToolPose,
  seed: JointAngles,
  { geometry = AXEL, damping = 5, tolerance = 1e-6, maxIterations = 100 }: { geometry?: Geometry; damping?: number; tolerance?: number; maxIterations?: number } = {},
): { joints: JointAngles; error: number; iterations: number } {
  let q = toVector(seed);
  // Pitch is in radians and position in mm; weight pitch so 1 rad counts like 100 mm.
  const W = 100;
  const residual = (v: number[]) => {
    const p = forward(fromVector(v), geometry);
    return [target.x - p.x, target.y - p.y, target.z - p.z, W * wrapPi(target.pitch - p.pitch)];
  };
  let e = residual(q);
  let error = Math.hypot(...e);
  let i = 0;
  for (; i < maxIterations && error > tolerance; i++) {
    const J = jacobian(fromVector(q), geometry);
    J[3] = J[3].map((v) => v * W);
    const Jt = transpose(J);
    const A = multiply(J, Jt).map((row, r) => row.map((v, c) => v + (r === c ? damping * damping : 0)));
    const y = solve(A, e);
    const dq = Jt.map((row) => row.reduce((sum, v, k) => sum + v * y[k], 0));
    q = q.map((v, k) => v + dq[k]);
    e = residual(q);
    error = Math.hypot(...e);
  }
  return { joints: fromVector(q), error, iterations: i };
}

// ---------- path planning ----------

/**
 * Straight-line Cartesian path: interpolates the tool pose linearly and solves IK at each step,
 * keeping one elbow branch. Refuses the path if any step is unreachable or any joint would jump
 * more than `maxStep` radians between samples (a branch flip or a pass near a singularity).
 */
export function linearPath(
  from: ToolPose,
  to: ToolPose,
  { steps = 50, elbow = "up", maxStep = 0.1, geometry = AXEL }: { steps?: number; elbow?: Elbow; maxStep?: number; geometry?: Geometry } = {},
): JointAngles[] {
  const path: JointAngles[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p: ToolPose = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      z: from.z + (to.z - from.z) * t,
      pitch: from.pitch + (to.pitch - from.pitch) * t,
    };
    const q = inverse(p, elbow, geometry);
    const prev = path.at(-1);
    if (prev) {
      const jump = Math.max(...toVector(q).map((v, k) => Math.abs(wrapPi(v - toVector(prev)[k]))));
      if (jump > maxStep) throw new Unreachable(`Joint jump of ${jump.toFixed(3)} rad at t = ${t.toFixed(2)}.`);
    }
    path.push(q);
  }
  return path;
}

// ---------- statics ----------

export const GRAVITY = 9.81;
/** MG996R datasheet stall torque at 6 V: 11 kg·cm ≈ 1.08 N·m. Real units are often weaker. */
export const MG996R_STALL_NM = 1.08;

/**
 * Joint torques (N·m) needed to hold a payload at the grip centre against gravity: τ = Jᵀ·F with
 * F = (0, 0, −m·g, 0). Covers the payload only, not the links' own weight, so it is a lower bound.
 */
export function holdingTorque(q: JointAngles, payloadKg: number, g: Geometry = AXEL): JointAngles {
  const J = jacobian(q, g);
  const Fz = -payloadKg * GRAVITY;
  // Column k of J is ∂p/∂q_k; its z entry (mm) times Fz gives N·mm. Divide by 1000 for N·m.
  const tau = [0, 1, 2, 3].map((k) => (J[2][k] * Fz) / 1000);
  return fromVector(tau.map(Math.abs));
}

// ---------- servo mapping ----------

export type ServoCalibration = Record<keyof JointAngles, { zero: number; sign: 1 | -1 }>;

const deg = (rad: number) => (rad * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/**
 * Geometric joint angles → servo degrees: servo = zero + sign · joint. `zero` is the servo reading
 * when that joint is at 0 in the frame above; both values come from per-joint calibration.
 */
export function toServo(q: JointAngles, cal: ServoCalibration): [number, number, number, number] {
  return (["yaw", "shoulder", "elbow", "wrist"] as const).map((j) => cal[j].zero + cal[j].sign * deg(q[j])) as [number, number, number, number];
}

export function fromServo(servo: readonly number[], cal: ServoCalibration): JointAngles {
  const [yaw, shoulder, elbow, wrist] = (["yaw", "shoulder", "elbow", "wrist"] as const).map((j, i) => rad((servo[i] - cal[j].zero) * cal[j].sign));
  return { yaw, shoulder, elbow, wrist };
}
