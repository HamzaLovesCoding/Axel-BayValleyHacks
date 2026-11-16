# Contracts

Every boundary in the system, in one place. If you change one, change this file and both sides in
the same commit. Background and reasoning: `docs/arm-plan.md`. Work queue: `docs/tasks.md`.

```
phone (Next app) ──HTTPS──▶ Next server ──HTTP──▶ bridge (Node, laptop) ──USB serial──▶ Arduino Uno ──PWM──▶ 5 servos
   │  /api/assistant  → Claude (or keyword demo)
   │  /api/transcribe → whisper.cpp server on the laptop (or browser speech recognition)
   │  /api/speak      → ElevenLabs (or browser speechSynthesis)
   └─ /api/robot      → the bridge
```

---

## 1. App ↔ bridge (HTTP)

The phone never talks to the bridge. `app/api/robot/route.ts` relays and derives `angle` from
`position` itself. Types live in `lib/robot/types.ts`, which the bridge imports, so there's only one
copy.

If `ROBOT_BRIDGE_TOKEN` is set, every request carries `Authorization: Bearer <token>`, and the bridge
answers 401 without it.

### `GET /status`

- **200 when ready:** serial is connected, the firmware said `READY`, and calibration is loaded.
- **503 otherwise**, with `{"error":"..."}`.

```json
{ "ok": true, "mode": "dry-run" | "serial", "taught": false, "taughtSpots": [1, 2], "holding": null, "presenting": null, "busy": false, "grip": "empty", "needsRecovery": true, "atHandoff": false, "canRelease": false }
```

`holding` and `presenting` are tray positions or `null`. The app can use them to recover its state
after a reload. The Next relay preserves `holding`, `presenting` and `busy` in GET /api/robot;
the app reconciles its state after loading saved Robot mode. While presenting, “go”, “ok”, “okay”,
“got it”, “take it” or a tap on the outlined You tile sends `take` for that position.

### `POST /command`

Request: one `RobotMessage`.

| Action | Body |
| --- | --- |
| `fetch` | `{"action":"fetch","position":2,"angle":30,"item":"Glasses"}` |
| `return` | `{"action":"return","position":2,"angle":30,"item":"Glasses"}` |
| `take` | `{"action":"take","position":2,"angle":30,"item":"Glasses"}` |
| `release` | `{"action":"release"}` |
| `stop` | `{"action":"stop"}` |

- **`position` (1–7) is the only thing the bridge acts on.** `angle` is the app's display angle
  ((position − 1) × 30). The real yaw for each spot comes from `bridge/arm.json`.
- **Response while moving:** `200`, `content-type: application/x-ndjson`, one JSON line per phase,
  closed when the move is done.
  ```
  {"phase":"turning","angle":30}
  {"phase":"gripping","angle":30}
  ...
  ```
- **`angle` in a phase line is a display angle too:** the spot's angle, 270 for the person, 90 for
  stowed. The app's dial uses it.
- **Failure mid-move:** a final line `{"error":"<sentence the app can show>"}`, then close.
- **Refused before moving:** a plain JSON error body.
  - `400` unknown or invalid command.
  - `401` bad token.
  - `409` busy, or the command doesn't fit the arm's state (fetch while holding, take while not
    presenting).
  - `503` not ready.
- **`stop`:** always attempted, even while busy or not ready. On confirmed success it returns
  `200 {"ok":true,"stopped":true}`. If the firmware does not confirm, it returns
  `503 {"error":"I couldn't confirm the arm stopped. Switch off its power."}`.
  Both paths abort the in-flight command and mark recovery required. On failure the bridge marks
  the arm not ready (`GET /status` returns 503 with the same error), closes the serial link, and
  stops heartbeats so the firmware watchdog freezes motion within 500 ms of its last host line.
  Reconnect/restart before moving again; never report an unconfirmed stop as successful.
- **If the client disconnects mid-move, the bridge attempts to stop the arm.** Deadman failures are
  caught and use the same not-ready/recovery/heartbeat shutdown behaviour; they never crash the
  bridge. The disconnected client cannot receive a reply, but a subsequent status or Stop request
  returns 503 with the stop-confirmation error.

### Sequences and the phases they emit

| Action | Precondition | Phases, in order | After |
| --- | --- | --- | --- |
| `fetch(p)` | holding nothing, not presenting | `turning` → `gripping` → `bringing` → `holding` | holding `p` |
| `release` | holding something | `releasing` → `stowing` → `stowed`. After a stop, `bringing` comes first: the arm takes the item to the hand-off before it opens | holding nothing |
| `return(p)` | holding `p` | `returning` → `placing` → `stowing` → `stowed` | holding nothing |
| `return(p)` | holding nothing | `presenting` | presenting `p` (gripper open at the person) |
| `take(p)` | presenting `p` | `gripping` → `returning` → `placing` → `stowing` → `stowed` | holding nothing |
| `stop` | — | — (the open stream ends) | confirmed: position frozen; unconfirmed: not ready, position unknown. Recovery precedes the next motion |

