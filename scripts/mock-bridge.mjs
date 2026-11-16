// Stand-in for the program that runs next to the arm. It speaks the same protocol the real bridge
// should, so you can try Setup → Arm → Robot without hardware:
//
//   node scripts/mock-bridge.mjs          (then set ROBOT_BRIDGE_URL=http://localhost:8787)
//
// Protocol (what the real bridge has to implement):
//   GET  /status   → 200 when the arm is ready.
//   POST /command  ← {"action":"fetch"|"return","position":1-7,"angle":0-180,"item":"glasses"}
//                    {"action":"release"} | {"action":"stop"}
//                  → newline-delimited JSON while it moves, one line per phase:
//                    {"phase":"turning","angle":30}
//                    and closes the response when the move is done. {"error":"..."} reports a failure.
//                    Replying once with {"ok":true} at the end also works; you just lose live progress.
//   If the phone presses Stop, the app sends {"action":"stop"} and drops the /command connection.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.ROBOT_BRIDGE_TOKEN;

const steps = {
  fetch: (m) => [["turning", m.angle, 1000], ["gripping", m.angle, 800], ["bringing", 270, 1400], ["holding", 270, 0]],
  release: () => [["releasing", 270, 700], ["stowing", 90, 900], ["stowed", 90, 0]],
  return: (m) => [["returning", m.angle, 1400], ["placing", m.angle, 800], ["stowing", 90, 900], ["stowed", 90, 0]],
};

let cancelCurrent = () => {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "Bad token" });
    if (req.method === "GET" && req.url === "/status") return json(res, 200, { ok: true });
    if (req.method !== "POST" || req.url !== "/command") return json(res, 404, { error: "Not found" });

    let message;
    try {
      message = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Bad JSON" });
    }
    console.log("←", message);

    if (message.action === "stop") {
      cancelCurrent();
      return json(res, 200, { ok: true });
    }
    const plan = steps[message.action];
    if (!plan) return json(res, 400, { error: `Unknown action ${message.action}` });

    let cancelled = false;
    cancelCurrent = () => (cancelled = true);
    res.on("close", () => (cancelled = true));
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const [phase, angle, ms] of plan(message)) {
      if (cancelled) break;
      res.write(`${JSON.stringify({ phase, angle })}\n`);
      console.log("→", phase, angle);
      await sleep(ms);
    }
    res.end();
  })
  .listen(PORT, () => console.log(`Mock robot bridge on http://localhost:${PORT}`));
