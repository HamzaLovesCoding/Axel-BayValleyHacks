import http from "node:http";
import { STOP_FAILURE } from "../lib/robot/types.ts";
import { type Arm, StoppedError } from "./arm.ts";
import type { ArmConfig } from "./config.ts";
import { type ArmState, atHandoff, canRelease, CommandError, initialState, parseMessage, runCommand } from "./sequences.ts";

// The HTTP side of the bridge: docs/contracts.md §1. The Next app's /api/robot relays to this.

export type BridgeOptions = {
  arm: Arm;
  config: ArmConfig;
  token?: string;
  log?: (line: string) => void;
};

export function createBridge({ arm, config, token, log = () => {} }: BridgeOptions) {
  const state: ArmState = initialState();
  let current: AbortController | null = null;
  let stopFailed = false;
  const stopError = STOP_FAILURE;
  const ready = () => !stopFailed && arm.ready();

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const stopNow = async () => {
    // Even an unconfirmed stop leaves the pose unknown. Set this before any awaited I/O.
    state.needsRecovery = true;
    state.presenting = null;
    current?.abort();
    try {
      await arm.stop();
      return !stopFailed;
    } catch (error) {
      stopFailed = true;
      log(`✗ Stop failed: ${error instanceof Error ? error.message : String(error)}`);
      // Close even if a driver rejects without invalidating itself: no heartbeat may keep moving
      // firmware alive. Keep this catch shared by HTTP, deadman and shutdown callers.
      await arm.close().catch((closeError: unknown) => {
        log(`✗ Closing the arm failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
      });
      return false;
    }
  };

  const server = http.createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "Bad token" });

    if (req.method === "GET" && req.url === "/status") {
      const body = {
        ok: ready(),
        mode: arm.mode,
        taught: config.taught,
        taughtSpots: Object.entries(config.spots).filter(([, spot]) => spot.taught).map(([p]) => Number(p)),
        holding: state.holding,
        presenting: state.presenting,
        busy: current != null,
        grip: state.grip,
        needsRecovery: state.needsRecovery,
        atHandoff: atHandoff(arm, config),
        canRelease: ready() && current == null && canRelease(arm, config, state),
      };
      return ready() ? json(res, 200, body) : json(res, 503, { ...body, error: stopFailed ? stopError : "The arm isn't connected." });
    }

    if (req.method !== "POST" || req.url !== "/command") return json(res, 404, { error: "Not found" });

    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Bad JSON" });
    }
    const message = parseMessage(raw);
    if (!message) return json(res, 400, { error: "Unknown command." });
    log(`← ${JSON.stringify(message)}`);

    // Stop goes through no matter what else is happening.
    if (message.action === "stop") {
      const stopped = await stopNow();
      return stopped
        ? json(res, 200, { ok: true, stopped: true })
        : json(res, 503, { error: stopError });
    }
    if (current) return json(res, 409, { error: "I'm still moving." });
    if (!ready()) return json(res, 503, { error: stopFailed ? stopError : "The arm isn't connected." });
    if (arm.mode === "serial" && !config.taught)
      return json(res, 503, { error: "The arm isn't calibrated yet. Teach its poses with npm run jog first." });
    if (arm.mode === "serial" && "position" in message && !config.spots[message.position]?.taught)
      return json(res, 409, { error: "I haven't learned that spot yet." });

    const controller = new AbortController();
    current = controller;
    let finished = false;
    // Deadman: if the phone or the server goes away mid-move, the arm stops.
    res.on("close", () => {
      if (!finished && current === controller) void stopNow();
    });

    let started = false;
    const begin = () => {
      if (started) return;
      started = true;
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    };

    try {
      await runCommand(
        {
          arm,
          config,
          state,
          signal: controller.signal,
          emit: (phase, angle) => {
            begin();
            log(`→ ${phase} ${angle}`);
            res.write(`${JSON.stringify({ phase, angle })}\n`);
          },
        },
        message,
      );
      begin();
    } catch (error) {
      if (error instanceof CommandError) {
        if (!started) return json(res, error.status, { error: error.message });
        res.write(`${JSON.stringify({ error: error.message })}\n`);
      } else if (error instanceof StoppedError || controller.signal.aborted) {
        begin();
      } else {
        log(`✗ ${(error as Error).stack ?? error}`);
        state.needsRecovery = true;
        begin();
        res.write(`${JSON.stringify({ error: "Something went wrong moving the arm." })}\n`);
      }
    } finally {
      finished = true;
      if (current === controller) current = null;
    }
    res.end();
  });

  return { server, state, stop: stopNow };
}

function readBody(req: http.IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
