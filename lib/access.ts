import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Server-only: cookies contain an expiring signed capability, never the passcode itself.
export const SESSION_COOKIE = "axel_session";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
let warned = false;

export function accessMode(): "protected" | "development" | "unconfigured" {
  if (process.env.APP_PASSCODE) return "protected";
  if (process.env.NODE_ENV === "development") {
    if (!warned) {
      console.warn("APP_PASSCODE is unset. Passcode protection is off in development. Set it before opening a tunnel.");
      warned = true;
    }
    return "development";
  }
  return "unconfigured";
}

const hash = (value: string) => createHash("sha256").update(value).digest();
export function matchesPasscode(value: unknown): boolean {
  const passcode = process.env.APP_PASSCODE;
  return !!passcode && typeof value === "string" && value.length <= 256 && timingSafeEqual(hash(value), hash(passcode));
}
const signature = (payload: string) => createHmac("sha256", process.env.APP_PASSCODE ?? "").update(`axel-session:${payload}`).digest("hex");

export function issueSession(now = Date.now()): string {
  if (!process.env.APP_PASSCODE) throw new Error("Passcode is not configured");
  const payload = `v1.${Math.floor(now / 1000) + SESSION_SECONDS}.${randomBytes(24).toString("hex")}`;
  return `${payload}.${signature(payload)}`;
}

export function validSession(value: string | undefined, now = Date.now()): boolean {
  if (!process.env.APP_PASSCODE || !value || value.length > 200) return false;
  const match = /^(v1\.(\d+)\.[a-f0-9]{48})\.([a-f0-9]{64})$/.exec(value);
  if (!match) return false;
  const expires = Number(match[2]);
  const seconds = Math.floor(now / 1000);
  if (expires <= seconds || expires > seconds + SESSION_SECONDS + 60) return false;
  return timingSafeEqual(Buffer.from(match[3], "hex"), Buffer.from(signature(match[1]), "hex"));
}

export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\")) return "/";
  // Resolve it the way a browser will (tabs and newlines are dropped, so "/\t/host" is "//host")
  // and keep only what stays on this origin.
  const base = "http://axel.invalid";
  let url: URL;
  try { url = new URL(value, base); } catch { return "/"; }
  if (url.origin !== base) return "/";
  const path = url.pathname;
  if (path === "/passcode" || path.startsWith("/api/") || path.startsWith("/_next/")) return "/";
  return path + url.search + url.hash;
}

export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    return new URL(origin).host === host;
  } catch { return false; }
}

// This is a single-laptop service. The global bucket cannot be bypassed by forging a client-IP
// header. It is intentionally process-local and resets on restart, not a distributed login system.
export function createLoginLimiter() {
  let started = 0;
  let count = 0;
  return (now = Date.now()) => {
    if (now - started >= 60_000) { started = now; count = 0; }
    return ++count <= 10;
  };
}
const allowLogin = createLoginLimiter();

export async function handleSession(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { "cache-control": "no-store", ...extra } });
  if (!sameOrigin(req)) return json({ error: "Open this page directly to enter the passcode." }, 403);
  const mode = accessMode();
  if (mode === "unconfigured") return json({ error: "Set APP_PASSCODE on the server before using Axel." }, 503);
  if (mode === "development") return json({ ok: true, next: "/" });
  if (!allowLogin()) return json({ error: "Too many tries. Wait a minute, then try again." }, 429, { "retry-after": "60" });
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("passcode" in body) || !matchesPasscode(body.passcode))
    return json({ error: "That passcode didn't match. Try again." }, 401);
  const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https" || process.env.NODE_ENV === "production";
  const cookie = `${SESSION_COOKIE}=${issueSession()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
  return json({ ok: true, next: safeNext("next" in body ? body.next : undefined) }, 200, { "set-cookie": cookie });
}
