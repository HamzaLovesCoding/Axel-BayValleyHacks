import { readFile, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { emitKeypressEvents } from "node:readline";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { type Arm, DryArm, StoppedError } from "./arm.ts";
import { type ArmConfig, JOINTS, loadConfig, only, parseConfig, resolve } from "./config.ts";
import { SerialArm } from "./serial-arm.ts";
import { createBridge } from "./server.ts";

// Calibration only: empty gripper, supported links, nobody in the hand-off area. Opening serial
// can reset the Uno to STOW. Complete docs/tasks.md T5's unloaded alignment before connecting.
// npm run jog -- --dry-run [--config <copy>] [--port 8787]
// 1–5 select · arrows ±1° · shift+arrows ±5° · p position · s save prompt · l limit prompt
// u undo · space/Esc/typed stop STOP · q quit (offers recovery then stow, never automatic)
// Saves: stow, carry, handoff, above N, pick N, yaw N, open N, close N.
// Limits: l <joint name or 1–5> min|max. Limits can only tighten; no limit bypass.
// After startup/Stop, manually clear wrist/elbow, type clear, clear shoulder, type clear again.
// Space also stops while editing a command; it remains a separator in that command.

type Path = readonly (string | number)[];
type Patch = { path: Path; value: unknown };

// Replace just a JSON value so the surrounding whitespace, key order and unrelated fields survive.
function patchJSON(source: string, patches: readonly Patch[]): string {
  const ranges = new Map<string, [number, number]>();
  const tokens = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\]:,]/g;
  const parts = [...source.matchAll(tokens)];
  let i = 0;
  const visit = (path: Path) => {
    const start = parts[i].index!;
    const token = parts[i++][0];
    if (token === "{" || token === "[") {
      const end = token === "{" ? "}" : "]";
      let index = 0;
      while (parts[i][0] !== end) {
        let key: string | number = index++;
        if (token === "{") {
          key = JSON.parse(parts[i++][0]) as string;
          i++;
        }
        visit([...path, key]);
        if (parts[i][0] === ",") i++;
      }
      i++;
    }
    const last = parts[i - 1];
    ranges.set(JSON.stringify(path), [start, last.index! + last[0].length]);
  };
  JSON.parse(source);
  visit([]);
  const replacements = patches.map(({ path, value }) => {
    const range = ranges.get(JSON.stringify(path));
    if (!range) throw new Error(`Missing config field ${path.join(".")}`);
    return { range, text: Array.isArray(value) ? JSON.stringify(value).replaceAll(",", ", ") : JSON.stringify(value) };
  }).sort((a, b) => b.range[0] - a.range[0]);
  for (const { range: [start, end], text } of replacements) source = source.slice(0, start) + text + source.slice(end);
  return source;
}

export class JogFile {
  config: ArmConfig;
  #path: string;
  #source: string;
  #undo: string | undefined;

  private constructor(path: string, source: string, config: ArmConfig) {
    this.#path = path;
    this.#source = source;
    this.config = config;
  }

  static async open(path: string) {
    await loadConfig(path);
    const source = await readFile(path, "utf8");
    return new JogFile(path, source, parseConfig(JSON.parse(source)));
  }

  async save(name: string, angles: readonly number[]) {
    const parts = name.trim().split(/\s+/);
    const [kind, spot] = parts;
    if (angles.length !== 5 || angles.some((angle) => !Number.isFinite(angle))) throw new Error("Expected five finite angles.");
    const current = resolve(angles, [], this.config).map(Math.round);
    let path: Path;
    let value: unknown;
    if (["stow", "carry", "handoff"].includes(kind) && parts.length === 1) {
      path = ["poses", kind];
      value = kind === "stow" ? current : kind === "carry"
        ? [null, ...current.slice(1, 4), null] : [...current.slice(0, 4), null];
    } else if (["above", "pick", "yaw", "open", "close"].includes(kind) && parts.length === 2 && /^[1-7]$/.test(spot)) {
      path = [kind === "open" || kind === "close" ? "grip" : "spots", spot, kind];
      value = kind === "yaw" ? current[0] : kind === "open" || kind === "close" ? current[4]
        : [null, ...current.slice(1, 4), null];
    } else throw new Error("Save: stow, carry, handoff, above N, pick N, yaw N, open N or close N (N=1–7).");
    await this.#write(patchJSON(this.#source, [{ path, value }]));
  }

