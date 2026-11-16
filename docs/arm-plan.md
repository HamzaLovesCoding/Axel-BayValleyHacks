# Programming the arm

Plan for getting the physical arm to do what the app already asks it to do: fetch an item from a
tray spot, hold it out to the person, release it, put it back, and stop at any point. There's no
camera and no sensors. The phone handles all the understanding, so the arm is open-loop: it goes to
positions we teach it and trusts that the item is there.

Numbers marked *CAD* are measured from `Full Arm Assembly.step` (Fusion export, mm). Everything else
is an estimate and says so.

---

## 1. What the CAD shows

Five MG996R servos and no sensors. The base turns, and three pitch joints sit in one vertical plane
on top of it: a classic 4-axis arm plus a gripper.

| Joint | Servo | Axis | Where (CAD) | Notes |
| --- | --- | --- | --- | --- |
| J1 base yaw | MG996R | vertical | horn faces down into the base | 8 × V-groove 623 bearings carry the turntable, so the servo only turns it |
| J2 shoulder | MG996R | horizontal | 47 mm above the yaw horn, 95 mm above the base underside, directly over the yaw axis | carries everything; the weak joint (see §2) |
| J3 elbow | MG996R | horizontal | 120.0 mm from J2 | servo sits at the elbow |
| J4 wrist pitch | MG996R | horizontal | 120.0 mm from J3 | servo sits at the wrist |
| J5 gripper | MG996R | along the claw | on the claw | 20-tooth pinion (≈24 mm pitch Ø) between two racks: parallel jaws |

```
 base yaw J1 ─(95 mm up)─ shoulder J2 ──120── elbow J3 ──120── wrist J4 ──≈104── grip centre
```

- **Grip centre** (middle of the pads) is ≈104 mm from the wrist axis; pad tips ≈120 mm.
- **Max straight-line reach** from the yaw axis to the grip centre is ≈344 mm. Useful reach is much
  less (see torque, below).
- **The gripper plane is offset ≈8 mm sideways** from the yaw axis. That's ≈2° of yaw error at 220 mm
  if ignored. Taught poses absorb it automatically; IK has to correct for it (§6).
- **Jaw opening ≈0.42 mm per servo degree.** Each rack moves π × 24 / 360 ≈ 0.21 mm/°. In the CAD pose
  the pads are 7.6 mm apart. Each pad is 30 × 44 mm.
- **The CAD pose is folded:** shoulder 25° up, forearm folded back over the upper arm, claw pointing
  back past the base, 10° down. It reads like a stow or hand-over pose.
- Six cable clips, plus three magnet pairs that joined Base Top to Base Bottom for servo access. The
  two halves are glued now, so the magnets don't matter.

## 2. Reality check (read before buying anything)

1. **The shoulder servo is undersized, and probably the elbow too.**
   - MG996R stall torque is ≈9.4 kg·cm at 4.8 V and ≈11 kg·cm at 6 V. You want to stay under about
     half of stall continuously.
   - At full horizontal stretch, the three servos alone put ≈2.9 kg·cm on the shoulder. The printed
     links add more: the builder says the assembled arm weighs "about a binder with paper in it",
     maybe ~1 kg, so likely a lot more. Weigh it on a kitchen scale.
   - A 100 g item adds ≈3.4. A full cup of water (≈250–350 g, the heaviest thing on the list) adds
     ≈9–12.
   - Result: anything beyond light items at moderate reach will sag, stall or cook the shoulder.
   - **First test, before any code:** power the arm at 6 V, hold it straight out level, and see if
     the shoulder holds without buzzing or sagging. Then try it holding a full cup.
   - **Fix:** swap J2 and J3 for DS3218 servos (≈20 kg·cm). They're the same standard size, so they
     should drop into the same pockets (check the horn spline).
   - **Free alternatives:** keep the tray close (grip centre ≤ ~200 mm from the yaw axis), keep items
     light, and pick hold poses near vertical.
2. **Open-loop analog servos are repeatable to a few mm, not better.**
   - Deadband is ~1–2°. At 220 mm, 1° of yaw is ≈4 mm.
   - Loose small things (keys, a pill bottle on its side) on a flat tray will miss often.
   - Give every spot a holder that presents the item upright in the same place. The builder is fine
     with cardboard trays, so start there: a pocket per spot, sized to its item.
