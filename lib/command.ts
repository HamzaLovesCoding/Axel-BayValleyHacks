import type { Slot } from "./tray";

// What the assistant decided the person wants. Shared by the client, the keyword stand-in and the
// /api/assistant route, so whichever one answers, the rest of the app sees the same shape.
export type Command =
  | { action: "fetch"; position: number }
  | { action: "release" }
  | { action: "return"; position: number }
  | { action: "take"; position: number }
  | { action: "stop" };

export type Interpretation = {
  // One short sentence the app says out loud.
  reply: string;
  // Plain gloss for the readout, e.g. "Bring the water".
  understood: string;
  command: Command | null;
  // "keywords" is the demo matcher, not the AI model. The UI must label it.
  source: "model" | "keywords";
};

export type AssistantRequest = {
  text: string;
  tray: Slot[];
  // Tray position of the item in the gripper, if any.
  holding: number | null;
  // Last item handed over, so "put it back" knows what "it" is.
  lastFetched: number | null;
  // Waiting for this item to be placed in the open gripper.
  presenting: number | null;
  history: { role: "user" | "assistant"; text: string }[];
};

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export function parseCommand(raw: unknown, tray: Slot[]): Command | null {
  if (!raw || typeof raw !== "object") return null;
  const { action, position } = raw as Record<string, unknown>;
  const onTray = isInt(position, 1, 7) && tray.some((s) => s.position === position);
  if (action === "release" || action === "stop") return { action };
  if ((action === "fetch" || action === "return" || action === "take") && onTray) return { action, position: position as number };
  return null;
}

// Validates an untrusted request body. Returns null if it isn't usable.
export function parseAssistantRequest(raw: unknown): AssistantRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 500) return null;
  if (!Array.isArray(body.tray)) return null;
  const tray = body.tray
    .filter((s): s is Slot => !!s && isInt(s.position, 1, 7) && typeof s.name === "string")
    .map((s) => ({ position: s.position, name: s.name.slice(0, 40) }));
  const history = Array.isArray(body.history)
    ? body.history
        .filter(
          (t): t is AssistantRequest["history"][number] =>
            !!t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string",
        )
        .slice(-12)
        .map((t) => ({ role: t.role, text: t.text.slice(0, 500) }))
    : [];
  return {
    text: body.text.trim(),
    tray,
    holding: isInt(body.holding, 1, 7) ? body.holding : null,
    lastFetched: isInt(body.lastFetched, 1, 7) ? body.lastFetched : null,
    presenting: isInt(body.presenting, 1, 7) ? body.presenting : null,
    history,
  };
}
