# Software readiness audit — follow-up review, 2026-11-15

This records the fixes and evidence in the **whole working folder**, including untracked files.
No commit or push was made. Existing unrelated UI/voice edits and staged files were preserved.
This is not approval to operate the assembled arm: calibration, loaded recovery and physical
acceptance remain pending. No real serial port was opened and no hardware was touched.

## Final checks

| Check | Observed result |
| --- | --- |
| `npm test` | Passed: **66 bridge/voice/jog + 27 app/access/wake/tunnel = 93 tests** after the movement review below |
| `npm run typecheck` | Passed for app and bridge |
| `npm run lint` | Passed |
| `npm run build` | Passed on Next 16.4.5 |
| `git diff --check` | Passed |
| Uno compile | `arduino-cli compile --fqbn arduino:avr:uno --warnings more --clean firmware/axel-arm` passed without warnings; 7,200 flash bytes, 442 global RAM bytes |
| Firmware host regression | Passed with `-Wall -Wextra -Werror -fsanitize=address,undefined`, fake clock/serial/servos |
| Safety config integrity | `bridge/arm.json` and `firmware/axel-arm/config.h` unchanged during this follow-up; taught remains false; no limits or pulse calibration widened |

Next emits an informational warning about ignoring `/Users/hamza/package-lock.json` outside this
repository. It does not fail the build. No dependency was added. The Arduino toolchain, TypeScript
compiler and Chrome were already installed. Tests use DryArm or fakes only.

## Finding results

The numbered findings 1–4 below refer to the original numbered list saved in this audit. No separate
Fable review document was available in the folder; any other numbered review needs its actual text.

| Finding | Result | Regression evidence |
| --- | --- | --- |
| #6 Release after Stop / interrupted grip | Fixed in software | `bridge/sequences.test.ts`: interrupted fetch/take close retains holding, refuses another fetch, completes close in place, then recovers before opening only at handoff; interrupted opening completes at the supported location; known non-handoff release refuses all motion |
| #6 App Release state | Fixed in software | `tests/hand-back.test.mjs`: status reconciliation and stale pre-Stop poll rejection. `scripts/browser-check.mjs`: actual Release chip and dial tile follow bridge canRelease |
| #8 Failed-stop warning | Fixed in software | `tests/bridge-errors.test.mjs`: HTTP Stop, status/deadman and command refusal force the exact browser warning despite reply mute/ElevenLabs; lost transport and invalid acknowledgement use the same warning; no `/api/speak` request |
| Near-person speed / original finding 1 | Fixed conservatively | `bridge/sequences.test.ts`: all-action matrix with nearPerson=12, grasp=80 and overlapping handoff/spot yaw, plus config boundaries. `bridge/jog.test.ts`: jog and optional stow respect nearPerson=8 |
| #7 Wake lock | Fixed in software; physical phone check pending | `tests/wake-lock.test.mjs`: motion/holding/presenting with Hands-free off, revocation/foreground reacquisition, duplicate/pending cleanup and denial; browser script verifies real component wiring using a fake sentinel |
| #9 Reversed servo pulses | Fixed in software; bench pending | `firmware/tests/firmware-test.cpp`: forward/reverse endpoints, midpoint, tenth-degree sweep and widest supported span; warning-free Uno compile |
| Original finding 2 / cup-level recovery | Decision pending; no recovery-order change | `docs/arm-plan.md` §11 options/recommendation. Sequence regression preserves wrist/elbow → shoulder → yaw and grip; it does not prove level cups |
| Original finding 3 / live voice and physical acceptance | Still partly open | Prior recorded Sarah voice success is retained; not repeated in this follow-up. Physical iPhone audio/mic/wake, serial/servo, torque, calibration, cups and ten-cycle results are still required |
| Original finding 4 / public development access | Software guard fixed; private passcode is configured | `tests/tunnel.test.mjs`: absent passcode, stale open server, wrong gate/redirect and failed checks never launch cloudflared. Existing access tests and final authenticated production browser check pass |

All autonomous sequence segments use min(requested, nearPerson), and jog uses min(20, nearPerson).
No measured person exclusion zone exists, so this deliberately slows tray paths and crossings too;
configuration values remain unchanged. Faster operation needs a separately approved measured zone.

Grip state is a conservative command estimate, not sensor feedback. A completed close does not
prove an object is held, and atHandoff proves commanded setpoints only. Release after Stop may move
the arm through recovery before opening; its availability does not mean it is already at handoff.

## Runtime evidence

The final `scripts/browser-check.mjs` run uses an isolated production app on localhost:3102 and an
actual `npm run bridge:dry -- --port 18787 --time-scale 0.01` process. The script verifies dry-run
mode before sending any motion. The test app uses only a public test passcode; provider keys are
disabled in its environment. No `.env.local` credentials were printed or changed.

Verified in Chrome at **375 × 812**:

