import { connection } from "next/server";
import type { RobotMessage } from "@/lib/robot/types";
import { angleOf, MAX_NAME } from "@/lib/tray";

// Relays commands from the phone to the bridge program running next to the arm (bridge/, see
// docs/contracts.md). Set ROBOT_BRIDGE_URL, e.g. http://localhost:8787.
//
// Anyone who can load this app can move the arm through this route. Keep it on your own network,
// or add a login before putting it on the internet.

const bridge = () => process.env.ROBOT_BRIDGE_URL?.replace(/\/+$/, "");

function headers(): HeadersInit {
  const token = process.env.ROBOT_BRIDGE_TOKEN;
  return token
    ? { "content-type": "application/json", authorization: `Bearer ${token}` }
    : { "content-type": "application/json" };
}

function toMessage(raw: unknown): RobotMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (body.action === "release" || body.action === "stop") return { action: body.action };
  if (body.action !== "fetch" && body.action !== "return" && body.action !== "take") return null;
  const position = body.position;
  if (typeof position !== "number" || !Number.isInteger(position) || position < 1 || position > 7) return null;
  // Angle is derived here rather than trusted from the client.
  const item = typeof body.item === "string" ? body.item.slice(0, MAX_NAME) : "";
  return { action: body.action, position, angle: angleOf(position), item };
}

export async function GET() {
  // Read the env at request time, not at build time.
  await connection();
  const url = bridge();
  if (!url) return Response.json({ configured: false, reachable: false });
  try {
    const res = await fetch(`${url}/status`, { headers: headers(), signal: AbortSignal.timeout(2500), cache: "no-store" });
    const body: unknown = await res.json().catch(() => null);
    const status = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const position = (value: unknown) => value === null || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7);
    const known = position(status.holding) && position(status.presenting);
    return Response.json({
      configured: true, reachable: res.ok, busy: status.busy === true,
      ...(status.mode === "dry-run" || status.mode === "serial" ? { mode: status.mode } : {}),
      ...(known ? { holding: status.holding, presenting: status.presenting } : {}),
      ...(typeof status.error === "string" ? { error: status.error } : {}),
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ configured: true, reachable: false });
  }
}

export async function POST(req: Request) {
  const url = bridge();
  if (!url) return Response.json({ error: "ROBOT_BRIDGE_URL is not set on the server." }, { status: 503 });

  const message = toMessage(await req.json().catch(() => null));
  if (!message) return Response.json({ error: "Unknown command." }, { status: 400 });

  let upstream: Response;
  try {
    upstream = await fetch(`${url}/command`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(message),
      // Pressing Stop on the phone aborts the request, which closes the connection to the bridge too.
      signal: message.action === "stop" ? AbortSignal.timeout(3000) : req.signal,
      cache: "no-store",
    });
  } catch {
    return Response.json({ error: "Couldn't reach the robot bridge.", network: true }, { status: 502 });
  }

  // Pass the bridge's reply straight through, streamed, so phase updates reach the phone as they happen.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
