import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { setImmediate as flush, setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SerialArm } from "./serial-arm.ts";
import { StoppedError } from "./arm.ts";
import { loadConfig } from "./config.ts";
import { createBridge } from "./server.ts";
import { runBench } from "./bench-serial.ts";

const config = await loadConfig(fileURLToPath(new URL("./fixtures/test-arm.json", import.meta.url)));
const start = [90, 120, 30, 90, 90];
const target = [120, 120, 30, 90, 90];

// Nothing in this file opens or enumerates a serial device.
class FirmwareStream extends Duplex {
  commands: string[] = [];
  handler: ((line: string) => void) | undefined;
  position = [...start];
  limits = "LIM 0 180 0 180 0 180 0 180 0 180";
  failWrite = false;
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.failWrite) return callback(new Error("write failed"));
    const line = chunk.toString().trimEnd();
    this.commands.push(line);
    callback();
    if (this.handler) this.handler(line);
    else this.defaultReply(line);
  }
  defaultReply(line: string) {
    if (line === "L") this.reply(`${this.limits}\r\n`);
    if (line === "P") this.reply(`POS ${this.position.join(" ")}\n`);
    if (line === "S") this.reply("STOPPED\n");
  }
  reply(text: string) { this.push(text); }
}

async function rig(t: TestContext) {
  const stream = new FirmwareStream();
  const log: string[] = [];
  const arm = new SerialArm(stream, config, { log: (line) => log.push(line) });
  t.after(() => arm.close());
  const connection = arm.connect();
  stream.reply("REA");
  stream.reply("DY 0.1.0\r\n");
  await connection;
  return { arm, stream, log };
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  return async (ms: number) => { now += ms; t.mock.timers.tick(ms); await flush(); };
}

test("serial handshake requires READY, matching limits and P; chunks and CRLF work", async (t) => {
  const { arm, stream, log } = await rig(t);
  assert.equal(arm.ready(), true);
  assert.deepEqual(stream.commands, ["L", "P"]);
  assert.deepEqual(arm.position(), start);
  assert.ok(log.includes("← READY 0.1.0") && log.includes("→ L"));
});

test("move waits for OK then DONE, interpolates peak-speed easing, snaps on DONE", async (t) => {
  const { arm, stream, log } = await rig(t);
  const tick = clock(t);
  let done = false;
  const move = arm.move([100, 115, 30, 90, 90], 60).then(() => { done = true; });
  assert.equal(stream.commands.at(-1), "M 100 115 30 90 90 60");
  stream.reply("DONE\n");
  await flush();
  assert.equal(done, false, "a stale DONE before OK cannot finish a new move");
  stream.reply("OK\n");
  await tick(125);
  assert.deepEqual(arm.position(), [95, 117.5, 30, 90, 90]);
  assert.equal(done, false);
  stream.reply("DONE\n");
  await move;
  assert.deepEqual(arm.position(), [100, 115, 30, 90, 90]);
  assert.ok(log.includes("← OK") && log.includes("← DONE"));
});

test("heartbeats occur every 200 ms only while a move is pending", async (t) => {
  const { arm, stream } = await rig(t);
  const tick = clock(t);
  await tick(600);
  assert.ok(!stream.commands.includes("H"));
  const move = arm.move(target, 10);
  stream.reply("OK\n");
  await tick(199);
  assert.equal(stream.commands.filter((s) => s === "H").length, 0);
  await tick(1);
  assert.equal(stream.commands.filter((s) => s === "H").length, 1);
  await tick(200);
  assert.equal(stream.commands.filter((s) => s === "H").length, 2);
  stream.reply("DONE\n");
  await move;
  await tick(1000);
  assert.equal(stream.commands.filter((s) => s === "H").length, 2);
});

