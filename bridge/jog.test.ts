import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DryArm, StoppedError, type Arm } from "./arm.ts";
import { loadConfig } from "./config.ts";
import { JogFile, JogSession } from "./jog.ts";

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "axel-jog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "arm.json");
  // The fixture's fixed reference poses, untaught: the real arm.json changes as the arm is calibrated.
  const fixture = await readFile(new URL("./fixtures/test-arm.json", import.meta.url), "utf8");
  const original = fixture.replace('"taught": true', '"taught": false');
  await writeFile(path, original);
  const file = await JogFile.open(path);
  return { dir, path, original, file };
}

test("jog saves every pose/grip/yaw with the contract's null masks, preserves layout, and undoes exactly", async (t) => {
  const { dir, path, original, file } = await setup(t);
  const angles = [91, 119, 31, 89, 91];
  for (const name of ["stow", "carry", "handoff", "above 1", "pick 7", "yaw 3", "open 4", "close 5"]) {
    await file.save(name, angles);
    assert.equal((await loadConfig(path)).taught, false);
  }
  const { poses, spots, grip } = await loadConfig(path);
  assert.deepEqual(poses.stow, angles);
  assert.deepEqual(poses.carry, [null, 119, 31, 89, null]);
  assert.deepEqual(poses.handoff, [91, 119, 31, 89, null]);
  assert.deepEqual(spots[1].above, poses.carry);
  assert.deepEqual(spots[7].pick, poses.carry);
  assert.equal(spots[3].yaw, 91);
  assert.equal(grip[4].open, 91);
  assert.equal(grip[5].close, 91);
  assert.equal((await readFile(path, "utf8")).split('  "poses":')[0], original.split('  "poses":')[0]);
  const before = await readFile(path, "utf8");
  await file.save("carry", [1, 2, 3, 4, 5]);
  await file.undo();
  assert.equal(await readFile(path, "utf8"), before);
  await assert.rejects(file.undo(), /Nothing to undo/);
  assert.deepEqual(await readdir(dir), ["arm.json"]);
});

test("jog refuses invalid saves, limit loosening, invalidating existing poses, and unsafe undo", async (t) => {
  const { path, original, file } = await setup(t);
  for (const name of ["above 0", "pick 8", "yaw 2 extra", "unknown", "carry extra"])
    await assert.rejects(file.save(name, [90, 120, 30, 90, 90]), /Save:/);
  await assert.rejects(file.save("stow", [181, 120, 30, 90, 90]), /outside/);
  await assert.rejects(file.save("stow", [NaN]), /finite/);
  await assert.rejects(file.limit(0, "min", -1), /loosen/);
  await assert.rejects(file.limit(0, "min", 20), /spots.1.yaw/);
  assert.equal(await readFile(path, "utf8"), original);
  await file.limit(0, "min", 5);
  assert.equal((await loadConfig(path)).joints.yaw.min, 5);
  await assert.rejects(file.undo(), /loosen/);
  await assert.rejects(file.limit(0, "min", 4), /loosen/);
});

test("jog never writes taught true and refuses overwriting external edits", async (t) => {
  const { path, file, original } = await setup(t);
  await writeFile(path, original + "\n");
  await assert.rejects(file.save("carry", [90, 120, 30, 90, 90]), /changed outside/);
  assert.equal(await readFile(path, "utf8"), original + "\n");
  await writeFile(path, original.replace('"taught": false', '"taught": true'));
  const taught = await JogFile.open(path);
  await assert.rejects(taught.save("carry", [90, 120, 30, 90, 90]), /never writes taught/);
});

test("jog has no motion queue, stays at 20 peak, checks clearance/limits, and Stop cancels stow recovery", async (t) => {
  const { file } = await setup(t);
  const arm = new DryArm([90, 120, 30, 90, 90], { timeScale: 0.01 });
  const session = new JogSession(arm, file, () => {});
  await assert.rejects(session.jog(1), /Clear wrist/);
  await session.command("clear");
  session.selected = 1;
  await session.jog(-1);
  session.selected = 0;
  await assert.rejects(session.jog(1), /Clear wrist/);
  await session.command("clear");
  await session.jog(1);
  assert.deepEqual(arm.position(), [91, 119, 30, 90, 90]);
  await assert.rejects(session.jog(100), /outside/);
  session.selected = 4;
  const move = session.jog(5);
  const interrupted = assert.rejects(move, StoppedError);
  await assert.rejects(session.jog(1), /still running/);
  await assert.rejects(session.command("s carry"), /still running/);
  await session.stop();
  await interrupted;
  session.selected = 0;
  await assert.rejects(session.jog(1), /Clear wrist/);
  const stow = session.command("yes");
  const cancelled = assert.rejects(stow, StoppedError);
  await session.stop();
  await cancelled;
  const count = arm.history.length;
  await sleep(30);
  assert.equal(arm.history.length, count, "Stop prevents later shoulder/yaw steps");
  assert.ok(arm.history.every(({ speed }) => speed === 20));
  assert.equal(await session.command("q"), "ask-stow");
  assert.equal(await session.command("no"), "quit");
  assert.equal(await session.command("yes"), "quit");
  assert.deepEqual(arm.position(), file.config.poses.stow);
});

test("a failed jog Stop closes the driver and latches motion disabled", async (t) => {
  const { file } = await setup(t);
  let closed = false;
  const arm: Arm = {
    mode: "dry-run", ready: () => true, position: () => [90, 120, 30, 90, 90],
    move: async () => assert.fail("must never move"),
    stop: async () => { throw new Error("no confirmation"); }, close: async () => { closed = true; },
  };
  const session = new JogSession(arm, file, () => {});
  await assert.rejects(session.stop(), /no confirmation/);
  assert.equal(closed, true);
  session.selected = 2;
  await assert.rejects(session.jog(1), /not ready/);
});

