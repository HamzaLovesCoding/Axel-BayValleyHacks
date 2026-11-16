import type { Angles } from "./config.ts";

// What the sequences drive. Two implementations: DryArm (below, no hardware) and SerialArm
// (serial-arm.ts, the Arduino over USB). Both must behave the same way as seen from here.

export class StoppedError extends Error {
  name = "StoppedError";
  constructor() {
    super("Stopped");
  }
}

export interface Arm {
  readonly mode: "dry-run" | "serial";
  // Connected and ready to move.
  ready(): boolean;
  // Where the arm is now, as the last commanded setpoint. With no position feedback this is the best
  // estimate there is; at the speeds used, the servos keep up with it.
  position(): Angles;
  // Moves every joint so they all arrive together, the one with the farthest to go peaking at `speed` °/s.
  // Resolves on arrival. Rejects with StoppedError if stop() is called first.
  move(target: Angles, speed: number): Promise<void>;
  // Freezes the arm where it is. A pending move() rejects with StoppedError.
  stop(): Promise<void>;
  close(): Promise<void>;
}

// Same curve as the firmware: normal moves start/end at zero commanded velocity. Stop and
// replacement interrupt that curve immediately; they do not provide continuous acceleration.
const smoothstep = (k: number) => k * k * (3 - 2 * k);

// A pretend arm with real timing. Used by `npm run bridge:dry` and the tests, so the whole app can be
// exercised with nothing plugged in. `timeScale` < 1 speeds it up (tests use 0.01).
export class DryArm implements Arm {
  readonly mode = "dry-run" as const;
  #from: number[];
  #to: number[];
  #start = 0;
  #duration = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reject: ((error: Error) => void) | undefined;
  #timeScale: number;
  #log: (line: string) => void;
  // Every move, for tests and for reading back what a sequence did.
  readonly history: { target: Angles; speed: number }[] = [];

  constructor(start: Angles, options: { timeScale?: number; log?: (line: string) => void } = {}) {
    this.#from = [...start];
    this.#to = [...start];
    this.#timeScale = options.timeScale ?? 1;
    this.#log = options.log ?? (() => {});
  }

  ready() {
    return true;
  }

  position(): Angles {
    if (!this.#duration) return [...this.#to];
    const k = Math.min(1, (performance.now() - this.#start) / this.#duration);
    const e = smoothstep(k);
    return this.#from.map((a, i) => Math.round((a + (this.#to[i] - a) * e) * 10) / 10);
  }

  move(target: Angles, speed: number): Promise<void> {
    this.#interrupt();
    const from = this.position();
    const farthest = Math.max(...target.map((a, i) => Math.abs(a - from[i])));
    this.history.push({ target: [...target], speed });
    this.#log(`M ${target.map((a) => Math.round(a)).join(" ")} ${speed}`);
    this.#from = [...from];
    this.#to = [...target];
    this.#start = performance.now();
    this.#duration = (Math.ceil((1500 * farthest) / speed) * this.#timeScale) || 0;
    if (!this.#duration) return Promise.resolve();

    return new Promise((resolve, reject) => {
      this.#reject = reject;
      this.#timer = setTimeout(() => {
        this.#reject = undefined;
        this.#duration = 0;
        resolve();
      }, this.#duration);
    });
  }

  async stop() {
    this.#log("S");
    this.#interrupt();
  }

  async close() {
    this.#interrupt();
  }

  #interrupt() {
    const here = this.position();
    clearTimeout(this.#timer);
    this.#from = [...here];
    this.#to = [...here];
    this.#duration = 0;
    const reject = this.#reject;
    this.#reject = undefined;
    reject?.(new StoppedError());
  }
}
