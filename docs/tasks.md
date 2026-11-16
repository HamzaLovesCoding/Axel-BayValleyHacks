# Tasks

The work queue for programming the arm and the voice. Each task names its files, what "done" means,
and what it depends on.

Read first: `AGENTS.md` (rules), `docs/contracts.md` (every boundary), `docs/arm-plan.md` (why).
Search the code for `TODO(Tn)` to find each task's exact spots.

Current evidence and unresolved acceptance gates: [software readiness audit](software-audit.md).
Follow-up review: 93 automated tests, typecheck and lint pass. Earlier production build and phone-width
Simulator/DryArm checks pass. Hardware and iPhone acceptance remain separate; cup policy awaits a decision.

```
Hardware path:  T0 → T2 → T3 → T4 → T5 → T11
Voice path:     T6 → T8,  T7
App path:       T9, T10, T12   (any order, no hardware needed)
```

## Already done (the framework)

- **Contracts**
  - `docs/contracts.md`.
  - `lib/robot/types.ts` gained the `presenting` phase and the `take` action.
  - The relay route accepts `take`.
- **Bridge** (`bridge/`)
  - HTTP server, sequences for every action, the stop/deadman/busy rules, and config loading and
    validation.
  - `DryArm`, a pretend arm with real timing.
  - Tests for all of it (`npm test`).
  - Run it with `npm run bridge:dry`.
- **Firmware** (`firmware/axel-arm/`): motion, parser, nonblocking attachment and watchdog implemented.
  Host regression checks pass; the T2 horns-off bench checklist below still needs a person.
- **Voice seams**
  - `GET /api/voice` reports which engines are set up.
  - The phone uses Whisper and ElevenLabs when they're available and falls back to the browser
    otherwise.
  - T6 Whisper input and T8 "Hey Axel" are done (user-reported); see contracts §4.
  - T7 ElevenLabs output remains in the queue.

---

## T0. Torque test and weighing (a person, not code)

**Blocks:** T5.

The shoulder servo is probably undersized (arm-plan §2.1). Before either powered test below,
complete T5's first-power-up alignment procedure: do not power builder-fitted links against the
placeholder STOW. Before anyone teaches poses:

1. Weigh the arm on a kitchen scale.
2. Power the shoulder at 6 V and hold the arm straight out level. Does it hold without buzzing or
   sagging?
3. Repeat holding a full cup of water.

If it fails, swap the shoulder (and probably the elbow) for DS3218s before going on, or keep the tray
close and items light.

## T2. Firmware

**Files:** `firmware/axel-arm/axel-arm.ino`, `config.h`.

Firmware implements contracts §2:
- `handleMove`: parsing, `_` for "leave alone", limit refusal, synchronized duration, replace-not-queue.
- `tick`: smoothstep, `DONE`.
- `watchdog`.

Keep it allocation-free. The Uno has 2 KB of RAM: no `String`, and `F()` for every literal.

**Done when:**
- It compiles for `arduino:avr:uno` with no warnings.
- Hardware-free regression checks in `firmware/tests/` pass (commands in README → Firmware).
  Movement review adds 24 profiles checking synchronized, monotonic, bounded setpoints at 50 Hz,
  including minimum/maximum protocol speed and no-op moves. This does not prove physical smoothness.
