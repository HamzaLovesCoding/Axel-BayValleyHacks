// Read-only laptop checks. Never import a serial driver or open a device here.
import { readFile, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { loadConfig, JOINTS } from "./config.ts";

let failures = 0;
const report = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures++;
};
report(Number(process.versions.node.split(".")[0]) >= 24, "Node 24 or newer");
for (const tool of ["arduino-cli", "whisper-server", "ffmpeg", "cloudflared"])
  report(spawnSync("which", [tool], { stdio: "ignore" }).status === 0, `${tool} installed`);
const require = createRequire(import.meta.url);
for (const name of ["next", "serialport", "@serialport/parser-readline"]) {
  try { require.resolve(name); report(true, `${name} installed`); }
  catch { report(false, `${name} installed; run npm ci`); }
}
report(!!process.env.APP_PASSCODE, "Private app passcode configured (value hidden)");
for (const [key, port] of [["ROBOT_BRIDGE_URL", "8787"], ["WHISPER_URL", "8080"]]) {
  let ok = false;
  try {
    const url = new URL(process.env[key] ?? "");
    ok = url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && url.port === port;
  } catch {}
  report(ok, `${key} targets the documented local service`);
}
console.log(`INFO Shared bridge token ${process.env.ROBOT_BRIDGE_TOKEN ? "configured" : "unset (optional for loopback-only bridge)"}`);
try { await access(`${homedir()}/.cache/whisper.cpp/ggml-base.en.bin`); report(true, "Whisper base.en model installed"); }
catch { report(false, "Whisper model missing; follow README installation"); }
try {
  const config = await loadConfig("bridge/arm.json");
  const header = await readFile("firmware/axel-arm/config.h", "utf8");
  const expected = {
    PINS: JOINTS.map(j => config.joints[j].pin),
    US_AT_0: JOINTS.map(j => config.joints[j].us[0]),
    US_AT_180: JOINTS.map(j => config.joints[j].us[1]),
    MIN_DEG: JOINTS.map(j => config.joints[j].min),
    MAX_DEG: JOINTS.map(j => config.joints[j].max),
    STOW: config.poses.stow,
  };
  for (const [name, values] of Object.entries(expected)) {
    const match = header.match(new RegExp(`${name}\\[JOINT_COUNT\\]\\s*=\\s*\\{([^}]+)\\}`));
    const actual = match?.[1].split(",").map(v => Number(v.trim()));
    report(JSON.stringify(actual) === JSON.stringify(values), `${name} matches bridge and firmware source`);
  }
  console.log(`INFO taught=${config.taught}; source agreement does not prove calibration or what is flashed.`);
} catch { report(false, "Calibration files load and validate"); }
console.log("Hardware remains unverified. Follow docs/first-connection.md; do not energize coupled links at placeholder STOW.");
process.exitCode = failures ? 1 : 0;