test("firmware ERR rejects the pending move and clears heartbeats", async (t) => {
  const { arm, stream } = await rig(t);
  const tick = clock(t);
  const rejected = assert.rejects(arm.move(target, 10), /ERR limit 1/);
  stream.reply("ERR limit 1\n");
  await rejected;
  await tick(600);
  assert.ok(!stream.commands.includes("H"));
});

test("a rejected replacement requires reconnect and cannot start another move from an uncertain position", async (t) => {
  const { arm, stream } = await rig(t);
  const tick = clock(t);
  const old = assert.rejects(arm.move(target, 10), StoppedError);
  stream.reply("OK\n");
  await tick(200);
  const replacement = assert.rejects(arm.move(start, 10), /ERR parse/);
  await old;
  // Refusing M does not cancel the firmware's previous move. The local estimate is now unsafe.
  stream.reply("ERR parse\n");
  await replacement;
  assert.equal(arm.ready(), false);
  assert.equal(stream.destroyed, true);
  const count = stream.commands.length;
  await assert.rejects(arm.move(target, 10), /ERR parse/);
  await tick(1000);
  assert.equal(stream.commands.length, count, "no further motion or heartbeat after the refusal");
});

test("STOPPED and STOPPED watchdog reject with StoppedError", async (t) => {
  for (const reply of ["STOPPED", "STOPPED watchdog"]) {
    const { arm, stream } = await rig(t);
    const rejected = assert.rejects(arm.move(target, 10), StoppedError);
    stream.reply(`OK\n${reply}\n`);
    await rejected;
    assert.equal(arm.ready(), false, "unexpected firmware stops require reconnect and startup recovery");
  }
});

test("Stop bypasses missing move OK, shares concurrent stops and learns frozen POS", async (t) => {
  const { arm, stream } = await rig(t);
  stream.position = [91, 120, 30, 90, 90];
  const rejected = assert.rejects(arm.move(target, 10), StoppedError);
  const stopped = arm.stop();
  assert.equal(arm.stop(), stopped);
  assert.equal(stream.commands.at(-1), "S", "S is written immediately, without waiting for OK");
  stream.reply("OK\n");
  await stopped;
  await rejected;
  assert.deepEqual(stream.commands.slice(-2), ["S", "P"]);
  assert.deepEqual(arm.position(), stream.position);
});

test("a replacement rejects the old move; late OK/DONE cannot settle the new move", async (t) => {
  const { arm, stream } = await rig(t);
  const tick = clock(t);
  const old = assert.rejects(arm.move(target, 10), StoppedError);
  await tick(100);
  let done = false;
  const replacement = arm.move(start, 10).then(() => { done = true; });
  await old;
  stream.reply("OK\nDONE\n");
  await flush();
  assert.equal(done, false);
  stream.reply("OK\nDONE\n");
  await replacement;
  assert.deepEqual(arm.position(), start);
});

test("limit mismatch refuses connect, names the joint, and never sends M", async () => {
  const stream = new FirmwareStream();
  stream.limits = "LIM 0 180 1 180 0 180 0 180 0 180";
  const arm = new SerialArm(stream, config);
  const rejected = assert.rejects(arm.connect(), /shoulder limits differ/);
  stream.reply("READY 0.1.0\n");
  await rejected;
  assert.equal(arm.ready(), false);
  assert.deepEqual(stream.commands, ["L"]);
  assert.equal(stream.destroyed, true);
});

test("malformed limits or position cannot make a serial arm ready", async () => {
  for (const position of [false, true]) {
    const stream = new FirmwareStream();
    stream.handler = (line) => {
      if (line === "L" && !position) stream.reply("LIM 0 180\n");
      else if (line === "P") stream.reply("POS 999 120 30 90 90\n");
      else stream.defaultReply(line);
    };
    const arm = new SerialArm(stream, config);
    const rejected = assert.rejects(arm.connect(), position ? /outside/ : /Malformed/);
    stream.reply("READY 0.1.0\n");
    await rejected;
    assert.equal(arm.ready(), false);
  }
});

