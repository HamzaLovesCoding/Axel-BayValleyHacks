// Optional integration check. Uses an already running Chrome DevTools endpoint; no npm dependency.
// Start the app with test-only credentials, browser voice and a DryArm bridge. Never a real arm.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
const { values } = parseArgs({ options: {
  url: { type: "string", default: "http://127.0.0.1:3102" },
  cdp: { type: "string", default: "http://127.0.0.1:9364" },
  passcode: { type: "string", default: "qa-only-placeholder-passcode" },
  screenshot: { type: "string", default: "/tmp/axel-passcode.png" },
} });
const base = values.url;
assert.ok(["127.0.0.1", "localhost"].includes(new URL(base).hostname), "Local test servers only");
const login = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode: values.passcode }) });
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
const health = await (await fetch(`${base}/api/robot`, { headers: { cookie } })).json();
assert.equal(health.mode, "dry-run", "Refusing UI motion checks unless the app relay confirms DryArm");
assert.equal(health.reachable, true);
const target = await (await fetch(`${values.cdp}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no; });
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = ({ data }) => {
  const value = JSON.parse(data);
  if (value.id) {
    const item = pending.get(value.id);
    if (!item) return;
    pending.delete(value.id);
    clearTimeout(item.timer);
    if (value.error) item.no(new Error(value.error.message));
    else item.yes(value.result);
  } else if (value.method === "Runtime.exceptionThrown") errors.push(value.params.exceptionDetails.text);
};
const call = (method, params = {}) => new Promise((yes, no) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); no(new Error(`Timed out: ${method}`)); }, 20_000);
  pending.set(id, { yes, no, timer });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression: `(async () => (${expression}))()`, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Page evaluation failed");
  return result.result.value;
};
const wait = async (expression, label) => {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}: ${await evaluate('document.body.innerText')}`);
};
const fill = async (selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles:true }));
})()`);
const click = async (selector) => {
  const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...box });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...box });
};
const navigate = async (path) => { await call("Page.navigate", { url: base + path }); await wait("document.readyState === 'complete'", path); };
try {
  await call("Runtime.enable");
  await call("Page.enable");
  await call("Storage.clearDataForOrigin", { origin: base, storageTypes: "all" });
  await call("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await call("Emulation.setTouchEmulationEnabled", { enabled: true });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__wake = { requests: 0, active: 0 };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => {
      window.__wake.requests++; window.__wake.active++;
      const sentinel = new EventTarget(); sentinel.released = false;
      sentinel.release = async () => { if (!sentinel.released) {
        sentinel.released = true; window.__wake.active--; sentinel.dispatchEvent(new Event('release'));
      } };
      return sentinel;
    } } });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      const response = await originalFetch(url, init);
      if (url === '/api/robot' && !init?.method && window.__denyRelease) {
        return Response.json({ ...await response.json(), canRelease: false });
      }
      return response;
    };
    window.SpeechRecognition = class {
      start() { window.__voice = (text) => { this.onresult?.({results:[[{transcript:text}]]}); this.onend?.(); }; }
      stop() { this.onend?.(); } abort() { this.onend?.(); }
    };
    if (location.origin === ${JSON.stringify(base)}) {
      try { if (!localStorage.getItem('assistant-settings')) localStorage.setItem('assistant-settings', JSON.stringify({version:1,state:{speakReplies:false,robotMode:'sim'}})); } catch {}
    }
  ` });
  await navigate("/setup");
  await wait("location.pathname === '/passcode' && !!document.querySelector('input[name=passcode]')", "locked screen");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  assert.equal(await evaluate("document.querySelector('input').autocomplete"), "current-password");
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await call("Emulation.setDeviceMetricsOverride", { width: 812, height: 375, deviceScaleFactor: 1, mobile: true });
  await evaluate("document.documentElement.style.fontSize = '200%'");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true, "landscape large-text login");
  await evaluate("(() => { document.documentElement.style.fontSize = ''; document.documentElement.dataset.theme = 'dark'; })()");
  await call("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  const dark = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(values.screenshot.replace('.png', '-dark.png'), Buffer.from(dark.data, "base64"));
  await evaluate("document.documentElement.dataset.theme = 'light'");
  const shot = await call("Page.captureScreenshot", { format: "png" });
  await writeFile(values.screenshot, Buffer.from(shot.data, "base64"));
  await fill("#passcode", "wrong-test-passcode");
  await click("button[type=submit]");
  await wait("!!document.querySelector('[role=alert]')", "wrong passcode feedback");
  await fill("#passcode", values.passcode);
  await click("button[type=submit]");
  await wait("location.pathname === '/setup' && document.body.innerText.includes('Simulator')", "successful login");
  assert.ok(!(await evaluate("document.cookie")).includes("axel_session"), "httpOnly cookie is hidden from JS");
  assert.equal(await evaluate("(await fetch('/api/voice')).status"), 200);
  // Simulator: type the return, tap You to take it, then speak a return + go transcript.
  await navigate("/chat");
  await wait("!!document.querySelector('textarea, input[placeholder]')", "chat input");
  const chatSelector = await evaluate("document.querySelector('textarea') ? 'textarea' : 'input[placeholder]'");
  await fill(chatSelector, "Put the glasses back");
  await evaluate("document.querySelector('form').requestSubmit()");
  await wait("document.body.innerText.includes('in my hand and say go')", "typed simulator presentation");
  assert.equal(await evaluate("window.__wake.active"), 1, "presentation keeps the screen awake with Hands-free off");
  await navigate("/");
  // Simulator state is deliberately not persisted; start a fresh return using a real tile tap.
  await wait("!!document.querySelector('[aria-label=\"Bring me the glasses\"]')", "dial");
  await click('[aria-label="Bring me the glasses"]');
  await wait("!!document.querySelector('[aria-label=Release]:not([aria-disabled])')", "sim fetch");
  await click('[aria-label="Put the glasses back"]');
  await wait("document.body.innerText.includes('Done.')", "sim return");
  await wait("window.__wake.active === 0", "sim return releases wake lock");
  await sleep(750);
  await click('button[aria-label="Talk"]');
  await wait("typeof window.__voice === 'function'", "voice recognizer");
  await evaluate("window.__voice('Put the glasses back')");
  await wait("!!document.querySelector('[aria-label=\"Take it\"]:not([aria-disabled])')", "voice simulator presentation");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Take it\"]').dataset.state"), "offered");
  await click('[aria-label="Take it"]');
  await wait("document.body.innerText.includes('Done.')", "tap simulator hand-back");
  // Select the actual HTTP dry-run link through Setup, then exercise reconciliation on reload.
  await navigate("/setup");
  await wait("[...document.querySelectorAll('button')].some(b => b.innerText.includes('Robot'))", "Robot setting");
  await evaluate("[...document.querySelectorAll('button')].find(b => b.innerText.includes('Robot')).click()");
  await navigate("/chat");
  await wait("!!document.querySelector('textarea, input[placeholder]')", "robot chat");
  await fill(chatSelector, "Put the glasses back");
  await evaluate("document.querySelector('form').requestSubmit()");
  await wait("document.body.innerText.includes('in my hand and say go')", "HTTP presentation");
  await navigate("/");
  await wait("!!document.querySelector('[aria-label=\"Take it\"]:not([aria-disabled])')", "presenting reconciled on reload");
  await wait("window.__wake.active === 1", "reloaded HTTP presentation holds wake lock");
  await click('[aria-label="Take it"]');
  await wait("document.body.innerText.includes('Done.')", "HTTP tap hand-back");
  await sleep(750);
  await click('button[aria-label="Talk"]');
  await wait("typeof window.__voice === 'function'", "HTTP voice");
  await evaluate("window.__voice('Put the glasses back')");
  await wait("!!document.querySelector('[aria-label=\"Take it\"]:not([aria-disabled])')", "HTTP voice presentation");
  await sleep(750);
  await click('button[aria-label="Talk"]');
  await evaluate("window.__voice('go')");
  await wait("document.body.innerText.includes('Done.')", "HTTP voice go");
  await click('[aria-label="Bring me the glasses"]');
  await wait("!!document.querySelector('[aria-label=Release]:not([aria-disabled])')", "HTTP fetch ready to release");
  await evaluate("(() => { window.__denyRelease = true; window.dispatchEvent(new Event('focus')); })()");
  await wait("document.querySelector('[aria-label=Release]')?.getAttribute('aria-disabled') === 'true'", "You tile respects bridge release refusal");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b => b.innerText === 'Release')"), false, "Release chip follows bridge status");
  await evaluate("(() => { window.__denyRelease = false; window.dispatchEvent(new Event('focus')); })()");
  await wait("!!document.querySelector('[aria-label=Release]:not([aria-disabled])')", "release available again");
  await click('[aria-label="Release"]');
  await wait("document.body.innerText.includes('Done.')", "HTTP release");
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  for (const stop of ["button", "escape"]) {
    await wait("!!document.querySelector('button[aria-label=Talk]')", "ready for stop check");
    const status = await evaluate("(await (await fetch('/api/robot')).json())");
    const target = status.holding == null ? '[aria-label="Bring me the water"]' : '[aria-label="Put the water back"]';
    // Stop may land during grip-close: the UI must retain that item instead of offering a new fetch.
    await wait(`!!document.querySelector(${JSON.stringify(target + ':not([aria-disabled])')})`, "safe next command after Stop");
    await click(target);
    await wait("!!document.querySelector('button[aria-label=\"Stop the arm\"]')", "moving for stop check");
    await wait("window.__wake.active === 1", "moving holds wake lock with Hands-free off");
    if (stop === "button") await click('button[aria-label="Stop the arm"]');
    else await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await wait("document.body.innerText.includes('Stopped. Tell me what to do next.')", `${stop} confirms Stop`);
  }
  assert.deepEqual(errors, []);
  console.log("Browser checks passed: login/error/cookie, simulator and HTTP DryArm hand-back by typing, tapping and injected speech recognition; reload sync; release chip/tile status gating; fake wake-lock lifecycle; 375px layout.");
} finally {
  ws.close();
  await fetch(`${values.cdp}/json/close/${target.id}`).catch(() => {});
}
