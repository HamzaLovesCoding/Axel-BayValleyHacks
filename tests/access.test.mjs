import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server.js";
import { accessMode, createLoginLimiter, handleSession, issueSession, matchesPasscode, safeNext, SESSION_COOKIE, SESSION_SECONDS, validSession } from "../lib/access.ts";
import { proxy } from "../proxy.ts";

function env(t, values) {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
const passcode = "test-only-passcode-example";
const req = (path, options) => new NextRequest(`https://axel.example${path}`, options);

test("signed sessions reject absence, tampering, expiry and passcode rotation", (t) => {
  env(t, { APP_PASSCODE: passcode, NODE_ENV: "production" });
  assert.equal(matchesPasscode(passcode), true);
  for (const value of [null, "wrong", "", 123, "x".repeat(257)]) assert.equal(matchesPasscode(value), false);
  const now = 100_000;
  const token = issueSession(now);
  assert.equal(validSession(token, now), true);
  assert.equal(validSession(token, now + SESSION_SECONDS * 1000), false);
  for (const value of [undefined, "true", token.slice(0, -1), token.replace("v1", "v2"), token + "x", token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")])
    assert.equal(validSession(value, now), false);
  process.env.APP_PASSCODE = "rotated-test-only-passcode";
  assert.equal(validSession(token, now), false);
});

test("Proxy protects every page and API, including file-like and RSC requests", (t) => {
  env(t, { APP_PASSCODE: passcode, NODE_ENV: "production" });
  for (const path of ["/", "/chat", "/setup", "/anything.json", "/?_rsc=123", "/_next/data/build/setup.json"]) {
    const res = proxy(req(path, { headers: { rsc: "1", "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy" } }));
    assert.equal(res.status, 307, path);
    assert.equal(new URL(res.headers.get("location")).pathname, "/passcode");
  }
  for (const path of ["/api", "/api/robot", "/api/assistant", "/api/speak", "/api/transcribe", "/api/voice", "/api/unknown.json"]) {
    const res = proxy(req(path, { method: "POST" }));
    assert.equal(res.status, 401, path);
  }
  assert.equal(proxy(req("/passcode")).headers.get("x-middleware-next"), "1");
  assert.equal(proxy(req("/api/session", { method: "POST" })).headers.get("x-middleware-next"), "1");
  assert.equal(proxy(req("/_next/static/chunks/app.js")).headers.get("x-middleware-next"), "1");
  const cookie = `${SESSION_COOKIE}=${issueSession()}`;
  assert.equal(proxy(req("/setup", { headers: { cookie } })).headers.get("x-middleware-next"), "1");
  assert.equal(proxy(req("/api/robot", { method: "POST", headers: { cookie, origin: "https://axel.example" } })).headers.get("x-middleware-next"), "1");
  assert.equal(proxy(req("/api/robot", { method: "POST", headers: { cookie, origin: "https://other.example" } })).status, 403);
  assert.equal(proxy(req("/api/robot", { headers: { cookie: `${SESSION_COOKIE}=true` } })).status, 401);
});

test("login sets an httpOnly secure strict cookie, rejects wrong passcodes and foreign origins", async (t) => {
  env(t, { APP_PASSCODE: passcode, NODE_ENV: "production" });
  const post = (body, origin = "https://axel.example") => handleSession(new Request("https://axel.example/api/session", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  assert.equal((await post({ passcode: "wrong" })).status, 401);
  assert.equal((await post({ passcode }, "https://other.example")).status, 403);
  const response = await post({ passcode, next: "/chat" });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  for (const property of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${SESSION_SECONDS}`]) assert.ok(cookie.includes(property));
  assert.ok(!cookie.includes(passcode));
  assert.deepEqual(await response.json(), { ok: true, next: "/chat" });
  const token = cookie.split(";")[0].split("=")[1];
  assert.equal(validSession(token), true);
  for (const path of ["//evil.example", "https://evil.example", "/\\evil", "/api/robot", "/passcode", "/\t/evil.example", "/\n/evil.example", "/\r\n//evil.example"]) assert.equal(safeNext(path), "/");
  assert.equal(safeNext("/chat?x=1"), "/chat?x=1");
});

test("login attempt limiting has a bounded one-minute window", () => {
  const allow = createLoginLimiter();
  for (let i = 0; i < 10; i++) assert.equal(allow(10_000), true);
  assert.equal(allow(10_000), false);
  assert.equal(allow(59_999), false);
  assert.equal(allow(60_000), true);
});

test("unset passcode warns and opens development, but production fails closed", (t) => {
  env(t, { APP_PASSCODE: undefined, NODE_ENV: "development" });
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(accessMode(), "development");
  assert.equal(accessMode(), "development");
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(proxy(req("/api/robot")).headers.get("x-middleware-next"), "1");
  process.env.NODE_ENV = "production";
  assert.equal(accessMode(), "unconfigured");
  assert.equal(proxy(req("/api/robot")).status, 503);
  assert.equal(proxy(req("/")).status, 503);
});