test("port close, error, readable end, and write failure reject a move and clear ready", async (t) => {
  for (const failure of ["close", "error", "end", "write"]) {
    const { arm, stream } = await rig(t);
    if (failure === "write") stream.failWrite = true;
    const rejected = assert.rejects(arm.move(target, 10), /closed|failed|unplugged|disconnected/);
    if (failure === "close") stream.destroy();
    if (failure === "error") stream.emit("error", new Error("unplugged"));
    if (failure === "end") stream.push(null);
    await rejected;
    assert.equal(arm.ready(), false);
  }
});

test("move ack and completion timeouts stop heartbeats and require reconnect", async (t) => {
  const tick = clock(t);
  const { arm, stream } = await rig(t);
  const rejected = assert.rejects(arm.move(target, 10), /acknowledge/);
  await tick(500);
  await rejected;
  assert.equal(arm.ready(), false);
  const count = stream.commands.length;
  await tick(2000);
  assert.equal(stream.commands.length, count);

  const second = await rig(t);
  const missingDone = assert.rejects(second.arm.move([100, 120, 30, 90, 90], 60), /finish/);
  second.stream.reply("OK\n");
  await flush();
  await tick(1250);
  await missingDone;
  assert.equal(second.arm.ready(), false);
});

test("missing STOPPED times out in 500 ms and leaves the link not ready", async (t) => {
  const { arm, stream } = await rig(t);
  const tick = clock(t);
  stream.handler = () => {};
  const rejected = assert.rejects(arm.stop(), /Timed out/);
  await tick(500);
  await rejected;
  assert.equal(arm.ready(), false);
});

test("READY timeout retries once through reset; another timeout fails closed", async (t) => {
  const tick = clock(t);
  const stream = new FirmwareStream();
  const arm = new SerialArm(stream, config);
  let resets = 0;
  const connected = arm.connect(async () => { resets++; stream.reply("READY 0.1.0\n"); });
  await tick(5000);
  await connected;
  assert.equal(resets, 1);
  assert.equal(arm.ready(), true);
  await arm.close();

  const absent = new SerialArm(new FirmwareStream(), config);
  const rejected = assert.rejects(absent.connect(async () => { resets++; }), /Timed out/);
  await tick(5000);
  await tick(5000);
  await rejected;
  assert.equal(absent.ready(), false);
});

test("an unexpected firmware reboot rejects motion and requires reconnect", async (t) => {
  const { arm, stream } = await rig(t);
  const rejected = assert.rejects(arm.move(target, 10), /restarted/);
  stream.reply("READY 0.1.0\n");
  await rejected;
  assert.equal(arm.ready(), false);
});

test("invalid or rounded-outside targets never write M; fractional speed rounds down", async (t) => {
  const { arm, stream } = await rig(t);
  for (const [angles, speed] of [[target.slice(1), 10], [[NaN, 120, 30, 90, 90], 10], [[181, 120, 30, 90, 90], 10], [target, 0]] as const)
    await assert.rejects(arm.move(angles, speed));
  assert.ok(!stream.commands.some((line) => line.startsWith("M ")));
  const move = arm.move([100.4, 120, 30, 90, 90], 10.9);
  stream.reply("OK\nDONE\n");
  await move;
  assert.equal(stream.commands.at(-1), "M 100 120 30 90 90 10");
});