**Recovery move:** used after a stop, and on any command whose start isn't a known pose. Go to
`carry`, wrist and elbow first, then the shoulder, and only then yaw. The arm must never swing
across the tray while low. This staged recovery does not guarantee a level cup; the options in
arm-plan §11 await an explicit decision. No alternate recovery policy is silently enabled.

**Speed:** every autonomous sequence move is capped at `min(requested speed, speed.nearPerson)`;
the config loader enforces nearPerson ≤30 °/s. This includes recovery, grip, stowAway, putBack,
release, return and take. Jog and its optional stow use min(20, nearPerson). There is no measured person exclusion zone, so being at another yaw or
away from the handoff endpoint is insufficient proof of clearance. The whole trajectory stays
slow, including crossings. Normal/grasp configuration values are preserved; faster operation away
from the person requires a separately approved, physically measured zone policy.

**Grip and release:** `grip` is `empty`, `closing`, `held` or `opening`. Holding starts before
closing; a Stop preserves it. The next explicit release/return finishes an interrupted close at the
same location, at min(grasp, nearPerson), and settles before staged recovery. An interrupted opening
finishes at its original supported location before lifting; it cannot trigger a fresh hand-back.
Fetch is refused while an item may still be held. Release after Stop recovers and goes to handoff
before opening. A known non-handoff release is refused with 409
"I'm not at the hand-off. Put the item back first." The opening itself verifies all four arm
setpoints match handoff within 0.5°. This is commanded position, not sensor-confirmed arrival.

Status `canRelease` means a release request is permitted (including recovery first), and is false
while busy or not ready. `atHandoff` describes the commanded pose; `needsRecovery` survives Stop.
The relay preserves these booleans; the app's Release chip and dial tile use `canRelease`, not an
inferred phase. Status requests begun before a new command or Stop cannot overwrite newer state.
Stop completion refreshes holding state, including interrupted grips.

---

The app speaks bridge error sentences verbatim, including streamed errors and failed Stop. It
reports “Stopping” until confirmation, and speaks “Stopped” only after success. Network failures
use the generic connection sentence; the Next relay marks its transport failures `network: true`.
Status refresh on load, focus, reconnect and periodically recovers deadman errors without repeating
the same error on every poll. Stop is dispatched before stream cancellation or speech work. The exact failed-Stop warning always
interrupts queued speech and uses browser speech immediately, even with Read replies aloud off or
ElevenLabs selected. This applies to Stop responses, motion refusals/stream errors and status
recovery. It never requests or waits for `/api/speak`; muting replies cannot cancel that warning.
A failed transport or invalid acknowledgement on the Stop request is also unconfirmed and uses
this same power-off warning. Ordinary non-Stop network errors keep their generic connection text.

## 2. Bridge ↔ Arduino (USB serial)

- 115200 baud, 8N1, ASCII, one command per line, `\n`-terminated.
- Angles are integer servo degrees 0–180 (`_` = leave that joint alone), in joint order
  `yaw shoulder elbow wrist grip`.
- The firmware knows nothing about items or poses. Only angles, speeds and limits.

| Host → Arduino | Meaning | Arduino → host |
| --- | --- | --- |
| `M <a1> <a2> <a3> <a4> <a5> <speed>` | Move all joints together so they arrive at the same time; `speed` = peak °/s of the joint with the farthest to go (1–180) | `OK` on accept, then `DONE` on arrival. `ERR <reason>` if refused |
| `S` | Stop: freeze at the current setpoint, drop the target | `STOPPED` |
| `P` | Report the current setpoint | `POS <a1> <a2> <a3> <a4> <a5>` |
| `H` | Heartbeat. The host sends it every 200 ms while a move is running | nothing |
| `A` | Attach servos one at a time, 300 ms apart, at the stored setpoint, in the order wrist, elbow, shoulder, yaw, grip (the recovery order; boot uses it too) | `OK` when all are attached |
| `D` | Detach all servos (no pulses; the arm goes limp) | `OK` |
| `L` | Report the compiled joint limits | `LIM <min1> <max1> … <min5> <max5>` |
| *(boot)* | — | `READY <firmware version>` once servos are attached at the stow pose |
| *(watchdog)* | No `H` or any line for 500 ms during a move | `STOPPED watchdog` |

**Rules the firmware enforces whatever the host says:**
- Clamp every target to that joint's compiled `min`/`max`, and report `ERR limit <joint>` instead of
  moving if a target is outside.