3. **"Put it back" for an item the person already took: decided, they hand it back.** The arm
   presents an open gripper and waits. The person puts the item in and says "go", and only then does
   the gripper close, slowly. See the `take` flow in §9.
4. **The gripper will stall-squeeze if told to close fully.** An MG996R holding against an item draws
   stall current and heats up. Close each item to its own taught angle, just past contact.
5. **The servos can drive the arm into itself.** The horns were set so every joint reaches its full
   mechanical range, so the servos' travel goes past the point where parts collide.
   - Find each joint's collision limits by jogging slowly (§7), then compile them into the firmware.
   - A stalled MG996R gets hot within seconds.
   - The fold-over was checked by hand, so the poses themselves are reachable.
6. **Cups must stay level.** The gripper's pitch is shoulder + elbow + wrist. Synchronized moves (§5)
   change all three in step, so a move between two level poses stays level the whole way.
   - So: teach every pose used while holding a cup level.
   - Never move the shoulder or elbow alone while holding a cup; yaw alone is fine.

## 3. Architecture

```
phone ──HTTPS──▶ Next app /api/robot ──HTTP──▶ bridge (Node) ──USB serial──▶ microcontroller ──PWM──▶ 5 servos
                 (exists)                       poses, sequences,            smooth motion,
                                                phases, stop                 limits, watchdog
```

The HTTP contract between the app and the bridge already exists (README → Robot bridge) and doesn't
change. The work is the two boxes on the right.

- **The microcontroller is a dumb, safe joint server.** It moves joints smoothly to targets, enforces
  hard limits, freezes on stop, and freezes if the computer goes quiet. It knows nothing about items.
- **The bridge is where the intelligence lives.** It holds the pose table and the per-action sequences,
  and streams phases back to the app. It's JavaScript, so it's quick to change, and it reuses
  `scripts/mock-bridge.mjs`.

**Fast path (recommended):**
- An Arduino Uno or Nano drives the servos directly with the built-in `Servo.h`.
- The bridge runs on the same laptop as the Next app; `ROBOT_BRIDGE_URL=http://localhost:8787`.
- Later, moving everything to a Raspberry Pi is just plugging the same USB cable into the Pi.

**Standalone alternative:**
- An ESP32 runs the bridge's HTTP server itself over Wi-Fi. No computer needed next to the arm.
- But the sequencing moves into C++, which is slower to iterate on. Worth it only once poses are
  settled.

**One new dependency:** `serialport` (npm). It's the standard Node serial library, with native
prebuilt binaries. Node has no serial port built in.
- *Alternative:* write the bridge in Python with `pyserial` instead.
- *Alternative:* go ESP32-only and skip serial entirely.

## 4. Electrical

- **Servo power:** 6 V, 10 A supply (UBEC or buck converter), separate from the Arduino.
  - Five MG996Rs can pull >10 A together at stall, and ≈1–1.5 A each while moving.
  - Never power servos from the Arduino's 5 V pin.
- **Common ground** between the servo supply and the Arduino. Put a ≥1000 µF capacitor across the
  servo rail.
- **Hard e-stop:** a latching switch in series with the servo supply, within the person's reach.
  - Cutting power makes the arm sag, so it's the last resort.
  - The normal stop is the soft one (app, Esc, voice), which freezes in place.
- **Optional:** a physical "freeze" button on an Arduino input. It does the same as the app's Stop,
  with no phone needed.
- **Optional later:** a PCA9685 servo board, for cleaner PWM and an output-enable pin to control
  power-up. Not needed for 5 servos.
- **Power-up snap:** with no feedback, a servo jumps to its first commanded position at full speed.
  - Always finish in the stow pose before powering off, so the jump on power-up is tiny.
  - Firmware attaches servos one at a time, 300 ms apart, which also avoids a current spike.

## 5. Firmware (Arduino, `firmware/axel-arm/axel-arm.ino`)

Line-based ASCII over USB serial at 115200 baud. Angles are in servo degrees (0–180), so the
firmware stays ignorant of geometry.

| Host → arm | Meaning | Arm → host |
| --- | --- | --- |
| `M a1 a2 a3 a4 a5 v` | Move all joints to these angles; the joint with the farthest to go peaks at `v` °/s, and all arrive together | `OK` now, `DONE` on arrival |
| `S` | Stop: freeze at the current setpoint | `STOPPED` |
| `P` | Where are you? | `POS a1 a2 a3 a4 a5` |
| `H` | Heartbeat (bridge sends every 200 ms while moving) | — |
| `A` / `D` | Attach (staggered) / detach servos | `OK` |
| (on boot) | — | `READY` |