- Wrong/right passcode, redirect back to the requested page, password-manager field and httpOnly
  cookie hidden from JavaScript; dark/light login, landscape at 200% root text and reduced motion.
- Simulator and HTTP DryArm hand-back through typed commands, real button/tile clicks and injected
  speech-recognition transcripts; presentation and holding reconcile after reload.
- Release chip disappears and the dial Release tile disables when status denies release; both
  recover when the bridge permits it. This status branch is injected over a real DryArm response.
- Movement and presentation request a wake lock with Hands-free off; idle stow releases it. The
  browser API is replaced with a recording fake to verify wiring without claiming a physical lock.
- HTTP DryArm Stop button and Esc; no runtime exceptions or horizontal overflow.

The browser test proves routing, rendering and state. Injected speech and fake speechSynthesis/wake
locks do not prove microphone accuracy, audible output, iPhone permissions, actual lock prevention
or latency. Browsers may deny/revoke wake locks: see the
[Screen Wake Lock API documentation](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API).
No live speech provider request or public tunnel was needed for this follow-up. The earlier audit's
HTTPS DryArm tunnel evidence remains historical, not a new test against hardware.

Screenshots: `/tmp/axel-review-passcode.png` and `/tmp/axel-review-passcode-dark.png`.
Owned QA servers/browser are stopped after verification; existing user services are left alone.

## Every task's completion gate

| Task | What is proven | What remains before its full done-when is met |
| --- | --- | --- |
| T0 — torque/weighing | Procedure exists; T5 alignment precedes any coupled powered test | Actual weight, supported shoulder hold/sag/buzz checks and loaded capacity decision |
| T2 — firmware | Uno compile and hardware-free parser/motion/attach/watchdog checks pass | Entire horns-off Serial Monitor checklist and physical freeze observations; no bench results received |
| T3 — serial | Fake-stream handshake, limits, timing, heartbeats, replacement, Stop, watchdog/drop and failed-Stop/deadman integration pass | Real USB connection, serial-mode /status and loose-servo stop/replace/full check results |
| T4 — jog | Interactive raw-terminal dry-run and automated CLI checks; all pose/grip/yaw saves, JSON layout, atomic validation, undo, limits and Stop paths tested using temporary copies | Software gate met; physical calibration belongs to T5 |
| T5 — teach | Safe first-power-up procedure documented; jog tool ready | Physical support/power state confirmation, horns disengaged, real pulse endpoints, matching collision limits, T0, every pose/grip, level cup paths, empty/stand-in/real-item trials, ten cycles and Stop/recovery in every phase |
| T6 — Whisper | User reports it done; code present, installed whisper-server running and wake parser regressions pass | No independent record here of iPhone HTTPS transcription, ~1.5 s target or real browser fallback measurement; reconfirm in phone checklist |
| T7 — ElevenLabs | Current timestamp/Flash docs checked; route/client and fake-audio timing, cancellation, replacement and fallback regressions pass; cost line written | The 402 came from a library voice on the free plan. Switched to the built-in Sarah voice: live `/api/speak` now returns 200 with audio and word timings. iPhone first-tap playback, timing and fallback must still be observed |
| T8 — wake | User reports it done; Whisper wake wiring and phrase regressions exist; off by default | No independent phone evidence here for actual wake recognition, bare Stop, self-voice suppression or screen wake lock |
| T9 — hand-back/sync | Full software flow passes in simulator and real HTTP DryArm, by typing, tapping and injected speech recognition; holding/presenting/busy reconcile; Stop invalidates late model answers | Real microphone/device repetition remains; live model interpretation was not exercised by the keyword-mode browser run |
| T10 — errors | Every bridge refusal and streamed sentence reaches the app and fake speaker verbatim; failed Stop caught, no premature “Stopped”; voice/button/Esc share stopArm; status recovers deadman errors | Actual audible phone confirmation; physical Stop remains T2/T3/T5 |
| T11 — running it | README has installs, model download, three services, gate checks, HTTPS tunnel and staged iPhone procedure; production DryArm tunnel verified | Fresh-clone iPhone-to-real-arm run cannot be proven until hardware/T5 and phone results arrive |
| T12 — passcode | Signed 30-day httpOnly cookie, whole-route Proxy gate, rotation/expiry/forgery/origin checks, login limiter, development warning and production fail-closed tests pass; production browser/tunnel checks pass | A private APP_PASSCODE is now configured (presence checked without printing its value). Restart Next after changes; the tunnel launcher verifies the running gate. The isolated test server used a public test placeholder |

There is no T1 entry in the current task queue. T6/T8 retain their user-reported done status; missing
independent evidence is distinguished above from an observed failure.

## Remaining decisions and physical work

- Choose a cup recovery policy from arm-plan §11. Recommendation: keep staged clearance, use light
  non-liquid items or sealed containers for initial testing, and defer open-water cups. No alternate
  recovery/interlock is enabled without approval.
