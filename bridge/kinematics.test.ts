import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AXEL, type JointAngles, type ServoCalibration, Unreachable, determinant, forward, fromServo,
  holdingTorque, inverse, jacobian, linearPath, manipulability, refine, solve, toServo,
} from "./kinematics.ts";

const close = (a: number, b: number, tol = 1e-6, label = "") =>
  assert.ok(Math.abs(a - b) <= tol, `${label} ${a} ≉ ${b} (±${tol})`);
const closePose = (a: { x: number; y: number; z: number; pitch: number }, b: typeof a, tol = 1e-6) => {
  close(a.x, b.x, tol, "x"); close(a.y, b.y, tol, "y"); close(a.z, b.z, tol, "z"); close(a.pitch, b.pitch, tol, "pitch");
};

// Deterministic pseudo-random samples so failures reproduce.
function* samples(n: number, seed = 1) {
  let s = seed;
  const next = () => ((s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
  for (let i = 0; i < n; i++) {
    yield {
      yaw: (next() - 0.5) * Math.PI,
      shoulder: 0.2 + next() * 1.2,
      elbow: -(0.15 + next() * 2.4),
      wrist: (next() - 0.5) * 2.4,
    } satisfies JointAngles;
  }
}

test("forward: the fully stretched, level arm reaches L1 + L2 + L3 at shoulder height", () => {
  const p = forward({ yaw: 0, shoulder: 0, elbow: 0, wrist: 0 });
  closePose(p, { x: 120 + 120 + 104, y: AXEL.offset, z: AXEL.base, pitch: 0 });
});

test("forward: yaw rotates the reach and the side offset together", () => {
  const p = forward({ yaw: Math.PI / 2, shoulder: 0, elbow: 0, wrist: 0 });
  closePose(p, { x: -AXEL.offset, y: 344, z: AXEL.base, pitch: Math.PI / 2 - Math.PI / 2 });
});

test("inverse ∘ forward is the identity across the workspace (elbow up)", () => {
  for (const q of samples(500)) {
    const p = forward(q);
    const back = inverse(p, "up");
    closePose(forward(back), p, 1e-6);
    // Reaching back past the yaw axis has a second, equally valid answer with yaw + π, so only
    // targets in front of the arm must come back on the same elbow branch.
    const reach = p.x * Math.cos(q.yaw) + p.y * Math.sin(q.yaw);
    if (reach > 0) close(back.elbow, q.elbow, 1e-6, "elbow branch");
  }
});

test("both elbow branches reach the same point with mirrored elbows", () => {
  const target = { x: 180, y: 60, z: 60, pitch: -Math.PI / 4 };
  const up = inverse(target, "up");
  const down = inverse(target, "down");
  closePose(forward(up), target);
  closePose(forward(down), target);
  close(up.elbow, -down.elbow, 1e-9, "mirror");
  assert.ok(up.elbow < 0 && down.elbow > 0);
});

test("inverse refuses targets beyond reach or inside the offset circle", () => {
  assert.throws(() => inverse({ x: 400, y: 0, z: 95, pitch: 0 }), Unreachable);
  assert.throws(() => inverse({ x: 2, y: 2, z: 95, pitch: 0 }), Unreachable);
});

test("analytic Jacobian matches central finite differences", () => {
  const h = 1e-6;
  for (const q of samples(50, 7)) {
    const J = jacobian(q);
    const keys = ["yaw", "shoulder", "elbow", "wrist"] as const;
    keys.forEach((key, col) => {
      const plus = forward({ ...q, [key]: q[key] + h });
      const minus = forward({ ...q, [key]: q[key] - h });
      const fd = [(plus.x - minus.x) / (2 * h), (plus.y - minus.y) / (2 * h), (plus.z - minus.z) / (2 * h), (plus.pitch - minus.pitch) / (2 * h)];
      fd.forEach((v, row) => close(J[row][col], v, 1e-4, `J[${row}][${col}]`));
    });
  }
});

test("manipulability vanishes when the arm is stretched straight (a singularity)", () => {
  const straight = manipulability({ yaw: 0.3, shoulder: 0.4, elbow: 0, wrist: 0 });
  const bent = manipulability({ yaw: 0.3, shoulder: 0.6, elbow: -1.2, wrist: 0.2 });
  close(straight, 0, 1e-6, "straight");
  assert.ok(bent > 1000, `bent arm should be well conditioned, got ${bent}`);
});

test("linear algebra helpers: solve and determinant agree with known answers", () => {
  const A = [[4, -2, 1, 0], [3, 6, -4, 2], [2, 1, 8, -1], [1, 0, 2, 5]];
  const x = [1, -2, 3, 0.5];
  const b = A.map((row) => row.reduce((s, v, k) => s + v * x[k], 0));
  solve(A, b).forEach((v, i) => close(v, x[i], 1e-9));
  close(determinant([[2, 0], [0, 3]]), 6, 1e-12);
  close(determinant([[1, 2], [2, 4]]), 0, 1e-12);
});

test("damped least squares converges from a rough seed to the closed-form answer", () => {
  const target = forward({ yaw: 0.4, shoulder: 0.7, elbow: -1.4, wrist: -0.3 });
  const { joints, error, iterations } = refine(target, { yaw: 0.2, shoulder: 0.5, elbow: -1.0, wrist: 0 });
  assert.ok(error < 1e-6, `residual ${error}`);
  assert.ok(iterations < 100);
  closePose(forward(joints), target, 1e-5);
});

test("a straight-line approach stays on the segment and moves the joints smoothly", () => {
  const from = { x: 200, y: 40, z: 140, pitch: -Math.PI / 3 };
  const to = { x: 200, y: 40, z: 70, pitch: -Math.PI / 3 };
  const path = linearPath(from, to, { steps: 40 });
  assert.equal(path.length, 41);
  closePose(forward(path[0]), from);
  closePose(forward(path.at(-1)!), to);
  for (const [i, q] of path.entries()) {
    const p = forward(q);
    close(p.x, 200, 1e-6, `x at ${i}`);
    close(p.y, 40, 1e-6, `y at ${i}`);
  }
});

test("holding torque: 100 g at full horizontal reach loads the shoulder with m·g·reach", () => {
  const tau = holdingTorque({ yaw: 0, shoulder: 0, elbow: 0, wrist: 0 }, 0.1);
  close(tau.shoulder, 0.1 * 9.81 * 0.344, 1e-9, "shoulder");
  close(tau.elbow, 0.1 * 9.81 * 0.224, 1e-9, "elbow");
  close(tau.wrist, 0.1 * 9.81 * 0.104, 1e-9, "wrist");
  close(tau.yaw, 0, 1e-12, "yaw carries no gravity load");
});

test("servo mapping round-trips through calibration offsets and directions", () => {
  const cal: ServoCalibration = {
    yaw: { zero: 90, sign: 1 }, shoulder: { zero: 30, sign: 1 }, elbow: { zero: 160, sign: -1 }, wrist: { zero: 95, sign: -1 },
  };
  const q = { yaw: 0.25, shoulder: 0.8, elbow: -1.1, wrist: 0.4 };
  const servo = toServo(q, cal);
  const back = fromServo(servo, cal);
  for (const k of ["yaw", "shoulder", "elbow", "wrist"] as const) close(back[k], q[k], 1e-12, k);
});