**Motion:**
- Interpolate the setpoint at 50 Hz with an ease-in/ease-out curve (smoothstep), never jumping.
  Duration is `ceil(1500 × farthest joint distance / speed)` milliseconds: the 1.5 factor accounts
  for smoothstep's peak slope, so speed means peak °/s. Firmware and DryArm use the same timing.
- The commanded setpoint *is* the position estimate. That's honest enough at ≤60 °/s, because the
  servo keeps up.

**Safety in firmware (defence in depth, the bridge checks too):**
- Refuse the entire move with `ERR limit <joint>` if any target exceeds its compiled `min`/`max`.
- No heartbeat for 500 ms during a move: stop and report `STOPPED watchdog`.
- Ignore malformed lines and reply `ERR …`. Never move on a half-parsed line.

## 6. Bridge (Node, `bridge/`)

Start from `scripts/mock-bridge.mjs` and keep its HTTP contract exactly. Swap its fake timings for
real moves.

- `bridge/arm.json`: the calibration and pose table (format below).
- `bridge/arm.mjs`: serial link, `moveTo(pose, speed)` that resolves on `DONE`, and `stop()`.
- `bridge/sequences.mjs`: one function per action that emits the app's phases.
- `bridge/jog.mjs`: CLI for calibration and teaching (§7).
- `--dry-run` flag: no serial; it logs targets instead, so the whole app is testable with the arm
  unplugged.

**Key on `position`, not `angle`.** The app's 30° spacing is a display convention; the real yaw for
each spot comes from `arm.json`.

```json
{
  "joints": {
    "yaw":      { "pin": 3, "us": [500, 2500], "min": 0,  "max": 180 },
    "shoulder": { "pin": 5, "us": [500, 2500], "min": 15, "max": 165 },
    "elbow":    { "pin": 6, "us": [500, 2500], "min": 10, "max": 170 },
    "wrist":    { "pin": 9, "us": [500, 2500], "min": 0,  "max": 180 },
    "grip":     { "pin": 10, "us": [500, 2500], "min": 20, "max": 150 }
  },
  "speed": { "normal": 60, "near_person": 30, "grasp": 25 }, // peak °/s
  "poses": {
    "stow":    [90, 0, 0, 0, null],
    "carry":   [null, 0, 0, 0, null],
    "handoff": [90, 0, 0, 0, null],
  },
  "spots": {
    "1": { "yaw": 0, "above": [null, 0, 0, 0, null], "pick": [null, 0, 0, 0, null] },
    "...": {}
  },
  "items": { "1": { "open": 120, "close": 70 } }
}
```

- Pose values are placeholders until taught.
- `null` means "leave this joint where it is", so one `carry` pose works at any yaw.
- Items differ in height (a cup is taller than a pill box), so each spot gets its own `above` and
  `pick`. That's 14 poses to teach, about two minutes each with the jog tool.

**Sequences** (phase lines are exactly what the app already understands):

| Action | Steps → phases emitted |
| --- | --- |
| `fetch(p)` | `turning`: grip → `open`, move to `carry` at the spot's yaw · `gripping`: `above` → `pick` (grasp speed) → grip → `close`, wait 300 ms → `above` · `bringing` (angle 270): `carry` → `handoff` (near-person speed) · `holding`: end the response, keep holding |
| `release` | `releasing`: grip → `open`, wait 800 ms · `stowing` (angle 90): `handoff` → `carry` → `stow` · `stowed` |
| `return(p)` while holding | `returning`: `handoff` → `carry` at the spot's yaw · `placing`: `above` → `pick` → `open` → `above` · `stowing` → `stowed` |
| `return(p)` not holding | `presenting` (angle 270): `carry` → `handoff`, grip → the item's `open`. End the response; the arm waits there |
| `take(p)` | `gripping`: grip → `close` at grasp speed, wait 300 ms · then the same as `return(p)` while holding |
| `stop` | Firmware `S`. The in-flight `/command` response closes. State is `stopped` |

**State and edge cases:**
- **One move at a time.** A second `/command` while moving gets 409 `{"error":"Busy"}`; `stop`
  always gets through.
