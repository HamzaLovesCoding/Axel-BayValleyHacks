import { parseArgs } from "node:util";
import { type Arm, DryArm } from "./arm.ts";
import { ConfigError, loadConfig, resolve } from "./config.ts";
import { SerialArm } from "./serial-arm.ts";
import { createBridge } from "./server.ts";

// The program that runs next to the arm (on the laptop, for now).
//
//   npm run bridge:dry                      pretend arm, real timing: try the whole app with nothing plugged in
//   npm run bridge -- --serial /dev/tty.usbmodem14101
//
// Then set ROBOT_BRIDGE_URL=http://localhost:8787 in .env.local and pick Robot in the app's Setup.

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    port: { type: "string", default: process.env.PORT ?? "8787" },
    config: { type: "string", default: "bridge/arm.json" },
    serial: { type: "string", default: process.env.ARM_SERIAL_PORT },
    "time-scale": { type: "string", default: "1" },
  },
});

const log = (line: string) => console.log(`${new Date().toLocaleTimeString()}  ${line}`);

async function main() {
  const config = await loadConfig(values.config);
  let arm: Arm;
  if (values["dry-run"]) {
    const stow = resolve(config.poses.stow, [], config);
    arm = new DryArm(stow, { timeScale: Number(values["time-scale"]), log: (line) => log(`[arm] ${line}`) });
  } else {
    if (!values.serial) throw new ConfigError("Say which serial port the Arduino is on: --serial /dev/tty.usbmodem… or ARM_SERIAL_PORT.");
    arm = await SerialArm.open(values.serial, config, { log: (line) => log(`[serial] ${line}`) });
  }

  const { server, stop } = createBridge({ arm, config, token: process.env.ROBOT_BRIDGE_TOKEN, log });
  server.listen(Number(values.port), "127.0.0.1", () => {
    log(`Bridge on http://localhost:${values.port} (${arm.mode}${config.taught ? "" : ", poses not taught yet"})`);
  });

  const shutdown = async () => {
    log("Stopping the arm and shutting down");
    await stop().catch(() => {});
    await arm.close().catch(() => {});
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? `✗ ${error.message}` : error);
  process.exit(1);
});
