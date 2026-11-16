# First hardware connection

Use `/Users/hamza/Developer/dashboard`. The public Axel-BayValleyHacks checkout contains only the
app; it cannot run the arm. This procedure assumes the planned Arduino Uno, not an ESP32.

## Before the cable arrives

```bash
cd /Users/hamza/Developer/dashboard
npm run preflight
npm test
npm run typecheck
npm run lint
arduino-cli compile --fqbn arduino:avr:uno --warnings more firmware/axel-arm
```

Preflight checks installed tools, private configuration presence, model location, and matching
pins/pulses/limits/STOW in both source files. It prints no credentials, opens no serial ports and
never enables taught poses. Passing does not verify wiring, flashed firmware or mechanical safety.

For phone testing now, start separate terminals with `npm run dev -- --hostname 127.0.0.1 --port 3001`,
`npm run whisper`, and `npm run bridge:dry`. Then `npm run tunnel`, log in on the iPhone and select
Robot in Setup. Follow README's iPhone checklist using DryArm only.

## Cable connected: do these stages one at a time

1. Keep USB and servo power disconnected while preparing. Confirm Uno, five servo signal wires
   on pins 3/5/9/6/10 in yaw/shoulder/elbow/wrist/grip order (elbow 9, wrist 6), separate 6 V supply, common ground and
   accessible power cutoff. Do not power servos from the Uno. Support every link.
2. Follow T5's first-power-up procedure: remove horns from their splines or disconnect driven
   links completely. Loose retaining screws are insufficient. Do not connect an assembled,
   coupled arm to placeholder STOW. Have the builder help if disassembly is required.
3. With servo power off and outputs mechanically disconnected, connect USB. In Arduino IDE select
   Arduino Uno and the actual port, open firmware/axel-arm/axel-arm.ino and upload. Do not guess
   the port or board. Close other serial programs. Upload/reset can change servo outputs.
4. Follow **T2 Review #9** in docs/tasks.md exactly: enable separate servo power, reset, verify
   READY/L/P, short moves, parser/limits, watchdog and interrupted attachment. Send the replies and
   physical observations before proceeding. All horns remain off.
5. After T2 passes, close Serial Monitor and stop any dry bridge on 8787. Run each T3 bench command
   from docs/tasks.md with the actual port: stop, replace, full. Each requires `--loose-servos`.
   Start with stop; report results before replacement/full. These commands move loose servos.
6. After bench acceptance, verify the normal serial bridge with `npm run bridge -- --serial <port>`
   (replace `<port>`). Check Setup reports reachable. Motion remains refused with taught=false.
   Stop that process before opening jog or Serial Monitor; only one may own the port.
7. Complete T5 alignment and T0 supported load assessment, then `npm run jog -- --serial <port>`.
   Measure pulses and collision limits, keep firmware/config and bridge/arm.json in agreement,
   recompile/reflash from supported stow, and teach poses/grips. No autonomous placeholder moves.
8. Run empty/stand-in/real-item tests and Stop/recovery in every phase, then ten successful cycles.
   Only the person may enable taught after acceptance. Open-liquid cups await the §11 policy decision.

Record board/port, supply rating, disconnected-link state, firmware build, replies, physical motion,
and any buzzing/sagging/slip. Stop immediately on unexpected movement. Power cutoff removes holding
torque, so links must remain supported. Never continue to the next stage on an unexplained failure.
