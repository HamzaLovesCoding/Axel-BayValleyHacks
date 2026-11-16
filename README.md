# Axel

Phone app for the assistive arm. The person says (or types, or taps) what they need, an assistant
works out which item they mean, and the arm brings it over. Built as an installable web app (PWA):
Next.js 16, Tailwind 4, Zustand. The name is a placeholder in `lib/site.ts`.

```bash
npm install
npm run dev            # http://localhost:3000
npm test               # bridge + app regression tests
```

It works with no keys and no hardware: speech uses the browser, the assistant falls back to a keyword
demo, and the arm is simulated. The screens label both demos as demos.

## Screens

| Route | What it is |
| --- | --- |
| `/` | Voice. Tray dial (tap an item to fetch it), the spoken status line, command chips, Talk / Stop. |
| `/chat` | Type, with the full conversation and a Heard / Understood / Target readout per reply. |
| `/setup` | Name what's in each tray spot, read replies aloud on/off, Simulator vs Robot, assistant status. |

## Kinematics

[`bridge/kinematics.ts`](bridge/kinematics.ts) is the arm's math, built on its CAD geometry:
- closed-form inverse kinematics, with the 8 mm side offset corrected and both elbow branches
- an analytic 4×4 Jacobian and Yoshikawa manipulability
- damped-least-squares (Levenberg–Marquardt) refinement
- straight-line Cartesian paths that reject branch flips and singularities
- shoulder torque from τ = Jᵀ·F

The derivation is in [docs/kinematics.md](docs/kinematics.md). The live demo still runs taught
poses. IK becomes the motion source once each servo's zero offset and direction are measured on the
arm.

## How a request flows

```
mic / keyboard / chip / dial tap
  → lib/store.ts ask()
  → POST /api/assistant      Claude if ANTHROPIC_API_KEY is set, else lib/assistant.ts (keywords)
  → check() in the store     refuses moves that don't fit what the arm is holding
  → RobotLink.run()          lib/robot/sim.ts, or lib/robot/bridge.ts → POST /api/robot → your bridge
```

Stop never waits on the AI: the Stop button, Esc, and the word "stop" while moving all abort locally
and send `{"action":"stop"}` to the bridge.

## Plugging in the real parts

| To add | Do this |
| --- | --- |
| AI model | Put `ANTHROPIC_API_KEY` in `.env.local` (copy `.env.example`). Model and prompt are in `app/api/assistant/route.ts`. |
| The arm | Run the bridge next to it (below), set `ROBOT_BRIDGE_URL`, pick Robot in Setup. |
| Whisper (voice in) | Run whisper.cpp's server on the laptop and set `WHISPER_URL` (T6). |
| ElevenLabs (voice out) | Set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` (T7). |

## Robot bridge

The phone never talks to the arm directly. `/api/robot` on this server relays to the bridge in
`bridge/`, which runs next to the arm and drives an Arduino over USB (`firmware/axel-arm/`). That
keeps the phone on one HTTPS origin; an HTTPS page can't call `http://` or `ws://` addresses on your
network.

```bash
npm run bridge:dry                            # pretend arm with real timing, no hardware
npm run bridge -- --serial /dev/tty.usbmodem…  # serial link; physical verification pending (docs/tasks.md T3)
```

Then set `ROBOT_BRIDGE_URL=http://localhost:8787` in `.env.local` and pick Robot in Setup.

- **Protocols, the calibration file and env vars:** `docs/contracts.md`.
- **The plan and the hardware facts:** `docs/arm-plan.md`.
- **What's left to build:** `docs/tasks.md`.

The bridge binds to `127.0.0.1`, so the phone reaches it through Next only. Bridge/jog scripts load
`.env.local` using Node 24's built-in env loader; the Next relay and bridge therefore share the same
token. Set `APP_PASSCODE` before opening any public tunnel (see Running it).

## Firmware

From the repository root on macOS:

```bash
brew install arduino-cli
arduino-cli core update-index
arduino-cli core install arduino:avr
arduino-cli lib install Servo
arduino-cli compile --fqbn arduino:avr:uno --warnings more firmware/axel-arm
```

