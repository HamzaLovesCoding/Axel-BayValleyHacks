# Axel — Bay Valley Hacks

Mobile UI snapshot for Axel, a voice-first assistive robot arm concept for people with arthritis.

This repository starts from the current app files in one initial commit, **UI design commit**. It has no earlier development history. It showcases the phone interface and simulator; it does not establish that the physical arm has finished testing.

## Included

- Voice, chat, and setup screens; interactive seven-position tray and hand-off display.
- Light and dark themes, animations, mobile layout, and app icons/manifest.
- App state, simulated fetch/return flows, voice input/output, and optional assistant services.
- Passcode access and app-side HTTP integration interfaces.

The Arduino firmware, serial bridge, motion sequences, joint limits, calibration files, jog tool, and hardware tests are intentionally excluded. They will be published separately after testing. The files under `lib/robot/` are the phone client's interfaces and visual simulator, not the hardware controller.

## Run locally

Use Node.js 24 or later.

```bash
npm ci
npm run dev -- --port 3001
```

Open http://localhost:3001 and select **Simulator** in Setup. No robot, API keys, or paid services are required for the UI demo. Browser microphone support varies; typed commands and tray taps work without a microphone.

Optional service settings are documented in `.env.example`. Copy it to `.env.local` only if needed, and keep credentials private. Before sharing a public URL, set a long, unique `APP_PASSCODE` and restart the app. Production requires this passcode; development without it is open and logs a warning.

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

For a production preview, set `APP_PASSCODE` privately in `.env.local`, then run `npm run build` and `npm start -- --port 3001`.
