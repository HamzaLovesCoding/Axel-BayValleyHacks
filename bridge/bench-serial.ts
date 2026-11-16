import timers from "node:timers/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { Arm } from "./arm.ts";
import { StoppedError } from "./arm.ts";
import { loadConfig } from "./config.ts";
import { SerialArm } from "./serial-arm.ts";
import { createBridge } from "./server.ts";

type Check = "stop" | "replace" | "full";

// Only loose, mechanically disconnected servos. This deliberately bypasses taught-pose recovery.
export async function runBench(arm: Arm, target: readonly number[], check: Check, signal: AbortSignal) {
  signal.throwIfAborted();
  const start = [...arm.position()];
  // Observe rejection immediately, before the timed Stop/replacement can reject the move.
  const first = arm.move(target, 10).then(() => "done" as const, (error: unknown) => error);
  if (check === "full") {
    const result = await first;
    if (result !== "done") throw result;
    return;
  }
  await timers.setTimeout(200, undefined, { signal });
  signal.throwIfAborted();
  if (check === "stop") await arm.stop();
  else await arm.move(start, 10);
  const result = await first;
  if (!(result instanceof StoppedError)) throw new Error("The first move was not interrupted as expected.");
}

async function main() {
  const { values } = parseArgs({ options: {
    serial: { type: "string" },
    config: { type: "string", default: "bridge/arm.json" },
    check: { type: "string" },
    "loose-servos": { type: "boolean", default: false },
    port: { type: "string", default: "8787" },
  } });
  if (!values["loose-servos"] || !values.serial || !["stop", "replace", "full"].includes(values.check ?? ""))
    throw new Error("Use --loose-servos --serial <port> --check stop|replace|full. Remove horns/disconnect links first; never run on an assembled arm.");
  const check = values.check as Check;
  const config = await loadConfig(values.config);
  const controller = new AbortController();
  let arm: SerialArm | undefined;
  const interrupt = () => {
    controller.abort();
    if (arm) void arm.stop().catch(() => {});
  };
  let typed = "";
  const input = (data: Buffer) => {
    const text = data.toString("utf8").toLowerCase();
    typed = (typed + text).slice(-32);
    if (/[\x1b\x03 ]/.test(text) || typed.includes("stop")) interrupt();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  process.stdin.on("data", input);
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const log = (line: string) => console.log(`${performance.now().toFixed(0)} ms  ${line}`);
  // The existing HTTP Stop route also interrupts the bench, including app/voice Stop.
  const bridge = createBridge({
    config: { ...config, taught: false }, token: process.env.ROBOT_BRIDGE_TOKEN,
    arm: {
      mode: "serial", ready: () => arm?.ready() ?? false,
      position: () => arm?.position() ?? [],
      move: async () => { throw new Error("Use the bench's timed checks."); },
      stop: async () => { controller.abort(); if (arm) await arm.stop(); },
      close: async () => { if (arm) await arm.close(); },
    },
  });
  try {
    await new Promise<void>((yes, no) => {
      bridge.server.once("error", no);
      bridge.server.listen(Number(values.port), "127.0.0.1", yes);
    });
    controller.signal.throwIfAborted();
    arm = await SerialArm.open(values.serial, config, { log, signal: controller.signal });
    controller.signal.throwIfAborted();
    const target = [...arm.position()];
    const { min, max } = config.joints.yaw;
    const direction = target[0] + 10 <= max ? 10 : -10;
    if (target[0] + direction < min) throw new Error("The yaw limits do not allow this 10° loose-servo check.");
    target[0] += direction;
    console.log(`Running ${check}. Space, Esc, Ctrl+C, typed stop, or app Stop interrupts. HTTP Stop: localhost:${values.port}.`);
    await runBench(arm, target, check, controller.signal);
    controller.signal.throwIfAborted();
    console.log(`${check}: passed. Confirm physical motion/freeze on the loose servo; replies alone cannot prove it.`);
  } finally {
    if (arm) await arm.close().catch(() => {});
    await new Promise<void>((yes) => bridge.server.close(() => yes()));
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    process.stdin.off("data", input);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
    process.stdin.pause();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