test("HTTP status is serial/ready after fake handshake, 503 after a drop; taught false blocks motion", async (t) => {
  const { arm, stream } = await rig(t);
  const { server } = createBridge({ arm, config: { ...config, taught: false } });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  t.after(() => new Promise<void>((yes) => server.close(() => yes())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const status = await fetch(`${url}/status`);
  assert.equal(status.status, 200);
  const body: unknown = await status.json();
  assert.ok(body && typeof body === "object" && "mode" in body);
  assert.equal(body.mode, "serial");
  const motion = await fetch(`${url}/command`, { method: "POST", body: JSON.stringify({ action: "fetch", position: 2 }) });
  assert.equal(motion.status, 503);
  stream.destroy();
  await flush();
  assert.equal((await fetch(`${url}/status`)).status, 503);
});

test("firmware refusal during an HTTP sequence requires recovery and refuses subsequent motion", async (t) => {
  const { arm, stream } = await rig(t);
  const { server, state } = createBridge({ arm, config });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  t.after(() => new Promise<void>((yes) => server.close(() => yes())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  stream.handler = (line) => {
    if (line.startsWith("M ")) stream.reply("ERR parse\n");
    else stream.defaultReply(line);
  };
  const fetchItem = () => fetch(`${url}/command`, { method: "POST", body: JSON.stringify({ action: "fetch", position: 2 }) });
  const response = await fetchItem();
  assert.match(await response.text(), /Something went wrong moving the arm/);
  assert.equal(state.needsRecovery, true);
  assert.equal((await fetch(`${url}/status`)).status, 503);
  const count = stream.commands.length;
  assert.equal((await fetchItem()).status, 503);
  assert.equal(stream.commands.length, count);
});

test("bench stop and replacement commands are timed at 200 ms against a fake stream", async (t) => {
  const tick = clock(t);
  for (const check of ["stop", "replace"] as const) {
    const { arm, stream } = await rig(t);
    stream.handler = (line) => {
      if (line.startsWith("M ")) {
        stream.reply("OK\n");
        if (stream.commands.filter((s) => s.startsWith("M ")).length === 2) stream.reply("DONE\n");
      } else stream.defaultReply(line);
    };
    const running = runBench(arm, target, check, new AbortController().signal);
    await tick(199);
    assert.equal(stream.commands.filter((s) => s.startsWith("M ")).length, 1);
    assert.ok(!stream.commands.includes("S"));
    await tick(1);
    await running;
    if (check === "stop") assert.ok(stream.commands.includes("S"));
    else assert.equal(stream.commands.filter((s) => s.startsWith("M ")).length, 2);
  }
});

test("Stop during READY wait goes straight to S and P before failing startup", async () => {
  const stream = new FirmwareStream();
  const arm = new SerialArm(stream, config);
  let reset = false;
  const rejected = assert.rejects(arm.connect(async () => { reset = true; }), StoppedError);
  await arm.stop();
  await rejected;
  assert.equal(reset, false, "Stop must not trigger a DTR reset retry");
  assert.deepEqual(stream.commands, ["S", "P"]);
  assert.equal(arm.ready(), false);
});

test("missing POS after Stop and malformed STOPPED cannot report successful stopping", async (t) => {
  const tick = clock(t);
  for (const malformed of [false, true]) {
    const { arm, stream } = await rig(t);
    stream.handler = (line) => {
      if (line === "S") stream.reply(malformed ? "STOPPED junk\n" : "STOPPED\n");
    };
    const rejected = assert.rejects(arm.stop(), /Timed out/);
    await flush();
    await tick(500);
    await rejected;
    assert.equal(arm.ready(), false);
    assert.equal(stream.commands.includes("P") && stream.commands.filter((s) => s === "P").length > 1, !malformed);
  }
});

test("bench full move keeps heartbeats until DONE; interrupted bench cannot start its replacement", async (t) => {
  const tick = clock(t);
  const { arm, stream } = await rig(t);
  const running = runBench(arm, target, "full", new AbortController().signal);
  stream.reply("OK\n");
  await tick(200);
  await tick(200);
  await tick(200);
  assert.equal(stream.commands.filter((s) => s === "H").length, 3);
  stream.reply("DONE\n");
  await running;

  const controller = new AbortController();
  const interrupted = assert.rejects(runBench(arm, start, "replace", controller.signal), /abort/i);
  controller.abort();
  await interrupted;
  await arm.stop();
  assert.equal(stream.commands.filter((s) => s.startsWith("M ")).length, 2);
});

test("HTTP Stop timeout returns the exact 503, stops heartbeats and keeps the bridge running", { timeout: 4000 }, async (t) => {
  const { arm, stream } = await rig(t);
  const { server, state } = createBridge({ arm, config });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  t.after(() => new Promise<void>((yes) => server.close(() => yes())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  let heartbeatsAtStop = -1;
  stream.handler = (line) => {
    if (line.startsWith("M ")) stream.reply("OK\n");
    else if (line === "S") heartbeatsAtStop = stream.commands.filter((s) => s === "H").length;
    else stream.defaultReply(line);
  };
  const moving = assert.rejects(arm.move(target, 10), StoppedError);
  await sleep(220);
  state.needsRecovery = false;
  state.presenting = 2;
  const stop = await fetch(`${url}/command`, { method: "POST", body: JSON.stringify({ action: "stop" }) });
  const error = "I couldn't confirm the arm stopped. Switch off its power.";
  assert.equal(stop.status, 503);
  assert.deepEqual(await stop.json(), { error });
  await moving;
  assert.equal(arm.ready(), false);
  assert.equal(state.needsRecovery, true);
  assert.equal(state.presenting, null);
  assert.ok(heartbeatsAtStop >= 1);
  assert.equal(stream.commands.filter((s) => s === "H").length, heartbeatsAtStop);
  const status = await fetch(`${url}/status`);
  assert.equal(status.status, 503);
  const body: unknown = await status.json();
  assert.ok(body && typeof body === "object" && "error" in body && "ok" in body);
  assert.equal(body.error, error);
  assert.equal(body.ok, false);
  // The process and HTTP listener must survive, including subsequent Stop attempts.
  const again = await fetch(`${url}/command`, { method: "POST", body: JSON.stringify({ action: "stop" }) });
  assert.equal(again.status, 503);
  assert.deepEqual(await again.json(), { error });
});

test("deadman Stop rejection is caught; recovery/status and later requests still work", { timeout: 4000 }, async (t) => {
  const { arm, stream } = await rig(t);
  let reportFailure: () => void = () => {};
  const failed = new Promise<void>((yes) => { reportFailure = yes; });
  const { server, state } = createBridge({ arm, config: { ...config, taught: true }, log: (line) => {
    if (line.startsWith("✗ Stop failed:")) reportFailure();
  } });
  await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
  t.after(() => new Promise<void>((yes) => server.close(() => yes())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  let heartbeatsAtStop = -1;
  stream.handler = (line) => {
    if (line.startsWith("M ")) stream.reply("OK\n");
    else if (line === "S") heartbeatsAtStop = stream.commands.filter((s) => s === "H").length;
    else stream.defaultReply(line);
  };
  state.needsRecovery = false;
  const controller = new AbortController();
  const response = await fetch(`${url}/command`, {
    method: "POST", body: JSON.stringify({ action: "fetch", position: 2 }), signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /turning/);
  await sleep(220);
  controller.abort();
  await reader.cancel().catch(() => {});
  await failed;
  assert.equal(state.needsRecovery, true);
  assert.equal(arm.ready(), false);
  assert.ok(heartbeatsAtStop >= 1);
  assert.equal(stream.commands.filter((s) => s === "H").length, heartbeatsAtStop);
  const status = await fetch(`${url}/status`);
  assert.equal(status.status, 503);
  const body: unknown = await status.json();
  assert.ok(body && typeof body === "object" && "error" in body);
  assert.equal(body.error, "I couldn't confirm the arm stopped. Switch off its power.");
  const stop = await fetch(`${url}/command`, { method: "POST", body: JSON.stringify({ action: "stop" }) });
  assert.equal(stop.status, 503);
  assert.deepEqual(await stop.json(), { error: "I couldn't confirm the arm stopped. Switch off its power." });
});