- **After a stop, recover before anything else:** raise the wrist and elbow first, then the shoulder,
  to reach `carry`. Only then yaw. The arm must never swing across the tray low.
- **The bridge tracks its own `holding`** and refuses `fetch` while holding, matching the app's
  `check()`.
- **`GET /status` returns 200 only when** serial is up and the firmware has said `READY`.

**IK (later, optional).** Teach poses first; they're faster and absorb every measurement error. Add
IK when you want straight-line approaches or spots that don't sit on a ring. Planar, with `r` the
horizontal distance from the yaw axis and `h` the height above the shoulder:
```
L1 = L2 = 120, L3 ≈ 104, φ = gripper pitch (0 = level)
yaw  = spot_angle + asin(8 / R)          // 8 mm side offset, R = distance to target (sign: check on the arm)
r    = √(R² − 8²)
rw = r − L3·cosφ ;  hw = h − L3·sinφ
c3 = (rw² + hw² − L1² − L2²) / (2·L1·L2) ;  θ3 = −acos(c3)            // elbow up
θ2 = atan2(hw, rw) − atan2(L2·sinθ3, L1 + L2·cosθ3)
θ4 = φ − θ2 − θ3
servo_deg = offset ± joint_deg            // per joint, from calibration
```
Unit-test it with `node --test` (no dependency).

## 7. Calibration and teaching

Order matters: horns go on *after* the servos are calibrated.

1. **Bench each servo alone** before it goes in the arm.
   - Sweep pulses to find the real end stops (MG996Rs vary between ~120° and ~180°).
   - Write `us` for each joint.
2. **Find collision limits.** The horns are already on, set for full range, so instead:
   - Jog each joint slowly, 2° at a time, until it's about 5° short of touching anything.
   - Record that as its `min`/`max`, checking with the other joints in their extreme poses too.
   - Compile the limits into the firmware.
3. **`node bridge/jog.mjs`:** arrow keys or `j2 +5` move one joint slowly. `save carry` writes the
   current angles into `arm.json`.
4. **Teach** `stow`, `carry`, `handoff`, `above`, `pick`.
   - Teach the yaw for spots 1–7.
   - Teach `open`/`close` per item: close until the pads just touch, then 3–5° more.
5. **Dry runs, in this order:**
   - Every sequence with an empty gripper, at half speed.
   - Then with a foam stand-in for each item.
   - Then the real items.
6. **Re-check after any crash or stall.** A slipped horn moves every pose.

## 8. Milestones

Rough effort is in evenings. The fast path through M4 gets a working demo.

| | Milestone | Done when | Effort |
| --- | --- | --- | --- |
| M0 | Parts: 6 V/10 A supply, Arduino, e-stop, capacitor. DS3218 × 2 if you take §2.1 | on the bench | 1 |
| M1 | Firmware v0: one servo, `M` and `S` over serial | a servo sweeps from the Serial Monitor | 1 |
| M2 | Firmware v1: all 5 joints, synced easing, limits, watchdog | unplugging USB mid-move freezes the arm | 1–2 |
| M3 | Bridge: serial + jog CLI + `arm.json` + real sequences + `--dry-run` | the app runs end to end in dry run | 2–3 |
| M4 | Calibrate, teach, first real fetch → release → return | 10 fetches in a row without a miss | 2 |
| M5 | Hardening: stop in every phase, recovery move, power-up routine, error text in the app | stop works mid-way through every phase | 1–2 |
| M6 | Optional: IK, move to Pi or ESP32, feedback upgrade, calibration screen in the app | — | — |

## 9. Changes to the app

- **Return of handed-over items (decided: hand it back):**
  - Add a `presenting` phase and a `take` action to `lib/robot/types.ts`, the relay route and the
    store.
  - After `presenting`, the app says "Put the glasses in my hand and say go". "Go", "ok" or a tap on
    the You tile sends `take`.
- **Dial layout:** the app draws the tray as a half circle with You at the bottom. The real layout has
  the arm beside the person with the items in front of them.
  - It's display only (the bridge uses taught poses), so leave it until the spots are taught.
  - Then redraw it from the real yaw angles.
- **Status reconciliation:** have `GET /status` return `{"holding":2}` so the app recovers its state
  after a reload or a bridge restart.
- **Show bridge error text:** today the app only says "I couldn't reach the arm".
- **Calibration screen (optional):** the jog tool as a Setup page, later.