- One move at a time. A new `M` while moving replaces the target from the current setpoint; it's not
  queued.
- Setpoints change at 50 Hz with smoothstep easing. Never jump. Duration in milliseconds is
  `ceil(1500 × farthest joint distance / speed)`, so smoothstep's peak velocity stays at or below
  the requested speed. DryArm uses the same duration and easing.
- Joint indices in `ERR limit <joint>` are 1–5 (yaw through grip); the whole move is refused.
- `M` is refused with `ERR detached` until all five servos are attached. `A` runs without blocking
  serial processing; `S` cancels the remaining attachments, holding those already attached.
  Send `A` again to finish attachment. `D` cancels attachment and disables every servo output.
  An interrupted `A` has no later `OK`; a resumed boot prints `READY` only on full attachment.
- Any malformed line gets `ERR parse`, with no motion. `M` requires exactly five integer angles
  (or `_`) and one integer speed. `S`, `P`, `L`, `H`, `A`, and `D` must be the letter alone, with
  no trailing characters. LF and CRLF endings are accepted. Overflowing lines are discarded
  through the next newline; no suffix is executed.

**Firmware errors at the bridge:** any `ERR` invalidates the serial connection and stops heartbeats.
A refused replacement does not cancel the previous firmware move, so the bridge cannot trust its
position estimate or allow another command. An in-flight HTTP sequence marks recovery required;
status and further motion return 503 until reconnect. There is no automatic retry. The watchdog
freezes a still-running move within 500 ms of the last host line; an error is not a confirmed Stop.
Before reconnecting/resetting, an operator must remove any load safely with links supported and
power off, then follow the aligned, empty-gripper startup procedure. A restart loses the bridge's
in-memory grip state and may command STOW; never use it as automatic loaded recovery.

---

## 3. Calibration file (`bridge/arm.json`)

Types and validation are in `bridge/config.ts`. Angles are servo degrees 0–180. In a pose, `null`
means "leave that joint as it is", so `carry` with `null` yaw works at any spot.

```jsonc
{
  "taught": false,                 // the bridge refuses to drive real servos while false
  "joints": {                      // order matters: yaw, shoulder, elbow, wrist, grip
    "yaw":      { "pin": 3,  "us": [500, 2500], "min": 0, "max": 180 },
    "...": {}
  },
  "speed": { "normal": 60, "nearPerson": 30, "grasp": 25 },   // peak °/s
  "timing": { "gripSettleMs": 300, "releaseWaitMs": 800 },
  "poses": { "stow": [..5], "carry": [..5], "handoff": [..5] },
  "spots": { "1": { "taught": false, "yaw": 0, "above": [..5], "pick": [..5] }, "...": {} },  // "1".."7"
  "grip":  { "1": { "open": 120, "close": 70 }, "...": {} }                 // per spot
}
```

- `spots.N.taught` (missing means false): on real servos the bridge refuses fetch/return/take for
  an untaught spot with `409 "I haven't learned that spot yet."`, even when the top-level `taught` is
  true. Like `taught`, only a person sets it, after that spot's dry runs. DryArm ignores it.
- `us` is the pulse width at 0° and at 180°. Descending endpoints represent a reversed servo.
  Firmware subtracts, multiplies and adds in signed long (millidegree interpolation), then converts
  the final positive pulse to the output type; no unsigned endpoint subtraction is permitted.
- `min`/`max` must match the limits compiled into the firmware. The bridge checks with `L` at
  connect, and refuses to start on a mismatch.

---

## 4. Voice (Next server routes)

`GET /api/voice` tells the phone which engines to use, based on which env vars are set:

```json
{ "stt": "whisper" | "browser", "tts": "elevenlabs" | "browser", "wake": "whisper" | "none" }
```

### `POST /api/transcribe` (speech → text)

- **Request:** the raw recorded audio as the body, with its `content-type`. iPhone Safari records
  `audio/mp4`; Chrome records `audio/webm`.
- **Response:** `200 {"text":"bring me the glasses"}`. `503 {"error":"..."}` if `WHISPER_URL` isn't
  set; `502` if Whisper didn't answer.
- **Server side:** POST multipart `file=<audio>`, `response_format=json`, `temperature=0` to
  `${WHISPER_URL}/inference`. That's whisper.cpp's `whisper-server`; run it with `--convert` so it
  accepts mp4/webm through ffmpeg.

### `POST /api/speak` (text → speech)

- **Request:** `{"text":"Here's the water."}`, at most 300 characters.
- **Response:** `200 {"audio":"<base64 mp3>","mime":"audio/mpeg","chars":[{"i":0,"t":0.00},…]}`.
  - `chars` gives the start time in seconds of each character index the app should light up. It
    feeds the word-by-word highlight that `lib/voice/speak.ts` already drives.
  - `400` for empty/invalid text or more than 300 UTF-16 code units.
  - `503` if the ElevenLabs key or voice ID is missing.
  - `502` on provider failure, timeout or invalid audio/alignment; the client uses browser speech.
