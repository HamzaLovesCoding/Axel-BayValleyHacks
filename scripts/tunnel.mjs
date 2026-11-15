import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Checking the env file alone misses a Next process started before the passcode was set.
export async function verifyTunnelGate(passcode, request = fetch) {
  if (!passcode) throw new Error("Set APP_PASSCODE in .env.local and restart Next before opening a tunnel.");
  const options = { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(3000) };
  const [api, page] = await Promise.all([
    request("http://localhost:3001/api/robot", options),
    request("http://localhost:3001/", options),
  ]);
  const body = await api.json().catch(() => null);
  const location = new URL(page.headers.get("location") ?? "/", "http://localhost:3001");
  if (api.status !== 401 || body?.error !== "Enter the passcode to use Axel." ||
      page.status !== 307 || location.origin !== "http://localhost:3001" || location.pathname !== "/passcode")
    throw new Error("The app on port 3001 is not passcode-protected. Restart Next with APP_PASSCODE before opening a tunnel.");
}

export async function startTunnel({ passcode = process.env.APP_PASSCODE, request = fetch, launch = spawn } = {}) {
  await verifyTunnelGate(passcode, request);
  return launch("cloudflared", ["tunnel", "--url", "http://localhost:3001"], { stdio: "inherit" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const child = await startTunnel();
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.on("error", () => { console.error("Could not start cloudflared. Check that it is installed."); process.exitCode = 1; });
    child.on("exit", (code) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.exitCode = code ?? 1;
    });
  } catch {
    // Do not print arbitrary network bodies or environment values on a failed gate check.
    console.error("Tunnel refused. Set APP_PASSCODE, restart Next on port 3001, and verify the passcode screen first.");
    process.exitCode = 1;
  }
}