Verified tool versions: Arduino CLI 1.6.0, arduino:avr 1.8.8, Servo 1.3.0. `--warnings more`
compiles without warnings. `--warnings all` additionally reports four upstream unused-parameter
warnings in the AVR core's `new.cpp`; Axel and Servo produce no warnings at that level.

Hardware-free firmware regression checks (requires the system C++ compiler):

```bash
c++ -std=c++11 -Wall -Wextra -Werror -Ifirmware/tests/fakes firmware/tests/firmware-test.cpp -o /tmp/axel-firmware-test
/tmp/axel-firmware-test
```

Compilation does not connect to or upload to a board. For physical testing, remove all servo horns,
open `firmware/axel-arm/axel-arm.ino` in Arduino IDE, select Arduino Uno and its USB port, and upload.
Follow the exact Serial Monitor checklist in [T2](docs/tasks.md#t2-firmware). Successful standalone
moves take about 250 ms; longer moves require heartbeats from the T3 bridge. Limits remain
uncalibrated, and `bridge/arm.json` remains `taught: false` until the T5 dry runs pass.

## Serial bench checks

`serialport` and `@serialport/parser-readline` add the native serial binding (prebuilt binaries for
supported systems) and stream parser: 22 installed packages in this checkout. The alternative is
moving serial handling into a Python bridge with `pyserial`, or using an ESP32-only controller.
SerialArm waits for `READY`, checks firmware limits with `L`, then reads `P`; a mismatch refuses
connection. An unsolicited firmware Stop/watchdog Stop closes the link and requires reconnecting,
so a later command runs startup recovery. Opening the port or its one-time DTR reset retry can send every servo to STOW.

**Loose servos only, with horns off or links fully disconnected:** close Serial Monitor and replace
the example port with the Uno's actual port. Do not run these checks on the assembled arm.

```bash
node bridge/bench-serial.ts --loose-servos --serial /dev/tty.usbmodem14101 --check stop
node bridge/bench-serial.ts --loose-servos --serial /dev/tty.usbmodem14101 --check replace
node bridge/bench-serial.ts --loose-servos --serial /dev/tty.usbmodem14101 --check full
```

The first two checks send Stop or a replacement move after 200 ms; the third runs long enough to
exercise heartbeats. The script logs all commands and replies. Space, Esc, Ctrl+C, typing `stop`,
and the usual app/voice Stop through its HTTP endpoint interrupt the run. See [T3](docs/tasks.md#t3-serial-link-in-the-bridge)
for expected replies and the separate real-bridge `/status` check. Physical results are pending.
Before energizing the assembled arm, follow [T5's first-power-up procedure](docs/tasks.md#t5-calibrate-and-teach-a-person-with-an-agent-driving-the-jog-tool):
the existing horn positions and placeholder STOW have not been aligned or calibrated.

## Jogging and teaching

Practise without hardware, preferably using a config copy so practice saves do not alter calibration:

```bash
cp bridge/arm.json /tmp/axel-practice.json
npm run jog -- --dry-run --config /tmp/axel-practice.json
```

Select joints with 1–5; arrows jog 1°, Shift+arrows 5°, at peak 20 °/s. `p` prints setpoints.
At startup/after Stop, clear wrist/elbow manually, type `clear` then Enter; clear shoulder, then
`clear` again before yaw. Use an empty gripper. `s carry` then Enter saves; supported names are
`stow`, `carry`, `handoff`, `above N`, `pick N`, `yaw N`, `open N`, `close N` (N=1–7). `u` undoes the
last pose save. Saves preserve JSON layout and validate before atomic replacement; taught stays false.

Space, Esc or typed `stop` freezes immediately, including during command entry. A space in a command
also stops before saving. App/voice Stop reaches the existing HTTP route on localhost:8787, using the
bridge token if configured; other HTTP motion is refused. `--port` changes the port. This Stop-only
interface deliberately reports serial mode even during local dry-run practice.

`l yaw min` (or another joint and `max`) tightens a limit at the current setpoint. It cannot widen a
limit or invalidate existing poses. Motion then locks until matching firmware is compiled/flashed and
the tool reconnects. `q` offers recovery then stow; answer `yes` only for physically verified empty-grip
poses, otherwise `no` quits in place. Ctrl+C, signals and closed input stop and exit without stowing.

For real servos use `npm run jog -- --serial <port>` **only after** T2/T3 bench checks and
[T5's first-power-up alignment](docs/tasks.md#t5-calibrate-and-teach-a-person-with-an-agent-driving-the-jog-tool).
Opening serial can reset the Uno and jump to STOW. Never attach unaligned links or jog with a cup.

## ElevenLabs voice output

Set `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `.env.local`, then restart Next if needed.
The key stays on the server. Axel uses [`eleven_flash_v2_5`](https://elevenlabs.io/docs/overview/models)
with the [text-to-speech-with-timestamps endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps),
MP3 output, and a slightly slower speaking rate. A tap unlocks the shared AudioContext. Word
highlights follow the playback clock; Stop/new speech cancel pending requests and playback.
Missing configuration, provider errors or unavailable audio fall back to browser speech.

Rough cost at the [published Flash API price](https://elevenlabs.io/pricing/api) of $0.04 per 1,000
characters: a 100-character reply is about **$0.004**, before plan credits/discounts (checked
2026-11-15). No new npm dependency is needed.

Use one of ElevenLabs' built-in voices on the free plan: library voices answer HTTP 402
`paid_plan_required` over the API. The configured voice is Sarah (`EXAVITQu4vr4xnSDxMaL`), and
`/api/speak` returns audio with word timings (checked 2026-11-15). iPhone first-tap playback and the
highlight timing are still phone checks.

## Voice

Whisper runs locally with no API charge. The [Homebrew formula](https://formulae.brew.sh/formula/whisper.cpp)
is now named `whisper.cpp` (formerly `whisper-cpp`). It installs `whisper-server`; models are separate.
The official [server instructions](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server)
confirm `--convert` requires ffmpeg to accept the phone's MP4/WebM recordings.

Install on a fresh Mac only if these tools are missing:

```bash
brew install whisper.cpp ffmpeg cloudflared
mkdir -p "$HOME/.cache/whisper.cpp"
curl -fL https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin -o "$HOME/.cache/whisper.cpp/ggml-base.en.bin"
```

These are external executables, not npm dependencies. Whisper uses local CPU/GPU and the base.en
model takes about 142 MiB; small.en takes about 466 MiB if accuracy needs improving. ffmpeg converts
recordings. Cloudflared adds a background tunnel process; [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
need no account/domain, change hostname each run and are intended for testing. Alternatives are browser
speech with no Whisper install, and local HTTPS instead of a tunnel. Do not install tools again if
already available. ElevenLabs pricing and browser fallback are described above.

## Running it

Use Node **24** and run commands from the repository root. On a fresh clone run `npm ci` and copy
`.env.example` to `.env.local`. If `.env.local` already exists, edit it; do not overwrite your keys.
Set these values privately in that file:

```dotenv
APP_PASSCODE=replace-with-a-long-unique-passcode
ROBOT_BRIDGE_URL=http://127.0.0.1:8787
ROBOT_BRIDGE_TOKEN=replace-with-a-long-shared-token
WHISPER_URL=http://127.0.0.1:8080
```

Use a long unique passcode (12+ characters recommended), not the example text. Keep existing API keys
private. Without the voice/model keys, browser speech and the keyword matcher still work.

The passcode screen protects pages and APIs using a signed httpOnly cookie valid for 30 days.
Changing APP_PASSCODE and restarting Next invalidates all cookies. Development with APP_PASSCODE
unset is deliberately open and logs a warning; production without it refuses access. Login accepts
10 attempts per minute across this single server process. Do not start a tunnel until the access
check below succeeds. A new tunnel hostname needs a new login.

Keep the three services in separate terminals:

1. **Next app:**
   ```bash
   npm run dev -- --hostname 127.0.0.1 --port 3001
   ```
2. **Whisper:**
   ```bash
   whisper-server --model "$HOME/.cache/whisper.cpp/ggml-base.en.bin" --language en --host 127.0.0.1 --port 8080 --convert
   ```
3. **Bridge:** start safely with no hardware:
   ```bash
   npm run bridge:dry
   ```
   Choose **Robot** in Setup to exercise the real HTTP path with DryArm. This still moves no servos.
   After all T2/T3 bench checks and T5 alignment/calibration/dry runs pass, stop the dry bridge and
   use the Uno's actual port instead:
   ```bash
   npm run bridge -- --serial /dev/tty.usbmodem14101
   ```
   Opening serial may reset to STOW. Keep Serial Monitor and the jog tool closed while the bridge
   owns the port. Real sequences remain refused while taught is false; only a person may change
   that after T5. Never use the placeholder poses on the assembled arm.

In another terminal tab, first verify the gate without a cookie:

```bash
curl -i http://127.0.0.1:3001/api/robot
curl -I http://127.0.0.1:3001/setup
```

Expect **401** and a **307 redirect to /passcode**, respectively. If either is open, stop here and
set APP_PASSCODE/restart Next. Then keep the HTTPS tunnel running in that tab:

```bash
npm run tunnel
```

Tunnel **only Next on 3001**, never the bridge or Whisper ports. It prints an HTTPS trycloudflare.com
URL; stopping cloudflared removes public access. Stopping any service prevents that part from working.
Close the tunnel first when finishing. With the real arm, Stop, return to verified supported stow,
then switch off servo power before disconnecting USB; cutting power removes holding torque.

### iPhone checks (pending a person)

Start with DryArm. We will run these one at a time when the phone is available:

1. Open the HTTPS tunnel URL in Safari Private Browsing. Confirm the passcode screen appears and
   `/api/robot` answers 401 before login. Enter a wrong passcode once; confirm the inline error.
2. Enter the correct passcode. Open Setup; choose Robot and verify the bridge is reachable. Reload:
   the cookie should keep the device unlocked. Private Browsing or deleting site data locks it again.
3. Tap Talk, allow the microphone, then say “bring me the glasses”. Confirm the transcription;
   time speech-end to text (T6 target ~1.5 s). Confirm the dry-run bridge prints the fetch phases.
4. Release, then say “put the glasses back”. Confirm the open-hand instruction and outlined You
   tile. Say “go”; repeat with typing and a tap on You. Reload while presenting/holding to check sync.
5. During each motion try the Stop button, spoken “stop” with Hands-free enabled, and Esc from a
   connected keyboard. Confirm Stop is immediate. Disconnect the phone network during a dry move,
   restore it, and check state/error recovery. No real arm until the bench checks pass.
6. If ElevenLabs access is available, confirm the selected voice plays after the first tap, highlights
   track words, and Stop/new replies cut audio off. With its key unset (restart Next), confirm browser
   speech still works. The audit records a successful Sarah voice request; physical iPhone playback remains
   unverified. No microphone/audio timing claim is made from desktop fake-input tests.
7. Enable Hands-free: “Hey Axel, bring me the glasses”, then bare “stop” during motion. Confirm no
   wake-up on Axel's own voice. Keep Safari open and the screen on. Share → Add to Home Screen if desired.

The real-arm repeat waits for T5. Physical iPhone, fresh-clone hardware operation, wake-word latency,
servo calibration and loaded motion are not verified by local automated checks.

### Software checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

`npm test` uses fake streams/DryArm only. App regressions use the existing TypeScript compiler via
`scripts/test-register.mjs`; no extra test dependency. Optional `scripts/browser-check.mjs` uses an
already installed Chrome DevTools endpoint against a **test-only** server on localhost:3102 and
refuses motion checks unless the app relay reports mode dry-run. Its speech input is injected,
not a microphone measurement. See the task audit for recorded results and remaining physical checks.

The `npm run tunnel` launcher checks the running app on port 3001 before starting Cloudflare:
unauthenticated API access must return 401 and pages must redirect to the passcode screen. After
setting APP_PASSCODE privately in `.env.local`, restart Next; editing the file alone is insufficient.

## First hardware connection

Use the full local checkout, not the UI-only GitHub export. Run `npm run preflight` and follow
[the staged first-connection guide](docs/first-connection.md). This check never opens serial.
