<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Axel: assistive arm + phone app

A voice-first phone app (Next.js PWA) that tells a 5-servo robot arm to fetch everyday items (glasses,
cups, pill boxes) from a tray and hand them to a person with arthritis. No camera, no sensors: the arm
goes to taught poses and trusts the item is there.

## Start here

- `docs/tasks.md`: the work queue. Pick the task you were given and read its "done when".
- `docs/contracts.md`: every boundary (app ↔ bridge HTTP, bridge ↔ Arduino serial, `arm.json`,
  voice routes, env vars). Change a contract only together with both sides and this doc.
- `docs/arm-plan.md`: the hardware facts (from the CAD), the risks, and why things are the way they
  are.

## Map

| Path | What |
| --- | --- |
| `app/`, `components/`, `lib/` | The phone app. `lib/store.ts` is the brain; `lib/robot/types.ts` is the shared robot contract |
| `bridge/` | Node program next to the arm: HTTP server, sequences, config, `DryArm`, tests. Runs as TypeScript directly via Node's type stripping |
| `firmware/axel-arm/` | Arduino Uno sketch: smooth, limited, stoppable joint moves |
| `scripts/mock-bridge.mjs` | Older stand-in bridge. `npm run bridge:dry` replaces it |

## Commands

```bash
npm test               # bridge tests (node:test)
npm run typecheck      # app + bridge
npm run lint
npm run bridge:dry     # pretend arm on :8787; set ROBOT_BRIDGE_URL=http://localhost:8787 and pick Robot in Setup
npm run dev -- --port 3001
```

Run `npm test`, `npm run typecheck` and `npm run lint` before calling a task done.

## Safety rules for anything that moves the arm

These protect a person sitting next to it. They are not style preferences.

- **Stop never waits.** Not on the network, the AI model, speech, or a queue. Any new path that can
  start motion must be stoppable by the app's Stop, the word "stop", Esc, and a dropped connection.
- **Limits are checked twice:** in the bridge (`resolve()` in `bridge/config.ts`) and in the firmware.
  Never remove or widen one to make something work; measure and change the numbers instead.
- **Never set `"taught": true`** in `bridge/arm.json`. A person does that after the dry runs in
  `docs/arm-plan.md` §7.
- **Near the person, ≤ 30 °/s** (`speed.nearPerson`). No new code path may move faster near the hand-off.
- **After a stop or at start-up, recover before moving:** wrist and elbow, then shoulder, then yaw.
  Never swing across the tray low.
- **Tests never touch real hardware.** Use `DryArm` or a fake stream.
- **Firmware changes come with the bench checklist** from T2, run with the servo horns off.

## Code rules

- Match the style of the file you're in. Comments explain why, not what.
- TypeScript: no `any` without a comment saying why. Prefer real types to casts.
- `bridge/` runs without a build step, so use erasable TypeScript only: no `enum`, `namespace` or
  constructor parameter properties. Import with the `.ts` extension. It may import from
  `lib/robot/types.ts` and `lib/tray.ts`, which must stay dependency-free.
- No new dependency without saying what it costs and what the alternative is.
- Secrets go in `.env.local` only. `.env.example` gets placeholders. Never commit keys.
- Don't refactor code outside your task; note it instead.
- Don't commit or push unless the user asks.
- Copy shown to the person is short, warm, sentence case, with no jargon. They may be tired or in
  pain.
