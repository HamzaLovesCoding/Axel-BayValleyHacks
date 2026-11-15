import { PHASES, type Phase, type PhaseEvent, type RobotLink } from "./types";

// Talks to the real arm through this app's own /api/robot route, which relays to the bridge.
// Going through the server keeps the phone on one HTTPS origin: browsers block an HTTPS page
// from calling a plain ws:// or http:// address on the local network.

export type RobotHealth = {
  configured: boolean; reachable: boolean; busy?: boolean;
  holding?: number | null; presenting?: number | null; error?: string;
  canRelease?: boolean; needsRecovery?: boolean; atHandoff?: boolean;
};

export class BridgeError extends Error {
  name = "BridgeError";
}

export async function checkRobot(): Promise<RobotHealth> {
  try {
    const res = await fetch("/api/robot", { cache: "no-store" });
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== "object") throw new Error("Invalid status");
    const value = body as Record<string, unknown>;
    const position = (p: unknown): p is number | null => p === null || (typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 7);
    return { configured: value.configured === true, reachable: value.reachable === true,
      busy: value.busy === true,
      canRelease: value.reachable === true && value.canRelease === true,
      needsRecovery: value.needsRecovery === true, atHandoff: value.atHandoff === true,
      ...(position(value.holding) && position(value.presenting) ? { holding: value.holding, presenting: value.presenting } : {}),
      ...(typeof value.error === "string" && value.error.trim() ? { error: value.error } : {}),
    };
  } catch {
    return { configured: false, reachable: false };
  }
}

function toEvent(raw: unknown): PhaseEvent | { error: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const line = raw as Record<string, unknown>;
  if (typeof line.error === "string") return { error: line.error };
  if (typeof line.phase !== "string" || !PHASES.includes(line.phase as Phase)) return null;
  return { phase: line.phase as Phase, angle: typeof line.angle === "number" ? line.angle : undefined };
}

async function responseError(res: Response): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: unknown; network?: unknown };
    if (typeof body.error === "string" && body.error.trim() && body.network !== true) return new BridgeError(body.error);
  } catch {}
  return new Error("Robot connection failed");
}

export const bridgeLink: RobotLink = {
  kind: "robot",

  // The bridge may stream newline-delimited JSON ({"phase":"turning","angle":30} per line) while it
  // moves, or answer once with {"ok":true} when it's done. Both work.
  async run(message, onPhase, signal) {
    const res = await fetch("/api/robot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal,
    });
    if (!res.ok || !res.body) throw await responseError(res);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const handle = (line: string) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      const event = toEvent(parsed);
      if (event && "error" in event) throw new BridgeError(event.error);
      if (event) onPhase(event);
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(handle);
      }
      handle(buffer);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  },

  async stop() {
    // keepalive so the stop still goes out if the page is closing.
    const res = await fetch("/api/robot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
      keepalive: true,
      // A stalled connection must not leave the app waiting forever, deaf to further Stop taps.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw await responseError(res);
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== "object" || !("stopped" in body) || body.stopped !== true)
      throw new BridgeError("I couldn't confirm the arm stopped. Switch off its power.");
  },
};