- Repeat T2's explicit **Review #9 horns-off checklist**, then T3 timed Stop/replacement/full moves.
  Report actual replies and shaft behaviour; software results do not substitute for this.
- Complete T5 alignment, torque/weighing, measured pulses/limits, taught poses/grips, supported
  empty/stand-in/item trials, ten cycles and Stop during every phase, including grip-close/open.
- On the iPhone with HTTPS and passcode: first-tap speech, muted-reply failed-Stop warning, microphone
  and Hey Axel/bare Stop, playback/highlight timing, wake lock with Hands-free off while presenting,
  touch Stop, reload and dropped-connection behaviour.

There is no T1 in the task queue. No hardware gate is marked complete without the person's results.

## First-connection preparation

Read-only `npm run preflight` passes on this laptop: tools/dependencies, private passcode presence,
local bridge/Whisper URLs, installed model, and matching firmware/bridge pins, pulses, limits and
STOW. README now uses the installed Whisper model path. docs/first-connection.md provides the
staged USB/upload/bench/jog procedure. No port was opened or firmware uploaded; hardware gates
remain pending. The optional loopback bridge token is unset. No secrets were changed or printed.

## Movement review — 2026-11-15

Found and reproduced a rejected-replacement failure with a fake stream: firmware can reject a new
M while continuing the old move, but SerialArm previously stayed ready with an invalid position
estimate. Every firmware ERR now invalidates/closes the link, rejects pending operations and stops
heartbeats. There is no automatic retry. Two regression tests cover rejected replacement, no further
M/H, HTTP 503 and recovery required. The first regression failed before the fix and passes after it.

Expanded the firmware host tests with 24 profiles: speeds 1, 7, 25, 30, 60 and 180, each with full
travel in both directions, small mixed-direction travel and no movement. At each 20 ms update they
check synchronized progress, monotonicity, endpoint bounds, emitted pulses and the commanded speed
bound, followed by exact arrival. These execute the actual sketch with fake clock/serial/servos;
they do not measure physical motion, current, acceleration or load capacity.

Re-ran npm test (93 pass), typecheck, lint, preflight and the host firmware suite with
`-Wall -Wextra -Werror -fsanitize=address,undefined`. Uno compile with `--warnings more --clean`
passes without warnings (7,200 flash bytes, 442 global RAM bytes). No firmware runtime behavior,
joint limits, pulse calibration, poses or taught flag changed in this review. No serial device
was opened, no hardware operated, no dependency added and no commit made.

Smoothstep starts and ends an ordinary move at zero commanded velocity. It does not bound physical
jerk or preserve acceleration through Stop/replacement; immediate Stop deliberately interrupts the
curve. Source-level tests cannot prevent jitter from power problems, resets, backlash, overload or
unmeasured collisions. Startup/reattachment can jump to stored angles without position feedback.
The existing T2 Review #9 horns-off and T3 stop/replace/full checklists still require physical
results before T5 alignment, limits, poses and loaded testing. Open-liquid cup recovery remains
blocked on the documented policy decision.

Restart is not recovery for a loaded arm: grip state is in memory and is lost on process restart,
and opening serial can reset the Uno. After a serial fault, support/unload with power off and use
the aligned empty-gripper startup procedure; never automatically reconnect and resume a held item.

## Fable follow-up — spoken stop, Settings Stop, boot order — 2026-11-15

The "findings 1–4" above were read as this audit's own list. Fable's review (given in chat, not saved
in the folder) numbered them differently; its 1–4 and their state:

| Fable finding | Result | Regression evidence |
| --- | --- | --- |
| 1. Leaves the hand-off at 60 °/s | Fixed (row "Near-person speed" above) | `bridge/sequences.test.ts` speed matrix |
| 2. Boot/reconnect attaches yaw first | Fixed in firmware: attach order is wrist, elbow, shoulder, yaw, grip. The snap itself remains; bench pending | `firmware/tests/firmware-test.cpp` boot asserts on `ATTACH_ORDER` |
| 3. No Stop on Settings; Esc only on two screens | Fixed: Stop bar on Settings while moving, one global Esc listener that also cancels "thinking" | `tests/stop-ear.test.mjs` (Stop bar); live browser check (Esc) |
| 4. Spoken "stop" needed Hands-free and Whisper | Fixed in software; **not heard on a phone** | `tests/stop-ear.test.mjs`: ear rules, self-voice guard, browser recogniser restart/shut-off |

Finding 4 is logic-tested only. Unknown until tried on the iPhone: whether Safari lets the browser
recogniser start without a tap, whether it mutes or ducks the browser voice, and whether the open mic
makes replies quiet. If it misbehaves, the fallback is to require Hands-free in Robot mode.

Still open from that review: a silently dropped connection does not stop the arm (the deadman needs a
closed socket; a phone heartbeat would change the contract on three layers), and the login limiter is
one global bucket.

Checks after this follow-up: `npm test` 98 pass (66 bridge + 32 app), typecheck, lint and build pass.
