// What the phone sends to the arm. The /api/robot route forwards these, unchanged, to the bridge
// running next to the robot. The full contract lives in docs/contracts.md; change both together.
// The bridge (bridge/*.ts) imports this file too, so keep it free of imports and app-only code.
export const STOP_FAILURE = "I couldn't confirm the arm stopped. Switch off its power.";

export type RobotMessage =
  | { action: "fetch"; position: number; angle: number; item: string }
  | { action: "release" }
  // Holding that item: put it back. Not holding anything: go to the person with the gripper open
  // ("presenting") and wait for "take".
  | { action: "return"; position: number; angle: number; item: string }
  // The person has put the item in the open gripper: close on it, then put it back.
  | { action: "take"; position: number; angle: number; item: string }
  | { action: "stop" };

export type Phase =
  | "stowed"
  | "turning"
  | "gripping"
  | "bringing"
  | "holding"
  | "releasing"
  | "presenting"
  | "returning"
  | "placing"
  | "stowing"
  | "stopped";

export const PHASES: readonly Phase[] = [
  "stowed",
  "turning",
  "gripping",
  "bringing",
  "holding",
  "releasing",
  "presenting",
  "returning",
  "placing",
  "stowing",
  "stopped",
];

// `angle` is where the arm is headed, in tray degrees. Optional because a bridge may not know it;
// the app then derives it from the phase.
export type PhaseEvent = { phase: Phase; angle?: number };

export interface RobotLink {
  readonly kind: "sim" | "robot";
  // Resolves when the arm has finished the move. Rejects with an AbortError if `signal` aborts.
  run(message: RobotMessage, onPhase: (event: PhaseEvent) => void, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
}