- This bench checklist passes in the Arduino IDE Serial Monitor (115200 baud, **Newline**),
  with all servo **horns off**, a separate 6 V servo supply, and common ground. Never power the
  servos from the Uno's 5 V pin. Keep the servo power switch accessible.
  1. With servo power off, upload the sketch to the Uno, then enable the servo supply and reset
     the Uno. Boot must print `READY 0.1.0` only after all five staggered attachments (about 1.2 s).
     Watch the loose servos twitch as each attaches: the order must be wrist, elbow, shoulder, yaw,
     grip.
     Send `L`: expect `LIM 0 180 0 180 0 180 0 180 0 180` for the current placeholder limits.
     Send `P`: expect `POS 90 145 60 90 100` (the builder's measured start pose).
  2. Send `M 90 110 40 90 90 60`: expect `OK`, then `DONE` in about 250–270 ms, before the watchdog.
     Send `P`: expect `POS 90 110 40 90 90`.
  3. Send `M _ _ _ _ 100 60`: expect `OK`, then `DONE` in about 250–270 ms. Only the gripper moves.
     Send `P`: expect `POS 90 110 40 90 100`.
  4. Send each separately: `M 181 110 40 90 100 60` → `ERR limit 1`;
     `M 1 2` → `ERR parse`; `M 90 110 40 90 100 60 extra` → `ERR parse`;
     `S extra`, `P extra`, `L extra`, `H extra`, `A extra`, `D extra` → `ERR parse` each.
     `P` must still report `POS 90 110 40 90 100`.
     Send this single overflowing line: expect one `ERR parse`, no motion. Send `P` to confirm
     unchanged position.
     ```text
     xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxM 0 0 0 0 0 60
     ```
  5. Send `M 120 120 30 90 90 10`, then send **nothing**: expect `OK`, then `STOPPED watchdog`
     about 500 ms after the command, without `DONE`. `P` must remain fixed on repeated queries.
     Reset the Uno and wait for `READY` again.
  6. Send `D` → `OK`, then `A` and immediately `S` before attachment finishes: expect `STOPPED`
     without waiting for all attachments; no later `OK` from the cancelled `A`. `P` must respond.
     Send `A` again: expect `OK` only when all five are attached. There is no second `READY`.
- Timed mid-move Stop and replacement checks have moved to T3's script; they cannot be entered
  reliably by hand in Serial Monitor. Full-length moves use T3 heartbeats. No watchdog exemption.

The limits and pulse widths are still placeholders until T5; these checks use horns off only.

**Review #9 — re-run after flashing the signed pulse calculation (horns off):**
1. Servo power off; physically disengage every horn/link, use separate 6 V and common ground.
   Upload the newly compiled sketch, power loose servos and reset. Re-run T2 step 1: staggered
   wrist/elbow/shoulder/yaw/grip, one READY, `L`, and `P` with the expected values above.
2. Re-run T2 steps 2–3 exactly: `M 90 110 40 90 90 60`, then `M _ _ _ _ 100 60`.
   Confirm smooth direction, approximately 250 ms completion, and exact `P` values.
3. Re-run T2 step 4's malformed/limit/overflow commands and unchanged `P`.
4. Re-run T2 step 5: `M 120 120 30 90 90 10`, send nothing, observe `STOPPED watchdog`
   and a physically fixed shaft. Reset and wait for READY.
5. Re-run T2 step 6's detach/attach/Stop/resume; outputs must stop attaching immediately on `S`.
6. Close Serial Monitor, then run T3's `--check stop`, `--check replace`, `--check full` commands
   below, one at a time with `--loose-servos`; record replies and physical observations.
7. If a joint already has measured reversed pulse endpoints, repeat the same small permitted
   angle move and verify physical direction against those endpoints. Current endpoints are all
   forward; do not reverse or extend unmeasured calibration just for this check. Reversed numeric
   interpolation is covered by host regression; physical reversed calibration belongs to T5.

Send the actual replies and observations before any assembled-arm test. No bench result is assumed.

## T3. Serial link in the bridge

**Files:** `bridge/serial-arm.ts`, `bridge/serial-arm.test.ts`, `bridge/bench-serial.ts`.

Implement `SerialArm` to the comments in the file and contracts §2.
- **Dependency:** `serialport`, plus its readline parser.
  - *Cost:* a native module with prebuilt binaries for macOS, Linux and the Pi.
  - *Alternatives:* a Python bridge with `pyserial`, or an ESP32-only build with no serial.
  - Tell the user before adding it.
- **For testing,** take the stream as a constructor argument: `open(path)` wraps the real port, and
  tests pass a fake duplex stream that plays the firmware's side.

**Done when:**
- `npm test` covers these against the fake: `OK`/`DONE` resolves; `ERR` rejects; `STOPPED` rejects
  with `StoppedError`; heartbeats every 200 ms during a move and none when idle; a limit mismatch at
  connect refuses to start; a port drop rejects the pending move and `ready()` turns false.
- Review: a firmware `ERR`, including a rejected replacement while an old move may still run,
  closes the link and prevents further motion/heartbeats. Fake HTTP tests verify 503 and recovery
  required. Reconnect only after supported unloading and aligned empty-gripper startup; process
  restart loses grip state and is not a loaded-recovery procedure.
- `npm run bridge -- --serial <port>` connects to the T2 firmware, and `GET /status` reports
  `mode: "serial"`.

**Results on the assembled arm, 2026-11-15:** the builder's own sweep tests had already proved the
wiring and mounting, and they chose to skip the horns-off stage. Config now matches their wiring
(elbow 9, wrist 6), Servo.write()'s 544–2400 µs scale and their measured start pose
90/145/60/90/100 (arm straight up, gripper open). `--check stop`, `replace` and `full` passed on the
Uno. A one-joint-at-a-time 25° wiggle at 20 °/s moved base, shoulder, elbow, wrist and gripper
correctly. Limits are still the 0–180 placeholders; measure them in T5.

**Loose-servo bench checks (a person; physical results still pending):**

Close Serial Monitor first; only one program may own the port. Use the T2 firmware, a separate
6 V servo supply and common ground, with horns off or links fully disconnected. **Never run this
script on an assembled arm**, even if its builder already fitted the horns. Opening serial may
reset the Uno and jump every servo to the placeholder STOW. The script requires `--loose-servos`.
It changes yaw by 10° at peak 10 °/s, choosing the direction within the existing limits.

From the repo root, replace the example port with the Uno's actual port:

```bash
node bridge/bench-serial.ts --loose-servos --serial /dev/tty.usbmodem14101 --check stop
node bridge/bench-serial.ts --loose-servos --serial /dev/tty.usbmodem14101 --check replace
node bridge/bench-serial.ts --loose-servos --serial /dev/tty.usbmodem14101 --check full
```

1. `stop`: sends a long `M`, then `S` after 200 ms. Expect `OK`, `STOPPED`, then `POS`; the loose
   servo must freeze promptly. There must be no `DONE` for the stopped move.
2. `replace`: sends a long `M`, then an `M` back to its starting angles after 200 ms. Expect two
   `OK` replies and one `DONE` for the replacement, with no position jump on the loose servo.
3. `full`: lets the whole 10° move finish (about 1.5 s). Expect `H` every 200 ms in the outgoing
   log and then `DONE`, without a watchdog stop. Every check logs all replies with timestamps;
   cleanup adds `S`, `STOPPED`, `P`, `POS` before closing the port.
4. Space, Esc, Ctrl+C, typing `stop`, or SIGTERM interrupts and stops. The script also serves the
   existing HTTP Stop route on `127.0.0.1:8787` (same optional `ROBOT_BRIDGE_TOKEN`); app/voice Stop
   can reach it through the usual Next relay. Stop ends the bench run. Use `--port` if needed.
   The HTTP interface refuses other motion commands. A port drop ends the run and stops heartbeats;
   firmware must freeze within 500 ms. Do not unplug USB if it also powers the Uno: a reset or loss
   of controller power can make servos sag or snap, which is not a watchdog test.
5. With the bench script exited, run `npm run bridge -- --serial /dev/tty.usbmodem14101`.
   In another terminal run `curl http://localhost:8787/status` (add the Bearer token if configured).
   Expect HTTP 200, `mode: "serial"`, `taught: false`. Fetch remains refused until T5. Stop with
   Ctrl+C. Real port connection and this HTTP check still need the person's results.

## T4. Jog tool

**Status:** Implemented and checked without hardware. Raw terminal `npm run jog -- --dry-run`
and automated CLI checks use temporary config copies. Physical calibration remains T5.

**Files:** `bridge/jog.ts`, `bridge/jog.test.ts`.

Build it to the spec in the file's header comment. It reuses `loadConfig`, `DryArm`/`SerialArm` and
`resolve`.

**Done when:**
- `npm run jog -- --dry-run` works end to end.
- Saving a pose updates `bridge/arm.json` in place, keeping its layout, and the file still passes
  `loadConfig`.
- Space stops the arm at once.
- It never writes `taught: true`.

Autonomous sequences conservatively cap every move at nearPerson (≤30 °/s), including a grasp
configured faster than nearPerson. Regression tests cover every sequence and overlapping spot/handoff
yaw; measured person-zone clearance remains T5 before any future faster-path policy.

The tool uses min(20, nearPerson) peak °/s with no motion queue. At startup/after Stop, manually clear wrist/elbow,
then type `clear` + Enter; clear shoulder, then `clear` + Enter again before yaw. These are operator
clearance confirmations, not automatic moves to placeholder poses. Only jog with an empty gripper.
Space, Esc, typed `stop`, Ctrl+C, terminal closure and signals stop; app/voice Stop uses the Stop-only
HTTP interface on `127.0.0.1:8787` (optional bridge token). Other HTTP motion is refused, even in
`--dry-run`; that safety interface reports mode `serial`. `--port` selects a different port.

Press `s`, then enter the pose name (`s carry`, `s above 2`, `s open 2`, etc.). `l yaw min` records the
current angle as a tighter limit; no widening or bypass is allowed, including through undo. Existing
poses must still validate, or the entire save is refused. After a limit save, motion is disabled:
update config.h, compile/reflash from supported stow, reconnect and verify matching `L` first.
Space remains a command separator while also triggering Stop. Quit asks before recovery to carry
(wrist/elbow, shoulder) and stow. Answer `yes` only after T5 has verified those poses; otherwise `no`
quits holding the current setpoint. No automatic stow on EOF/signals/Stop.

## T5. Calibrate and teach (a person, with an agent driving the jog tool)

**Depends on:** T0, T2, T3, T4. Follow arm-plan §7.

**Before first power-up of the assembled arm (builder-fitted horns):**

The builder already fitted horns for broad travel. Firmware STOW is still a placeholder, not a
verified physical pose. Do not energize the assembled links or open/reset serial with them coupled
until this procedure is complete. A startup jump ignores the commanded motion speed.

1. Disconnect both USB and servo power. Support every link and gripper so nothing drops; keep the
   work area clear and the servo power cutoff accessible. Photograph/mark the existing horn positions.
2. Remove each horn from its spline, or mechanically disconnect each driven link. Merely loosening
   the retaining screw is **not** enough: an engaged spline still transmits full servo torque. If a
   horn cannot be disengaged without disassembly, stop and have the builder expose it first.
3. With outputs unloaded, connect the separate 6 V supply and common ground, then power/reset the Uno.
   Wait for `READY`; use `P` to verify the current STOW angles. Calibrate each loose servo's pulse
   widths first, then update both config.h and arm.json and recompile/reflash while still uncoupled.
4. Power the loose servos at STOW again with the calibrated firmware. Confirm the expected direction
   and angle on each shaft. Mark these shaft indices. Switch off servo and USB power; keep the
   shafts at those indices. Never fit horns or put fingers near a powered joint.
5. With all links supported, position them in a compact, collision-free candidate stow pose and refit
   the horns at the marked shaft indices without turning the shafts. The actual geometry cannot be
   inferred from the placeholder numbers: have the builder confirm clearance for every link and
   gripper. If the splines cannot match that pose, keep everything uncoupled, choose appropriate
   STOW angles in both config.h and arm.json, and repeat the unloaded alignment. Do not guess or
   widen limits. If the shaft index was lost while fitting, disengage and repeat.
6. Clear hands, support the arm without obstructing movement, and power up from this matching stow
   pose with the cutoff ready. Stop/cut power on any unexpected motion or buzzing. Cutting servo
   power removes holding torque, so the links must be supported. No person sits in the hand-off area.
7. Use T4's jog tool slowly (1–2° steps, ≤20 peak °/s), wrist/elbow clearance first, then shoulder,
   then yaw. Measure collision limits about 5° before contact with other joints in relevant extreme
   poses. Record limits in both files, compile/reflash only from supported stow, and verify `L`
   matches. Do not run an autonomous sequence using the placeholder poses.

Complete T0 under controlled support after this alignment and before teaching loaded poses; its
powered torque checks must not be used as an excuse to energize unaligned links first.

1. **Bench each servo:** write the real `us` values into both `config.h` and `arm.json`.
2. **Collision limits:** about 5° short of contact, in both files.
3. **Teach the poses:**
   - `stow`, `carry`, and `handoff` (beside the person).
   - `above`/`pick` and `yaw` for spots 1–7. Items differ in height, so each spot is its own.
   - Per-item `open`/`close`, closing just past contact.
   - Keep cup poses level (arm-plan §2.6). Open-cup recovery acceptance is blocked on the
     explicit policy decision in arm-plan §11; level endpoints do not prove staged recovery.
4. **Dry runs:** every sequence with an empty gripper at half speed, then with stand-ins, then the
   real items. Only then set `"taught": true`.

**Done when:** 10 fetch → release → return cycles in a row without a miss, plus a stop in the middle
of every phase recovering cleanly.

## T6. Whisper on the laptop (voice in) — done

**Status:** Done, as reported by the user. Current behaviour is documented in contracts §4.

**Files:** `app/api/transcribe/route.ts`, `lib/voice/whisper.ts`. Docs: contracts §4.

- **Server:** run whisper.cpp's `whisper-server` on the laptop with `--convert` (needs `ffmpeg`).
  - Start with the `base.en` model and try `small.en` if accuracy is poor. Apple Silicon runs both
    fast with Metal.
  - Write the exact install and run commands into README → Voice. Check whisper.cpp's current README
    rather than memory.
  - Set `WHISPER_URL=http://127.0.0.1:8080`.
- **Route and client:** implement both to the comments in the files.

**Done when:**
- On an iPhone, over the tunnel (T11), "bring me the glasses" comes back right.
- Under ~1.5 s from end of speech to text, for a short sentence.
- With `WHISPER_URL` unset, the browser engine still works.
- Setup → Voice shows which engine is in use.

## T7. ElevenLabs (voice out)

**Status:** Implemented. Live `/api/speak` returns audio and word timings with the built-in Sarah
voice (library voices need a paid plan over the API). iPhone playback and highlight timing are not
verified yet.

**Files:** `app/api/speak/route.ts`, `lib/voice/eleven.ts`. Docs: contracts §4.

Implement to the comments. Check ElevenLabs' current API docs for the with-timestamps endpoint, model
names and response shape; don't code from memory. Pick a low-latency model and a calm, clear voice.

**Done when:**
- Replies play in the chosen voice on iPhone after the first tap.
- The word highlight on the voice screen keeps time with the audio.
- Stop and new lines cut the old audio off.
- With the key unset, or on a 502, it falls back to the browser voice.
- Add a rough cost-per-reply line to README → Voice.

## T8. Wake word ("Hey Axel") — done

**Status:** Done, as reported by the user. Uses the existing Whisper service, with no additional
wake-word vendor. See contracts §4 for the implemented behaviour.

**Depends on:** T6. **Files:** `lib/voice/wake.ts`, `lib/voice/wake-phrase.ts`,
`components/hands-free.tsx`, Setup and the store.

- Setup → Hands-free keeps the mic open and listens for "Hey Axel" and supported Whisper spellings.
- Any utterance containing "stop" while moving stops the arm, without requiring the wake phrase or
  Hands-free. With no Whisper, the browser's recogniser does the listening (contracts §4). Neither
  path has been heard working on a phone yet.
- Listening pauses during Axel's speech. The page stays open with the screen wake lock.
- Off by default. Review #7: movement and holding/presentation request screen wake lock independently
  of Hands-free. Fake API tests cover foreground reacquisition, revocation, duplicate requests,
  denial and cleanup. Confirm actual Safari behaviour on the iPhone.

## T9. App: hand-back flow and state sync

Review #6: interrupted grip close/open is completed in place before staged recovery; release opens
only at handoff. Status drives the Release chip, including after Stop. Fake-arm regressions cover
fetch/take close interruptions and interrupted opening. Physical grip/contact remains T5.

**Status:** Implemented. Automated store/simulator and real HTTP DryArm tests cover voice transcripts,
typed commands, tap commands, state reconciliation and stale model answers after Stop. Actual microphone
and phone testing remain separate from these injected-input tests.

**Files:**
- `lib/store.ts` and `lib/robot/sim.ts`.
- `app/api/assistant/route.ts` and `lib/assistant.ts` (the prompt plus the keyword matcher).
- `app/api/robot/route.ts` (GET passes the bridge's `holding`/`presenting` through).
- `components/dial.tsx`.

**Store**
- A `presenting: number | null` state, set when a `return` streams `presenting`.
- The reply: "Put the glasses in my hand and say go."
- "go", "ok", "got it" or "take it" while presenting → `take`.
- `check()` rules matching contracts §1.

**Sim:** emulate presenting when nothing is held. The store can pass `holding` to the sim link.

**Dial:** while presenting, the You tile shows the item outlined, and a tap sends `take`.

**Assistant:** a `take` action plus the presenting state in the model prompt, and in the keyword
matcher.

**On load:** sync `holding`/`presenting` from `GET /api/robot` when in Robot mode.

**Done when:** the full return-from-hand flow works in the simulator and against `npm run bridge:dry`,
by voice, by typing and by tapping.

## T10. App: show bridge errors

**Status:** Implemented. Client/store tests cover every refusal sentence, streamed errors, immediate
Stop delivery, unconfirmed Stop, voice Stop during interpretation and deadman status recovery.
Browser speech is exercised with a recording fake; physical audio remains a phone check.

**Files:** `lib/store.ts`, `lib/robot/bridge.ts`.

The app speaks the bridge's own `error`
sentence when there is one, for example "I'm still moving." or "The arm isn't calibrated yet…".
Keep the generic line for network failures.

**Stop failures:** `lib/robot/bridge.ts` propagates the Stop response. The store speaks the bridge's stop error verbatim, including the 503 sentence:
"I couldn't confirm the arm stopped. Switch off its power." Handle button, Esc, voice and deadman
status recovery without delaying the initial Stop request. Review #8 requires the exact warning
to bypass reply mute and ElevenLabs on every path; regression tests cover all three sources,
plus lost Stop transport and malformed acknowledgements.
Audible playback and browser permission still need the iPhone check.

**Done when:** each bridge refusal and failed-Stop response in contracts §1 is spoken as itself.

## T11. Run everything on the laptop

Laptop preparation: `npm run preflight` checks installed prerequisites and source calibration
agreement without opening serial. Follow [first connection](first-connection.md) in the full local
checkout; the public UI-only repository does not contain the arm controller.

**Status:** README setup and staged iPhone checklist written. Local software, access gate and DryArm
checks can run without the robot. A fresh-clone real-arm run and physical iPhone checklist remain
pending T5 and a person; no public tunnel to real servos has been opened.

**Files:** README → Running it, maybe one `scripts/` helper with no new dependencies.

Document the full setup with three terminals:
- `npm run dev`
- `whisper-server …`
- `npm run bridge -- --serial …`

Plus a `cloudflared` tunnel for the phone, since mic access needs HTTPS. Do T12 first: the tunnel URL
is public.

**Done when:** a fresh clone, following the README alone, gets the phone driving the arm.

## T12. Passcode before anything is public

**Status:** Implemented with Next 16 Proxy and signed expiring httpOnly cookies. Tests cover missing,
forged, expired and rotated cookies, all API/page paths, cross-origin writes, safe redirects,
login limiting and unset-passcode behaviour. Production/browser integration verification is recorded
in the final software audit.

**Files:** a Next request interceptor (read `node_modules/next/dist/docs/` for this version's name and
API; it changed in Next 16), a small passcode screen, `APP_PASSCODE` in `.env.example`.

Anyone with the tunnel URL could move the arm. Require a passcode once per device, stored as an
httpOnly cookie, for every page and `/api/*` route.

**Done when:**
- Without the cookie, pages redirect to the passcode screen and APIs answer 401.
- With it, nothing changes.
- With `APP_PASSCODE` unset in development, it's off and the server logs a warning.
- Review finding 4: `npm run tunnel` verifies the running app gate, refusing missing config,
  an older unprotected Next process, wrong redirects or unavailable services before cloudflared
  starts. Fake HTTP/process tests cover this; no real tunnel or hardware is used by tests.
