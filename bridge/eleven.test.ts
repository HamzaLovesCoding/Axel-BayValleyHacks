/// <reference lib="dom" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as flush } from "node:timers/promises";
import { handleSpeak, ELEVEN_MODEL } from "../lib/voice/eleven-server.ts";
import { speakEleven, unlockEleven } from "../lib/voice/eleven.ts";

const request = (text: unknown) => new Request("http://localhost/api/speak", { method: "POST", body: JSON.stringify({ text }) });
function credentials(t: import("node:test").TestContext) {
  // Tests use placeholders only and never read .env.local or call the real provider.
  for (const [name, value] of Object.entries({ ELEVENLABS_API_KEY: "test-key", ELEVENLABS_VOICE_ID: "test-voice" })) {
    const before = process.env[name];
    process.env[name] = value;
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
  }
}
const reply = (text: string) => ({ audio_base64: "YXVkaW8=", alignment: {
  characters: [...text], character_start_times_seconds: [...text].map((_, i) => i / 10),
} });

test("Eleven server keeps auth upstream, selects Flash, and maps word starts to original indices", async (t) => {
  credentials(t);
  const text = "Hi 😀 water.";
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.match(url, /test-voice\/with-timestamps\?output_format=mp3_44100_128$/);
    assert.equal(new Headers(options.headers).get("xi-api-key"), "test-key");
    assert.equal(JSON.parse(String(options.body)).model_id, ELEVEN_MODEL);
    assert.equal(options.signal?.aborted, false);
    return Response.json(reply(text));
  });
  const res = await handleSpeak(request(text));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { audio: "YXVkaW8=", mime: "audio/mpeg", chars: [
    { i: 0, t: 0 }, { i: 3, t: 0.3 }, { i: 6, t: 0.5 },
  ] });
});

test("Eleven server rejects invalid input and missing configuration without a provider call", async (t) => {
  credentials(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call"); });
  for (const text of ["", "   ", "x".repeat(301), null, 12]) assert.equal((await handleSpeak(request(text))).status, 400);
  assert.equal((await handleSpeak(new Request("http://localhost", { method: "POST", body: "{" }))).status, 400);
  process.env.ELEVENLABS_API_KEY = "";
  assert.equal((await handleSpeak(request("Hi"))).status, 503);
  assert.equal(fetch.mock.callCount(), 0);
});

test("Eleven server returns sanitized 502 for provider errors, bad alignment/audio and timeouts", async (t) => {
  credentials(t);
  const text = "Hi water";
  for (const data of [
    { ...reply(text), audio_base64: "" },
    { ...reply(text), alignment: null },
    { ...reply(text), alignment: { characters: [...text], character_start_times_seconds: [0] } },
    reply("different"),
    { ...reply(text), alignment: { characters: [...text], character_start_times_seconds: [...text].map(() => -1) } },
  ]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(data));
    assert.equal((await handleSpeak(request(text))).status, 502);
  }
  t.mock.method(globalThis, "fetch", async () => new Response("private provider details", { status: 401 }));
  const denied = await handleSpeak(request(text));
  assert.equal(denied.status, 502);
  assert.ok(!(await denied.text()).includes("private"));
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => { assert.equal(ms, 10_000); return controller.signal; });
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => new Promise((_yes, no) => {
    options.signal?.addEventListener("abort", () => no(new Error("timed out")));
    controller.abort();
  }));
  assert.equal((await handleSpeak(request(text))).status, 502);
});

class Source {
  buffer: unknown;
  onended: (() => void) | null = null;
  stopped = false;
  started = false;
  connect() {}
  disconnect() {}
  start() { this.started = true; }
  stop() { this.stopped = true; this.onended?.(); }
}
class Context {
  static instance: Context;
  state = "suspended";
  currentTime = 0;
  destination = {};
  sources: Source[] = [];
  constructor() { Context.instance = this; }
  async resume() { this.state = "running"; }
  createBuffer() { return {}; }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  async decodeAudioData() { return {}; }
}

function browser(t: import("node:test").TestContext) {
  for (const [name, value] of Object.entries({ window: { AudioContext: Context }, requestAnimationFrame: (): number => 1, cancelAnimationFrame: (): void => {} })) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    t.after(() => { if (before) Object.defineProperty(globalThis, name, before); else Reflect.deleteProperty(globalThis, name); });
  }
  t.after(() => { if (Context.instance) Context.instance.state = "closed"; });
}

test("Eleven playback uses the audio clock, cancels old replies, stops audio, and ends once", async (t) => {
  browser(t);
  let frame: FrameRequestCallback | undefined;
  t.mock.method(globalThis, "requestAnimationFrame", (cb: FrameRequestCallback) => { frame = cb; return 1; });
  t.mock.method(globalThis, "cancelAnimationFrame", () => { frame = undefined; });
  t.mock.method(globalThis, "fetch", async () => Response.json({ audio: "YXVkaW8=", mime: "audio/mpeg", chars: [
    { i: 0, t: 0 }, { i: 3, t: 0.5 },
  ] }));
  unlockEleven();
  const ctx = Context.instance;
  const indices: number[] = [];
  let ends = 0;
  const stop = speakEleven("Hi water", (i) => indices.push(i), () => { ends++; });
  assert.ok(stop);
  await flush();
  assert.equal(ctx.sources.at(-1)?.started, true);
  ctx.currentTime = 0.6;
  frame?.(0);
  assert.equal(indices.at(-1), 3);
  const source = ctx.sources.at(-1);
  stop(); stop();
  assert.equal(source?.stopped, true);
  assert.equal(ends, 1);
  assert.equal(frame, undefined);

  let completed = 0;
  const naturalStop = speakEleven("Hi water", () => {}, () => { completed++; });
  await flush();
  ctx.sources.at(-1)?.onended?.();
  naturalStop?.();
  assert.equal(completed, 1, "natural end followed by Stop completes only once");

  let oldEnds = 0;
  const first = speakEleven("Hi water", () => {}, () => { oldEnds++; });
  const next = speakEleven("Hi water", () => {}, () => {});
  assert.ok(first && next);
  assert.equal(oldEnds, 1);
  next();
});

test("Eleven async errors fall back; Stop cancels fallback and delayed fetch cannot play", async (t) => {
  browser(t);
  t.mock.method(globalThis, "requestAnimationFrame", () => 1);
  t.mock.method(globalThis, "cancelAnimationFrame", () => {});
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 502 }));
  let ends = 0;
  let fallbacks = 0;
  let stoppedFallback = 0;
  const stop = speakEleven("Hi water", () => {}, () => { ends++; }, (finish) => {
    fallbacks++;
    return () => { stoppedFallback++; finish(); };
  });
  await flush();
  assert.ok(stop);
  assert.equal(fallbacks, 1);
  assert.equal(ends, 0);
  stop(); stop();
  assert.equal(ends, 1);
  assert.equal(stoppedFallback, 1);

  let complete: (value: Response) => void = () => {};
  let signal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    signal = options.signal;
    return new Promise<Response>((yes) => { complete = yes; });
  });
  const pending = speakEleven("Hi water", () => {}, () => { ends++; });
  assert.ok(pending);
  pending();
  assert.equal(signal?.aborted, true);
  complete(Response.json({ audio: "YXVkaW8=", mime: "audio/mpeg", chars: [{ i: 0, t: 0 }] }));
  await flush();
  assert.equal(ends, 2);
});
