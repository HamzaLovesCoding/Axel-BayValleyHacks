// One context is resumed inside the user's tap, then reused after the network request completes.
let context: AudioContext | null = null;
let activeStop: (() => void) | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Context = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  if (!context || context.state === "closed") context = new Context();
  return context;
}

export function unlockEleven() {
  try {
    const ctx = audioContext();
    if (!ctx) return;
    void ctx.resume().catch(() => {});
    const silent = ctx.createBufferSource();
    silent.buffer = ctx.createBuffer(1, 1, 22050);
    silent.connect(ctx.destination);
    silent.onended = () => silent.disconnect();
    silent.start();
  } catch {}
}

export function stopEleven() { activeStop?.(); }

type Speech = { audio: string; mime: "audio/mpeg"; chars: { i: number; t: number }[] };
function speech(value: unknown, length: number): Speech {
  if (!value || typeof value !== "object") throw new Error("Invalid speech");
  const v = value as Record<string, unknown>;
  if (v.mime !== "audio/mpeg" || typeof v.audio !== "string" || !v.audio || !Array.isArray(v.chars) || !v.chars.length)
    throw new Error("Invalid speech");
  let index = -1;
  let time = -1;
  const chars = v.chars.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid timing");
    const e = entry as Record<string, unknown>;
    if (typeof e.i !== "number" || !Number.isInteger(e.i) || e.i <= index || e.i >= length ||
        typeof e.t !== "number" || !Number.isFinite(e.t) || e.t < 0 || e.t < time) throw new Error("Invalid timing");
    index = e.i;
    time = e.t;
    return { i: e.i, t: e.t };
  });
  return { audio: v.audio, mime: "audio/mpeg", chars };
}

// Async failures cannot return null to speak(); the callback supplies browser speech on failure.
export function speakEleven(
  text: string, onProgress: (charIndex: number) => void, onEnd: () => void,
  fallback?: (finish: () => void) => () => void,
): (() => void) | null {
  activeStop?.();
  let ctx: AudioContext | null;
  try { ctx = audioContext(); } catch { return null; }
  if (!ctx) return null;
  const audio = ctx;
  const controller = new AbortController();
  let source: AudioBufferSourceNode | null = null;
  let frame = 0;
  let ended = false;
  let fallbackStop: (() => void) | undefined;
  const cleanup = () => {
    controller.abort();
    cancelAnimationFrame(frame);
    if (source) {
      source.onended = null;
      try { source.stop(); } catch {}
      source.disconnect();
      source = null;
    }
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    cleanup();
    if (activeStop === stop) activeStop = null;
    onEnd();
  };
  const stop = () => { if (ended) return; fallbackStop?.(); finish(); };
  activeStop = stop;
  void (async () => {
    try {
      const response = await fetch("/api/speak", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      });
      if (!response.ok) throw new Error("Speech failed");
      const data = speech(await response.json(), text.length);
      if (ended) return;
      const bytes = Uint8Array.from(atob(data.audio), (char) => char.charCodeAt(0));
      const buffer = await audio.decodeAudioData(bytes.buffer);
      if (ended) return;
      if (audio.state !== "running") throw new Error("Audio needs a tap");
      source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      source.onended = finish;
      const start = audio.currentTime;
      source.start();
      let next = 0;
      onProgress(data.chars[0].i);
      const tick = () => {
        if (ended) return;
        const elapsed = audio.currentTime - start;
        while (next < data.chars.length && data.chars[next].t <= elapsed) onProgress(data.chars[next++].i);
        frame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      if (ended) return;
      cleanup();
      try {
        if (fallback) fallbackStop = fallback(finish);
        else finish();
      } catch { finish(); }
    }
  })();
  return stop;
}