## 10. Answers from the builder (2026-11-15) and what's still open

| Question | Answer | What it changes |
| --- | --- | --- |
| Controller | Arduino Uno or ESP32 | Use the Uno for the fast path (§3). Keep the ESP32 for standalone later |
| Tray | A circle; items stand at different heights | Each spot gets its own `above`/`pick` (§6) |
| Layout | Arm to the left or right of the person, items in front of them | Hand-off is to the side; the app's dial is only a picture (§9) |
| Items | Glasses, cups of water, pill boxes | A cup is the heaviest item and must stay level (§2.1, §2.6) |
| Holders | Loose now; cardboard trays are fine | Make them (§2.2) |
| Putting back | Person hands it back to the gripper | `presenting` + `take` (§6, §9) |
| Magnets | Glued now, ignore | — |
| Fold-over | Checked by hand, works | Teach it as is |
| Horns | Set for full range before collision | Soft limits in firmware are a must (§2.5) |
| Built? | Assembled, about a binder's weight | Run the torque test first (§2.1) |

**Still open:**
1. **Exact servo models.** The CAD says MG996R for all five, but the builder says the arm has about
   270° of motion. A standard MG996R turns about 180°, so check the label on the base servo. A 270°
   servo changes its pulse calibration, not the plan.
2. **Power under load.** Has the arm been powered and moved yet, and from what supply?

## 11. Cup-level recovery — decision required

**No recovery-order change is implemented.** After Stop/startup, pitch recovery remains wrist and
elbow first, then shoulder, and only then yaw. A partially completed grip settles at its original
location before those arm-joint moves. This does not establish that a cup stays level.

Section 2.6's level-endpoint argument applies only to synchronized pitch joints with measured
servo directions and joint-to-pitch offsets. Staged recovery changes the shoulder separately and
can tilt a cup. Raw servo-degree sums are not physical pitch when some servos are reversed.
Slowing recovery reduces speed but does not prevent spilling. With no sensors, neither commanded
setpoints nor a completed close confirms the cup was gripped or remained upright.

| Option | Benefit | Cost / limitation | Change needed |
| --- | --- | --- | --- |
| Keep staged recovery; exclude open liquid cups and use light, sealed containers | Keeps the existing clearance rule and offers a practical first demo | Does not promise level transport; a lid does not solve grip slip or shoulder overload | Explicit operating policy and measured T5 tests; no recovery-order change |
| Operator-assisted recovery after any Stop with a cup | Avoids autonomously tilting an uncertain load | Requires a helper; does not meet independent cup-recovery acceptance | A future explicit cup-recovery interlock and operator procedure, approved before coding |
| Passive self-leveling cup holder / gimbal | Could keep the container upright without altering joint order | Added mass, reach, clearance and swinging; must re-check torque and grips | Mechanical redesign and new physical calibration/tests |
| Synchronized pitch compensation or a planned level recovery path | Could support independent level recovery | Requires measured sign/offset geometry, collision-safe paths and ideally feedback; may violate the current staged-order rule | New reviewed safety contract and physical evidence; do not implement under the current rule |

**Recommendation for your decision:** keep the staged order, use lightweight non-liquid objects
or sealed containers for initial testing, and defer open-water cups. If independent open-cup use
is required, choose and validate a mechanical leveling or planned-path design separately. An
operator-assisted cup recovery interlock is the conservative interim software option, but needs
an explicit item classification and approved operator acknowledgement flow before implementation.
None of these options is treated as accepted merely because it is documented here.

Until a cup policy is chosen, do not start loaded open-cup recovery trials. If a cup is already in
the stopped gripper, do not send release/return/fetch to experiment: have a helper support both the
container and every loaded link, use the accessible power cutoff if required, and disengage/remove
the load only after power is off and the links cannot fall. Restart using T5's alignment procedure;
no autonomous movement is justified by this documentation. The physical handling details must be
confirmed by the builder for this actual mechanism.

**Evidence needed before any cup acceptance:** measured servo signs/offsets, load/torque margin,
collision clearance over the entire recovery path, cup pitch throughout the path, grip stability,
and Stop/restart tests in every phase. Fake-arm tests prove order and speed only. The retained-order
regression in `bridge/sequences.test.ts` protects wrist/elbow → shoulder → yaw while preserving grip.