test("saved limits disable motion until matching firmware is reloaded", async (t) => {
  const { file } = await setup(t);
  const arm = new DryArm([5, 120, 30, 90, 90]);
  const session = new JogSession(arm, file, () => {});
  await session.command("l yaw min");
  session.selected = 2;
  await assert.rejects(session.jog(1), /Limits changed/);
  assert.equal(arm.history.length, 0);
});

test("actual --dry-run CLI: keys, shift arrows, save/undo, HTTP Stop, typed Stop and quit in place", async (t) => {
  const { path } = await setup(t);
  const child = spawn(process.execPath, ["bridge/jog.ts", "--dry-run", "--config", path, "--port", "0"], { env: { ...process.env, ROBOT_BRIDGE_TOKEN: "" } });
  t.after(() => { child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
  const waitFor = async (text: string, from = 0) => {
    const deadline = Date.now() + 5000;
    while (!output.slice(from).includes(text)) {
      if (Date.now() > deadline || child.exitCode != null) assert.fail(`Missing ${text}: ${output}`);
      await sleep(10);
    }
  };
  const send = async (keys: string, expected: string) => {
    const from = output.length;
    child.stdin.write(keys);
    await waitFor(expected, from);
  };
  await waitFor("1:yaw=");
  const port = output.match(/HTTP Stop on localhost:(\d+)/)?.[1];
  assert.ok(port);
  const url = `http://127.0.0.1:${port}`;
  assert.equal(((await (await fetch(`${url}/status`)).json()) as { mode: string }).mode, "serial");
  assert.equal((await fetch(`${url}/command`, { method: "POST", body: JSON.stringify({ action: "fetch", position: 2 }) })).status, 503);
  await send("5", "Selected grip");
  await send("\x1b[C", "M 90 120 30 90 91 20");
  await sleep(100);
  await send("\x1b[1;2D", "M 90 120 30 90 86 20");
  await sleep(420);
  // Spaces must still stop during command entry, without corrupting the save prompt.
  await send("s ", "Stopped.");
  await send("open 2\r", "Saved open 2");
  assert.equal((await loadConfig(path)).grip[2].open, 86);
  await send("u", "Undid last pose save");
  assert.equal((await loadConfig(path)).grip[2].open, 140);
  await send("\x1b[1;2C", "M 90 120 30 90 91 20");
  assert.equal((await fetch(`${url}/command`, { method: "POST", body: JSON.stringify({ action: "stop" }) })).status, 200);
  await sleep(100);
  await send("p", "5:grip=");
  assert.ok(!output.includes("5:grip=91°"), "HTTP Stop interrupted the 5° move");
  await send("stop", "Stopped.");
  await send("clear\r", "Wrist/elbow clearance confirmed");
  await send("clear\r", "Shoulder clearance confirmed");
  await send("1", "Selected yaw");
  await send("\x1b[C", "M 91 120 30 90");
  await send("\x1b", "Stopped.");
  await send("q", "yes/no");
  child.stdin.write("no\r");
  const code = await new Promise<number | null>((yes) => child.once("exit", yes));
  assert.equal(code, 0, output);
  assert.equal((await loadConfig(path)).taught, false);
});


test("dry-run CLI restores and exits on confirmed stow, Ctrl+C, SIGTERM and closed input", async (t) => {
  const { path } = await setup(t);
  for (const exit of ["stow", "ctrl-c", "signal", "eof"]) {
    const child = spawn(process.execPath, ["bridge/jog.ts", "--dry-run", "--config", path, "--port", "0"]);
    t.after(() => { child.kill("SIGKILL"); });
    let output = "";
    let started: () => void = () => {};
    const ready = new Promise<void>((yes) => { started = yes; });
    child.stdout.on("data", (data: Buffer) => { output += data.toString(); if (output.includes("1:yaw=")) started(); });
    child.stderr.on("data", (data: Buffer) => { output += data.toString(); });
    const exited = new Promise<number | null>((yes) => child.once("exit", yes));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await ready;
      if (exit === "stow") {
        child.stdin.write("q");
        const deadline = Date.now() + 1000;
        while (!output.includes("yes/no") && Date.now() < deadline) await sleep(10);
        assert.match(output, /yes\/no/);
        child.stdin.write("yes\r");
      } else if (exit === "ctrl-c") child.stdin.write("\x03");
      else if (exit === "signal") child.kill("SIGTERM");
      else child.stdin.end();
      assert.equal(await exited, 0, output);
      assert.match(output, /(?:^|\n)S(?:\r?\n|$)/);
      if (exit === "stow") {
        const moves = output.split("\n").filter((line) => line.startsWith("M "));
        assert.equal(moves.length, 3);
        assert.match(moves[0], /^M 90 120 40 80 90 20/);
        assert.match(moves[1], /^M 90 110 40 80 90 20/);
        assert.match(moves[2], /^M 90 120 30 90 90 20/);
      }
    } finally { clearTimeout(timeout); }
  }
});

test("jog and confirmed stow honour a nearPerson setting below 20", async (t) => {
  const { path, original } = await setup(t);
  const raw = JSON.parse(original);
  raw.speed.nearPerson = 8;
  await writeFile(path, JSON.stringify(raw));
  const file = await JogFile.open(path);
  const arm = new DryArm([90, 120, 30, 90, 90], { timeScale: 0 });
  const session = new JogSession(arm, file, () => {});
  session.selected = 2;
  await session.jog(1);
  await session.command("yes");
  assert.ok(arm.history.length >= 4);
  assert.ok(arm.history.every(({ speed }) => speed <= 8));
});
