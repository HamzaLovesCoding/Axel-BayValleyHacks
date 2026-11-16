import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { type Arm, StoppedError } from "./arm.ts";
import { type Angles, type ArmConfig, JOINTS, resolve } from "./config.ts";

type Options = { log?: (line: string) => void; signal?: AbortSignal };
type Reply = {
  matches: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Move = {
  target: number[];
  accepted: boolean;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// No hardware is opened by the constructor. Tests supply a duplex stream and call connect().
export class SerialArm implements Arm {
  readonly mode = "serial" as const;
  #stream: Duplex;
  #parser: ReadlineParser;
  #config: ArmConfig;
  #log: (line: string) => void;
  #ready = false;
  #bootSeen = false;
  #failure: Error | undefined;
  #connecting: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  #reply: Reply | undefined;
  #move: Move | undefined;
  // Preserve acknowledgement order when a replacement or Stop overtakes a pending OK.
  #acks: Move[] = [];
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #from: number[] = [];
  #target: number[] = [];
  #start = 0;
  #duration = 0;

  constructor(stream: Duplex, config: ArmConfig, options: Options = {}) {
    this.#stream = stream;
    this.#config = config;
    this.#log = options.log ?? (() => {});
    this.#parser = stream.pipe(new ReadlineParser({ delimiter: "\n", encoding: "ascii" }));
    this.#parser.on("data", (line: string) => this.#onLine(line.replace(/\r$/, "")));
    this.#parser.on("error", (error: Error) => this.#fail(error));
    stream.on("error", (error: Error) => this.#fail(error));
    stream.on("close", () => this.#fail(new Error("The serial port closed.")));
    stream.on("end", () => this.#fail(new Error("The serial port disconnected.")));
  }

  static async open(path: string, config: ArmConfig, options: Options = {}): Promise<SerialArm> {
    const port = new SerialPort({ path, baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", autoOpen: false });
    const arm = new SerialArm(port, config, options);
    const abort = () => { void arm.stop().catch(() => {}); };
    try {
      options.signal?.throwIfAborted();
      await new Promise<void>((yes, no) => port.open((error) => error ? no(error) : yes()));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        await arm.stop();
        options.signal.throwIfAborted();
      }
      await arm.connect(async () => {
        options.signal?.throwIfAborted();
        // Opening usually resets an Uno. If READY was missed, pulse DTR once and retry.
        await new Promise<void>((yes, no) => port.set({ dtr: false }, (error) => error ? no(error) : yes()));
        await sleep(100);
        options.signal?.throwIfAborted();
        await new Promise<void>((yes, no) => port.set({ dtr: true }, (error) => error ? no(error) : yes()));
      });
      options.signal?.throwIfAborted();
      return arm;
    } catch (error) {
      arm.#fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  connect(reset?: () => Promise<void>): Promise<void> {
    this.#connecting ??= this.#connect(reset);
    return this.#connecting;
  }

  async #connect(reset?: () => Promise<void>) {
    try {
      if (!this.#bootSeen) {
        try {
          await this.#wait((line) => /^READY \S+$/.test(line), 5000);
        } catch (error) {
          if (this.#failure || this.#stopping || error instanceof StoppedError || !reset) throw error;
          const ready = this.#wait((line) => /^READY \S+$/.test(line), 5000);
          // Attach a handler before resetting: a port drop must never leave an unhandled waiter.
          await Promise.all([ready, reset()]);
        }
      }
      const limits = this.#numbers(await this.#request("L", "LIM "), "LIM", 10);
      JOINTS.forEach((joint, i) => {
        const { min, max } = this.#config.joints[joint];
        if (limits[i * 2] !== min || limits[i * 2 + 1] !== max)
          throw new Error(`The ${joint} limits differ: firmware ${limits[i * 2]}–${limits[i * 2 + 1]}, config ${min}–${max}.`);
      });
      await this.#readPosition();
      this.#ready = true;
    } catch (error) {
      // During startup, let an explicit Stop reach the wire and reconcile P before closing.
      if (this.#stopping) await this.#stopping.catch(() => {});
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  ready(): boolean {
    return this.#ready && !this.#failure;
  }

  position(): Angles {
    if (!this.#from.length) throw new Error("The arm's position is not known yet.");
    if (!this.#duration) return [...this.#target];
    const k = Math.min(1, (performance.now() - this.#start) / this.#duration);
    const e = k * k * (3 - 2 * k);
    return this.#from.map((a, i) => Math.round((a + (this.#target[i] - a) * e) * 10) / 10);
  }

  move(target: Angles, speed: number): Promise<void> {
    if (!this.ready()) return Promise.reject(this.#failure ?? new Error("The arm is not ready."));
    if (this.#stopping) return Promise.reject(new StoppedError());
    if (target.length !== 5 || target.some((a) => !Number.isFinite(a)) || !Number.isFinite(speed) || speed < 1 || speed > 180)
      return Promise.reject(new Error("Expected five angles and a speed from 1 to 180."));
    // Check before and after rounding; never round an out-of-limit input into an accepted one.
    let angles: number[];
    try {
      resolve(target, this.position(), this.#config);
      angles = [...resolve(target.map(Math.round), this.position(), this.#config)];
    } catch (error) {
      return Promise.reject(error);
    }
    this.#finishMove(new StoppedError());
    this.#from = [...this.position()];
    this.#target = angles;
    this.#duration = 0;
    const peak = Math.max(1, Math.floor(speed));
    const duration = Math.ceil(1500 * Math.max(...angles.map((a, i) => Math.abs(a - this.#from[i]))) / peak);
    return new Promise<void>((yes, no) => {
      const move: Move = {
        target: angles, accepted: false, resolve: yes, reject: no,
        timer: setTimeout(() => this.#fail(new Error("The arm did not acknowledge the move.")), 500),
      };
      this.#move = move;
      this.#acks.push(move);
      this.#start = performance.now();
      this.#duration = duration;
      this.#heartbeat = setInterval(() => this.#write("H"), 200);
      this.#write(`M ${angles.join(" ")} ${peak}`);
    });
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    if (this.#failure) return Promise.reject(this.#failure);
    this.#finishMove(new StoppedError());
    // S bypasses movement and any pending query. It is never queued behind DONE.
    this.#rejectReply(new StoppedError());
    this.#stopping = this.#stop().finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }

  async #stop() {
    try {
      await this.#request("S", "STOPPED", 500);
      await this.#readPosition();
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      if (!this.#failure) await this.stop();
    } finally {
      this.#fail(new Error("The serial link was closed."));
    }
  }

  #numbers(line: string, prefix: string, count: number): number[] {
    const tokens = line.split(" ");
    if (tokens.shift() !== prefix || tokens.length !== count || tokens.some((s) => !/^\d+$/.test(s)))
      throw new Error(`Malformed firmware reply: ${line}`);
    return tokens.map(Number);
  }

  async #readPosition() {
    const angles = this.#numbers(await this.#request("P", "POS "), "POS", 5);
    if (angles.some((a, i) => a < this.#config.joints[JOINTS[i]].min || a > this.#config.joints[JOINTS[i]].max))
      throw new Error("The firmware reported a position outside the joint limits.");
    this.#from = angles;
    this.#target = [...angles];
    this.#duration = 0;
  }

  #request(command: string, prefix: string, timeout = 500): Promise<string> {
    const reply = this.#wait((line) => prefix === "STOPPED"
      ? line === "STOPPED" || line === "STOPPED watchdog"
      : line.startsWith(prefix), timeout);
    this.#write(command);
    return reply;
  }

  #wait(matches: (line: string) => boolean, timeout: number): Promise<string> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#reply) return Promise.reject(new Error("A serial query is already pending."));
    return new Promise((yes, no) => {
      this.#reply = {
        matches, resolve: yes, reject: no,
        timer: setTimeout(() => this.#rejectReply(new Error("Timed out waiting for the Arduino.")), timeout),
      };
    });
  }

  #write(line: string) {
    if (this.#failure) return;
    this.#log(`→ ${line}`);
    try {
      this.#stream.write(`${line}\n`, (error?: Error | null) => { if (error) this.#fail(error); });
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #onLine(line: string) {
    this.#log(`← ${line}`);
    if (this.#failure) return;
    if (/^READY \S+$/.test(line)) {
      if (this.#ready) return this.#fail(new Error("The Arduino restarted. Reconnect before moving."));
      this.#bootSeen = true;
    } else if (line === "OK") {
      const move = this.#acks.shift();
      if (move && move === this.#move) {
        move.accepted = true;
        clearTimeout(move.timer);
        move.timer = setTimeout(() => this.#fail(new Error("The arm did not finish the move.")), this.#duration + 1000);
      }
    } else if (line === "DONE") {
      // An earlier move's DONE can already be on the wire when its replacement is sent.
      if (this.#move?.accepted) this.#finishMove();
    } else if (line === "STOPPED" || line === "STOPPED watchdog") {
      const expected = this.#reply?.matches(line);
      this.#finishMove(new StoppedError());
      // A watchdog stop bypasses the server's recovery bookkeeping. Reconnect rather than let
      // another sequence assume it still starts at a known pose.
      if (!expected) return this.#fail(new StoppedError());
    } else if (line.startsWith("ERR ")) {
      // A refused replacement leaves the old firmware move running. Its setpoint no longer
      // matches our estimate, so stop heartbeats and require reconnect before another command.
      return this.#fail(new Error(line));
    }
    const reply = this.#reply;
    if (reply?.matches(line)) {
      this.#reply = undefined;
      clearTimeout(reply.timer);
      reply.resolve(line);
    }
  }

  #finishMove(error?: Error) {
    const move = this.#move;
    if (!move) return;
    const here = error ? this.position() : move.target;
    this.#from = [...here];
    this.#target = [...here];
    this.#duration = 0;
    this.#move = undefined;
    clearTimeout(move.timer);
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    if (error) move.reject(error);
    else move.resolve();
  }

  #rejectReply(error: Error) {
    const reply = this.#reply;
    this.#reply = undefined;
    if (reply) {
      clearTimeout(reply.timer);
      reply.reject(error);
    }
  }

  #fail(error: Error) {
    if (this.#failure) return;
    this.#failure = error;
    this.#ready = false;
    this.#finishMove(error);
    this.#rejectReply(error);
    this.#acks = [];
    // Close the native handle as well as the streams; stopped heartbeats freeze the firmware.
    if (this.#stream instanceof SerialPort && this.#stream.isOpen)
      this.#stream.close(() => {});
    this.#stream.unpipe(this.#parser);
    this.#parser.destroy();
    this.#stream.destroy();
  }
}
