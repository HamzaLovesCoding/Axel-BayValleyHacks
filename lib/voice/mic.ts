// One microphone shared by command listening (./whisper.ts) and the "Hey Axel" loop (./wake.ts), so
// the phone asks for the mic once and doesn't flicker it on and off between the two.

export const canRecord = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

let context: AudioContext | null = null;
let stream: MediaStream | null = null;
let opening: Promise<MediaStream> | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let users = 0;

// iOS only runs an AudioContext that was started or resumed inside a tap. Call this from any tap;
// until then the level meter reads silence and nothing gets recorded.
export function resumeAudio() {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return;
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume().catch(() => {});
}

export async function openMic(): Promise<void> {
  users++;
  try {
    if (stream?.active) return;
    opening ??= navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    stream = await opening;
    resumeAudio();
    source = context!.createMediaStreamSource(stream);
    analyser = context!.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
  } catch (error) {
    users--;
    throw error;
  } finally {
    opening = null;
  }
}

// Each openMic() needs one closeMic(). The tracks stop when the last user is done, which also turns
// off the phone's mic indicator.
export function closeMic() {
  users = Math.max(0, users - 1);
  if (users > 0) return;
  source?.disconnect();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  source = null;
  analyser = null;
}

const buffer = new Float32Array(1024);
function level() {
  if (!analyser) return 0;
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const v of buffer) sum += v * v;
  return Math.sqrt(sum / buffer.length);
}

const recorderType = () =>
  ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";

export type Utterance = {
  // Whatever was said, or null if nobody spoke (or it was cancelled).
  done: Promise<Blob | null>;
  // End now and keep what's been recorded (the Done button).
  stop: () => void;
  cancel: () => void;
};

// Records one utterance from the open mic. The recorder starts straight away, so the first word isn't
// clipped; it ends `silenceMs` after the person stops talking, after `maxMs`, or with null if nobody
// starts talking within `waitMs`.
export function recordUtterance({ silenceMs = 900, maxMs = 8000, waitMs = 5000 } = {}): Utterance {
  if (!stream) return { done: Promise.resolve(null), stop: () => {}, cancel: () => {} };
  const type = recorderType();
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };

  const start = performance.now();
  let floor = Infinity;
  let spoke = false;
  let lastLoud = 0;
  let finished = false;
  let resolve: (blob: Blob | null) => void = () => {};
  const done = new Promise<Blob | null>((r) => (resolve = r));

  const finish = (keep: boolean) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    recorder.onstop = () => resolve(keep && chunks.length ? new Blob(chunks, { type: recorder.mimeType || type }) : null);
    if (recorder.state === "inactive") recorder.onstop(new Event("stop"));
    else recorder.stop();
  };

  const timer = setInterval(() => {
    const now = performance.now();
    const v = level();
    // The quietest moment so far is the room's noise; speech is well above it.
    floor = Math.min(floor, Math.max(v, 0.002));
    if (v > Math.max(0.02, floor * 3)) {
      spoke = true;
      lastLoud = now;
    }
    if (spoke && now - lastLoud > silenceMs) finish(true);
    else if (!spoke && now - start > waitMs) finish(false);
    else if (now - start > maxMs) finish(spoke);
  }, 50);

  recorder.start(250);
  return { done, stop: () => finish(true), cancel: () => finish(false) };
}

// Sends recorded audio to the laptop's Whisper through this app's server.
export async function transcribe(audio: Blob, signal?: AbortSignal): Promise<string> {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: { "content-type": audio.type || "application/octet-stream" },
    body: audio,
    signal,
  });
  if (!res.ok) throw new Error(`Transcribe answered ${res.status}`);
  const body = (await res.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text : "";
}