- **Server side:** POST `/v1/text-to-speech/{voice_id}/with-timestamps` using `eleven_flash_v2_5`
  and MP3 output. The key stays in the server's `xi-api-key` header. Provider requests time out at
  10 s and are cancelled when the client disconnects. No upstream error bodies or credentials are
  returned or logged. `chars` includes original-text UTF-16 indices at each word's first character.
- **Playback:** a tap resumes the playback AudioContext (the mic meter has its own). Highlights use its playback clock. Stop and
  replacement speech cancel requests and audio immediately; completion fires once. Async errors
  fall back to browser speech.

### Wake word ("Hey Axel")

- **Built on Whisper:** no extra service. `wake` is `"whisper"` exactly when `WHISPER_URL` is set.
- **How it listens:** with Setup → Hands-free on, `components/hands-free.tsx` keeps the mic open and
  cuts out each utterance. It sends each one to `/api/transcribe`, and `lib/voice/wake-phrase.ts`
  decides whether it starts with "Hey Axel" (or how Whisper spells it).
  - "Hey Axel, bring me the water" asks straight away.
  - "Hey Axel" on its own starts listening for the command.
- **While the arm moves,** any utterance containing "stop" stops it, with or without the wake phrase
  and with or without Hands-free on (`earFor()` in `lib/voice/wake-phrase.ts`).
  - With Whisper it keeps listening while Axel talks. If the line being read out itself contains
    "stop", a heard "stop" is ignored, because the mic may only be hearing Axel.
  - Without Whisper the browser's own recogniser listens (`listenForStop()` in `lib/voice/listen.ts`),
    but only between spoken lines, since it shares the speaker with the browser voice.
  - It rests once a Stop has been sent, so the result can be heard. It may ask for the microphone
    the first time the arm moves.
- **It pauses while Axel is speaking,** so it never wakes on its own voice.
- **It needs the page open and the screen on.** Screen wake lock is requested while Hands-free is
  enabled, while moving, or while holding/presenting at the person. Motion and presentation request
  it even with Hands-free off. Foregrounding reacquires a revoked lock; cleanup releases it.
  Browser/OS denial remains possible; this is not a guarantee against screen locking.

---

## 5. Access gate

Next 16's `proxy.ts` protects every page and `/api/*` route. Without a valid signed cookie, pages
redirect to `/passcode` and APIs return `401 {"error":"Enter the passcode to use Axel."}`. Only the
passcode page, POST `/api/session`, the web manifest, the two app icons and static assets needed to
render login are public.

POST `/api/session` accepts `{"passcode":"...","next":"/chat"}`. Success returns
`{"ok":true,"next":"/chat"}` and a signed `axel_session` cookie: httpOnly, host-only, SameSite=Strict,
path `/`, 30-day expiry, Secure over HTTPS/production. No passcode is stored in the cookie or browser
storage. Incorrect passcodes return 401; after 10 login attempts per minute, 429. The limit is
process-local for this single-laptop deployment and resets on restart. Passcode rotation invalidates
all existing cookies. Foreign-origin writes are refused. Redirects stay inside app pages.

With APP_PASSCODE unset, development opens with a server warning; production returns 503 and stays
closed. Use a long unique passcode before starting any tunnel. `npm run tunnel` refuses to launch
unless APP_PASSCODE is set and the running app on port 3001 rejects an unauthenticated API request
and redirects the page to its passcode screen. Setting the env without restarting Next is insufficient. The locked page does not start mic,
health polling or voice-engine requests.

## 6. Environment variables

| Var | Used by | Meaning |
| --- | --- | --- |
| `APP_PASSCODE` | Next server | Required for public access. Unset: development warns/open; production refuses access |
| `ANTHROPIC_API_KEY` | Next server | Claude for understanding. Unset → keyword demo |
| `ROBOT_BRIDGE_URL` | Next server | Where the bridge listens, e.g. `http://localhost:8787`. Unset → simulator only |
| `ROBOT_BRIDGE_TOKEN` | Next server + bridge | Optional shared secret |
| `WHISPER_URL` | Next server | whisper.cpp server, e.g. `http://127.0.0.1:8080`. Unset → browser speech recognition |
| `ELEVENLABS_API_KEY` | Next server | Unset → browser speech synthesis |
| `ELEVENLABS_VOICE_ID` | Next server | The voice to use |
| `ARM_SERIAL_PORT` | bridge | e.g. `/dev/tty.usbmodem14101`. Also `--serial` on the command line |
