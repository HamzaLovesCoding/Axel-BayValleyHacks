# Kinematics

`bridge/kinematics.ts` models Axel's positioning chain: yaw, shoulder, elbow and wrist pitch (the
gripper is a separate jaw). It has closed-form inverse kinematics, an analytic Jacobian,
damped-least-squares refinement, straight-line path planning and a static torque check.
`bridge/kinematics.test.ts` covers all of it.

**Status, honestly:** the live demo drives the arm from **taught poses**. A person jogged the arm to
each position and saved the servo angles (`docs/tasks.md` T5). The kinematics module is implemented
and tested in software. It is **not yet wired to the real servos**, because converting geometric
joint angles to servo degrees needs each joint's zero offset and direction measured on the arm.
That calibration hasn't been done yet. See [What's next](#whats-next).

## Geometry

From `Full Arm Assembly.step` (`docs/arm-plan.md` §1), in mm:

| Symbol | Meaning | Value |
| --- | --- | --- |
| `b` | Shoulder axis above the base underside | 95 |
| `L1` | Shoulder → elbow | 120 |
| `L2` | Elbow → wrist | 120 |
| `L3` | Wrist → grip centre | ≈104 |
| `d` | Gripper plane's sideways offset from the yaw axis | ≈8 |

**Frame:**
- The origin is on the yaw axis at the base underside, with +z up.
- ψ is the yaw.
- θ1 is the shoulder angle, measured from horizontal.
- θ2 and θ3 are the elbow and wrist angles, each relative to the previous link.
- The gripper pitch is φ = θ1 + θ2 + θ3. Zero means level; negative means pointing down.

## Forward kinematics

In the arm plane, with r as the horizontal reach and h as the height:

```
r = L1·cos θ1 + L2·cos(θ1+θ2) + L3·cos(θ1+θ2+θ3)
h = b + L1·sin θ1 + L2·sin(θ1+θ2) + L3·sin(θ1+θ2+θ3)
```

Rotating the in-plane point (r, d) by ψ gives the world position:

```
x = r·cos ψ − d·sin ψ
y = r·sin ψ + d·cos ψ
z = h,   φ = θ1 + θ2 + θ3
```

## Inverse kinematics (closed form)

Given a target (x, y, z, φ):

1. **Yaw, with the offset corrected.** The target's bearing is ψ + atan2(d, r), so:
   ```
   r = √(x² + y² − d²)
   ψ = atan2(y, x) − atan2(d, r)
   ```
   Ignoring the 8 mm offset would put the gripper about 2° off at 220 mm.
2. **Wrist centre.** Step back from the grip centre along the hand:
   ```
   r_w = r − L3·cos φ
   h_w = z − b − L3·sin φ
   ```
3. **Elbow, by the law of cosines.**
   ```
   cos θ2 = (r_w² + h_w² − L1² − L2²) / (2·L1·L2)
   ```
   - If |cos θ2| > 1, the target is unreachable and the solver throws.
   - Elbow up: θ2 = −acos(…).
   - Elbow down: θ2 = +acos(…).
4. **Shoulder.**
   ```
   θ1 = atan2(h_w, r_w) − atan2(L2·sin θ2, L1 + L2·cos θ2)
   ```
5. **Wrist.** θ3 = φ − θ1 − θ2, which sets the requested pitch.

Targets behind the yaw axis have a second valid solution, with ψ + π.

## Differential kinematics

The analytic Jacobian J = ∂(x, y, z, φ)/∂(ψ, θ1, θ2, θ3) is a 4×4 matrix. With sᵢ and cᵢ standing
for the link projections Lᵢ·sin and Lᵢ·cos of the cumulative angles:

```
∂r/∂θ1 = −(s1 + s2 + s3)    ∂h/∂θ1 = c1 + c2 + c3
∂r/∂θ2 = −(s2 + s3)         ∂h/∂θ2 = c2 + c3
∂r/∂θ3 = −s3                ∂h/∂θ3 = c3
∂x/∂ψ = −y,  ∂y/∂ψ = x,  ∂x/∂θᵢ = ∂r/∂θᵢ·cos ψ,  ∂y/∂θᵢ = ∂r/∂θᵢ·sin ψ,  ∂φ/∂θᵢ = 1
```

The tests check every entry against central finite differences.

- **Manipulability.** w = √det(J·Jᵀ) = |det J| (Yoshikawa). It reaches 0 when the arm is fully
  stretched or folded. Those are singularities: a small tool motion there needs a huge joint
  motion.
- **Damped least squares (Levenberg–Marquardt).**
  ```
  Δq = Jᵀ (J·Jᵀ + λ²I)⁻¹ e
  ```
  Here e is the pose error. This update stays stable near singularities, and it refines a seed
  against a corrected geometry. Pitch is weighted so that 1 rad counts as 100 mm.
- **Straight-line paths.** The planner interpolates the tool pose, solves IK at each sample, and
  rejects the path if any step is unreachable or any joint jumps more than a threshold. That
  catches branch flips and passes near a singularity. This is the main reason to use IK at all:
  approaching a cup straight down or straight in, which taught poses can't do between their
  endpoints.

## Statics: is the shoulder strong enough?

The torque needed to hold a payload of mass m at the grip centre is τ = Jᵀ·F, with
F = (0, 0, −m·g, 0). For example, 100 g held at full horizontal reach (344 mm) needs
**0.34 N·m** at the shoulder.

The MG996R's datasheet stall torque at 6 V is about 1.08 N·m, and real units are often weaker. The
arm's own links weigh more than the payload, so this figure is a lower bound. That's why
`docs/arm-plan.md` §2 keeps the tray within about 200 mm.

## Servo mapping

```
servo° = zero + sign · joint°        (per joint)
```

`zero` is the servo reading when the joint is at 0 in the frame above. `sign` is ±1, depending on
how the servo is mounted. `toServo` and `fromServo` implement the mapping, and a test checks that
they round-trip.

## What's next

1. **Measure each joint's `zero` and `sign`.** Put the arm in two known geometric poses: links level
   and links vertical. Then read the servo angles with `npm run jog`.
2. **Check the offset sign.** Compare the yaw angle the arm needs for a known point against
   `inverse()`.
3. **Use IK for the approach only.** Keep the taught `pick` poses as endpoints, and use
   `linearPath` for a straight-down final approach. Gate it behind the same limits check
   (`resolve()`) and the 30 °/s near-person cap as every other move.