  async limit(joint: number, side: string, angle: number) {
    if (!Number.isInteger(joint) || joint < 0 || joint > 4 || !["min", "max"].includes(side))
      throw new Error("Limit: l <joint name or 1–5> min|max.");
    const name = JOINTS[joint];
    const before = this.config.joints[name];
    const value = Math.round(angle);
    if ((side === "min" && value < before.min) || (side === "max" && value > before.max))
      throw new Error("Refusing to loosen a joint limit.");
    await this.#write(patchJSON(this.#source, [{ path: ["joints", name, side], value }]));
  }

  async undo() {
    if (!this.#undo) throw new Error("Nothing to undo.");
    await this.#write(this.#undo);
    this.#undo = undefined;
  }

  async #write(source: string) {
    const next = parseConfig(JSON.parse(source));
    if (this.config.taught || next.taught) throw new Error("Set taught to false manually before calibration. The jog tool never writes taught: true.");
    for (const joint of JOINTS) {
      if (next.joints[joint].min < this.config.joints[joint].min || next.joints[joint].max > this.config.joints[joint].max)
        throw new Error("Refusing to loosen a joint limit, including through undo.");
    }
    if (await readFile(this.#path, "utf8") !== this.#source)
      throw new Error("Config changed outside this tool. Quit and reload before saving.");
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(source);
      await file.sync();
      await file.close();
      // Validate the exact file that will replace the config, including all pose/limit rules.
      await loadConfig(temporary);
      if (await readFile(this.#path, "utf8") !== this.#source) throw new Error("Config changed before save. Quit and reload.");
      await rename(temporary, this.#path);
    } finally {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
    this.#undo = this.#source;
    this.#source = source;
    this.config = next;
  }
}

export class JogSession {
  selected = 0;
  busy = false;
  // Manual calibration cannot assume that placeholder carry angles are physically safe.
  #clearance = 0;
  #generation = 0;
  #stopping: Promise<void> | undefined;
  #failed = false;
  #limitsChanged = false;
  #arm: Arm;
  file: JogFile;
  #log: (line: string) => void;

  constructor(arm: Arm, file: JogFile, log: (line: string) => void) {
    this.#arm = arm;
    this.file = file;
    this.#log = log;
  }

  print() {
    this.#log(JOINTS.map((joint, i) => `${i + 1}:${joint}=${this.#arm.position()[i]}°`).join("  "));
  }

  stop(): Promise<void> {
    this.#clearance = 0;
    this.#generation++;
    this.#stopping ??= this.#arm.stop().catch(async (error: unknown) => {
      this.#failed = true;
      await this.#arm.close().catch(() => {});
      throw error;
    }).finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }

  async jog(delta: number) {
    this.#available();
    if ((this.selected === 0 && this.#clearance < 2) || (this.selected === 1 && this.#clearance < 1))
      throw new Error("Clear wrist/elbow first, type clear; then clear shoulder, type clear again before yaw.");
    const target = [...this.#arm.position()].map(Math.round);
    target[this.selected] += delta;
    await this.#move(resolve(target, this.#arm.position(), this.file.config));
  }

  async command(line: string): Promise<"quit" | "ask-stow" | void> {
    const [verb, ...args] = line.trim().toLowerCase().split(/\s+/);
    if (verb === "stop") { await this.stop(); this.#log("Stopped. Clearance must be confirmed again."); return; }
    if (verb === "p") return this.print();
    if (verb === "q") return "ask-stow";
    if (verb === "no") return "quit";
    // A separator can trigger Stop immediately before Enter. Saving/confirming clearance
    // may wait for that acknowledgement; motion never queues behind it.
    if (["s", "l", "u", "clear"].includes(verb) && this.#stopping) await this.#stopping;
    this.#available();
    if (verb === "clear" && !args.length) {
      this.#clearance = Math.min(2, this.#clearance + 1);
      this.#log(this.#clearance === 1 ? "Wrist/elbow clearance confirmed. Clear the shoulder next." : "Shoulder clearance confirmed. Yaw enabled.");
    } else if (verb === "s") {
      await this.file.save(args.join(" "), this.#arm.position());
      this.#log(`Saved ${args.join(" ")}. taught remains false.`);
    } else if (verb === "l") {
      const joint = /^[1-5]$/.test(args[0]) ? Number(args[0]) - 1 : JOINTS.findIndex((name) => name === args[0]);
      if (args.length !== 2) throw new Error("Limit: l <joint name or 1–5> min|max.");
      await this.file.limit(joint, args[1], this.#arm.position()[joint]);
      this.#limitsChanged = true;
      this.#log("Limit saved. Motion disabled: update config.h, compile/reflash from supported stow, then reconnect and verify L.");
    } else if (verb === "u" && !args.length) {
      await this.file.undo();
      this.#log("Undid last pose save.");
    } else if (verb === "yes" && !args.length) {
      const generation = this.#generation;
      const carry = this.file.config.poses.carry;
      for (const pose of [only({ elbow: carry[2], wrist: carry[3] }), only({ shoulder: carry[1] }), this.file.config.poses.stow]) {
        if (generation !== this.#generation) throw new StoppedError();
        await this.#move(resolve(pose, this.#arm.position(), this.file.config));
      }
      return "quit";
    } else throw new Error("Unknown command. Use s <pose>, l <joint> min|max, u, p, clear, stop or q.");
  }

  #available() {
    if (this.#failed || !this.#arm.ready()) throw new Error("Arm not ready. Switch off servo power and reconnect before moving.");
    if (this.#limitsChanged) throw new Error("Limits changed. Reflash matching firmware and reconnect before moving.");
    if (this.#stopping) throw new Error("Waiting for Stop confirmation.");
    if (this.busy) throw new Error("Move still running; space or Esc stops immediately.");
  }

  async #move(target: readonly number[]) {
    this.busy = true;
    try { await this.#arm.move(target, Math.min(20, this.file.config.speed.nearPerson)); }
    finally { this.busy = false; }
  }
}

export async function main() {
  const { values } = parseArgs({ options: {
    "dry-run": { type: "boolean", default: false },
    config: { type: "string", default: "bridge/arm.json" },
    serial: { type: "string", default: process.env.ARM_SERIAL_PORT },
    port: { type: "string", default: "8787" },
  } });
  const file = await JogFile.open(values.config);
  const controller = new AbortController();
  let arm: Arm | undefined;
  let session: JogSession | undefined;
  let finish: () => void = () => {};
  const done = new Promise<void>((yes) => { finish = yes; });
  const log = (line: string) => console.log(line);
  const report = (error: unknown) => {
    if (!(error instanceof StoppedError)) console.error(error instanceof Error ? error.message : String(error));
  };
  const stop = async () => {
    controller.abort();
    if (session) await session.stop();
    else if (arm) await arm.stop();
  };
  const shutdown = () => { void stop().catch(report).finally(finish); };
  const bridge = createBridge({ config: { ...file.config, taught: false }, token: process.env.ROBOT_BRIDGE_TOKEN,
    // Report serial here even in dry-run: this Stop-only server must refuse all autonomous
    // commands while teaching. The local jog session retains the actual arm mode.
    arm: { mode: "serial", ready: () => arm?.ready() ?? false, position: () => arm?.position() ?? [],
      move: async () => { throw new Error("Only local calibration controls may move the arm."); },
      stop, close: async () => { if (arm) await arm.close(); },
    },
  });
  const wasRaw = process.stdin.isRaw;
  let line = "";
  let editing = false;
  let asking = false;
  let writing = false;
  let typed = "";
  const dispatch = (command: string) => {
    if (!session) return;
    if (asking && command !== "yes" && command !== "no" && command !== "stop") {
      log("Answer yes to recover and stow, or no to quit in place."); return;
    }
    asking = false;
    if (writing) { log("Save in progress; Stop is still available."); return; }
    writing = true;
    void session.command(command).then((result) => {
      if (result === "quit") finish();
      if (result === "ask-stow") {
        asking = true;
        log("Recover via carry then move to stow at up to 20°/s (capped by nearPerson)? Only type yes if those poses are physically verified and the gripper is empty. yes/no (Enter).");
      }
    }).catch(report).finally(() => { writing = false; });
  };
  const echo = (text: string) => { if (process.stdin.isTTY) process.stdout.write(text); };
  const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean; shift?: boolean }) => {
    const name = key.name;
    if (name === "space" || text === " " || name === "escape" || (key.ctrl && name === "c")) {
      void stop().then(() => log("Stopped.")).catch(report);
      if (name === "escape") { line = ""; editing = false; asking = false; }
      if (key.ctrl && name === "c") finish();
      if ((name === "space" || text === " ") && editing) { line += " "; echo(" "); }
      return;
    }
    if (!session) return;
    if (name === "return" || name === "enter") {
      echo("\n");
      const command = line; line = ""; editing = false; typed = "";
      if (command) dispatch(command);
      return;
    }
    if (name === "backspace") { if (line) echo("\b \b"); line = line.slice(0, -1); return; }
    if (editing || asking) {
      if (text && !key.ctrl && text.length === 1) { line += text; echo(text); }
      if (line === "stop") {
        line = ""; editing = false; asking = false;
        void stop().then(() => log("Stopped.")).catch(report);
      }
      return;
    }
    if (name === "left" || name === "right") {
      if (writing) return;
      void session.jog((name === "left" ? -1 : 1) * (key.shift ? 5 : 1)).catch(report);
      typed = "";
    } else if (text && /^[1-5]$/.test(text)) {
      session.selected = Number(text) - 1;
      log(`Selected ${JOINTS[session.selected]}.`); typed = "";
    } else if (text === "s" || text === "l" || text === "c") {
      line = text; editing = true; log("Command (Enter to apply; space always also stops):"); echo(text);
    } else if (text === "p" || text === "u" || text === "q") dispatch(text);
    typed = (typed + (text ?? "")).slice(-4);
    if (typed === "stop" || line === "stop") { line = ""; editing = false; void stop().then(() => log("Stopped.")).catch(report); typed = ""; }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);
  process.stdin.on("end", shutdown);
  emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", keypress);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    await new Promise<void>((yes, no) => {
      bridge.server.once("error", no);
      bridge.server.listen(Number(values.port), "127.0.0.1", yes);
    });
    controller.signal.throwIfAborted();
    if (values["dry-run"]) arm = new DryArm(resolve(file.config.poses.stow, [], file.config), { log });
    else {
      if (!values.serial) throw new Error("Use --dry-run or --serial <port>. Complete T5's unloaded alignment before opening serial.");
      arm = await SerialArm.open(values.serial, file.config, { signal: controller.signal, log });
    }
    controller.signal.throwIfAborted();
    session = new JogSession(arm, file, log);
    log(`Jog (${arm.mode}). Empty gripper only. HTTP Stop on localhost:${bridge.server.address() && typeof bridge.server.address() === "object" ? (bridge.server.address() as { port: number }).port : values.port}.`);
    log("1–5 select; arrows ±1°, shift ±5°; p position; s pose; l joint min|max; u undo; space/Esc/stop STOP; q quit.");
    log("Clear wrist/elbow manually, type clear + Enter, clear shoulder, then clear + Enter before yaw. Never jog with a cup held.");
    session.print();
    await done;
  } finally {
    await stop().catch(report);
    if (arm) await arm.close().catch(report);
    bridge.server.closeAllConnections();
    await new Promise<void>((yes) => bridge.server.close(() => yes()));
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    process.off("SIGHUP", shutdown);
    process.stdin.off("end", shutdown);
    process.stdin.off("keypress", keypress);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
    process.stdin.pause();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
