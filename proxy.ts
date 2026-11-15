import { NextResponse, type NextRequest } from "next/server";
import { accessMode, sameOrigin, SESSION_COOKIE, validSession } from "./lib/access";

// Match every route, including APIs, prefetches and file-like paths. Only login and the assets
// needed to render it are public. Authentication never depends on client state or cookie presence.
export function proxy(req: NextRequest) {
  const mode = accessMode();
  if (mode === "development") return NextResponse.next();
  const { pathname } = req.nextUrl;
  const json = (error: string, status: number) => NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
  if (mode === "unconfigured") return json("Set APP_PASSCODE on the server before using Axel.", 503);
  if (pathname.startsWith("/_next/static/") || pathname === "/_next/image" || pathname === "/favicon.ico")
    return NextResponse.next();
  if (pathname === "/passcode" || pathname === "/api/session") return NextResponse.next();
  // Browsers fetch the manifest and home-screen icons without cookies. They hold nothing private.
  if (pathname === "/manifest.webmanifest" || pathname === "/icon" || pathname === "/apple-icon") return NextResponse.next();
  if (!validSession(req.cookies.get(SESSION_COOKIE)?.value)) {
    if (pathname === "/api" || pathname.startsWith("/api/")) return json("Enter the passcode to use Axel.", 401);
    const url = new URL("/passcode", req.url);
    url.searchParams.set("next", pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) return json("Open Axel directly before sending a command.", 403);
  const response = NextResponse.next();
  response.headers.set("cache-control", "private, no-store");
  return response;
}
