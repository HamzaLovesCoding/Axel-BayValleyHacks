import { HANDOFF_ANGLE, REST_ANGLE } from "../tray";
import type { Phase, RobotLink, RobotMessage } from "./types";

type Step = { phase: Phase; angle: number; ms: number };

// Rough timings so the UI has something realistic to follow. Not measured on the real arm.
function script(message: RobotMessage, state: { holding: number | null; presenting: number | null }): Step[] {
  switch (message.action) {
    case "fetch":
      return [
        { phase: "turning", angle: message.angle, ms: 1100 },
        { phase: "gripping", angle: message.angle, ms: 900 },
        { phase: "bringing", angle: HANDOFF_ANGLE, ms: 1500 },
        { phase: "holding", angle: HANDOFF_ANGLE, ms: 0 },
      ];
    case "release":
      if (state.presenting != null) return [
        { phase: "stowing", angle: REST_ANGLE, ms: 1000 },
        { phase: "stowed", angle: REST_ANGLE, ms: 0 },
      ];
      return [
        { phase: "releasing", angle: HANDOFF_ANGLE, ms: 800 },
        { phase: "stowing", angle: REST_ANGLE, ms: 1000 },
        { phase: "stowed", angle: REST_ANGLE, ms: 0 },
      ];
    case "return":
      if (state.holding == null) return [{ phase: "presenting", angle: HANDOFF_ANGLE, ms: 1500 }];
      return [
        { phase: "returning", angle: message.angle, ms: 1500 },
        { phase: "placing", angle: message.angle, ms: 900 },
        { phase: "stowing", angle: REST_ANGLE, ms: 1000 },
        { phase: "stowed", angle: REST_ANGLE, ms: 0 },
      ];
    case "take":
      return [
        { phase: "gripping", angle: HANDOFF_ANGLE, ms: 700 },
        { phase: "returning", angle: message.angle, ms: 1500 },
        { phase: "placing", angle: message.angle, ms: 900 },
        { phase: "stowing", angle: REST_ANGLE, ms: 1000 },
        { phase: "stowed", angle: REST_ANGLE, ms: 0 },
      ];
    case "stop":
      return [];
  }
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Stopped", "AbortError"));
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Stopped", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createSimLink(
  state: () => { holding: number | null; presenting: number | null },
  timeScale = 1,
): RobotLink {
  return {
    kind: "sim",
    async run(message, onPhase, signal) {
      for (const step of script(message, state())) {
        signal.throwIfAborted();
        onPhase({ phase: step.phase, angle: step.angle });
        await wait(step.ms * timeScale, signal);
      }
    },
    async stop() {},
  };
}

export const simLink = createSimLink(() => ({ holding: null, presenting: null }));
