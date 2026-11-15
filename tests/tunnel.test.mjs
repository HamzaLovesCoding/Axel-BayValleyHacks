import assert from "node:assert/strict";
import { test } from "node:test";
import { startTunnel } from "../scripts/tunnel.mjs";

test("tunnel refuses missing passcode, stale open server, wrong gate and failed checks before launching", async () => {
  let launched = 0;
  const launch = () => { launched++; };
  const passcode = "public-test-placeholder";
  for (const request of [
    async () => Response.json({ reachable: true }),
    async () => Response.json({ error: "Another service" }, { status: 401 }),
    async () => { throw new Error("Offline"); },
    async (url) => url.endsWith("/api/robot")
      ? Response.json({ error: "Enter the passcode to use Axel." }, { status: 401 })
      : new Response(null, { status: 307, headers: { location: "https://other.example/passcode" } }),
  ]) await assert.rejects(startTunnel({ passcode, request, launch }));
  await assert.rejects(startTunnel({ passcode: "", request: () => { throw new Error("Must not fetch"); }, launch }), /Set APP_PASSCODE/);
  assert.equal(launched, 0);
});

test("tunnel launches only after checking both unauthenticated routes without sending the passcode", async () => {
  const calls = [];
  const launches = [];
  await startTunnel({ passcode: "public-test-placeholder", request: async (url, options) => {
    calls.push({ url, options });
    return url.endsWith("/api/robot")
      ? Response.json({ error: "Enter the passcode to use Axel." }, { status: 401 })
      : new Response(null, { status: 307, headers: { location: "/passcode?next=%2F" } });
  }, launch: (...args) => launches.push(args) });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ options }) => options.redirect === "manual" && options.headers === undefined && options.body === undefined));
  assert.deepEqual(launches, [["cloudflared", ["tunnel", "--url", "http://localhost:3001"], { stdio: "inherit" }]]);
});
