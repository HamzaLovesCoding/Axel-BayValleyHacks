// Which speech engines this server is set up for. The server decides from its env vars
// (GET /api/voice, docs/contracts.md §4); the phone falls back to the browser's own engines.
export type VoiceEngines = {
  stt: "browser" | "whisper";
  tts: "browser" | "elevenlabs";
  // "Hey Axel" rides on Whisper, so it exists exactly when Whisper does.
  wake: "none" | "whisper";
};

export const BROWSER_VOICE: VoiceEngines = { stt: "browser", tts: "browser", wake: "none" };

export async function fetchEngines(): Promise<VoiceEngines> {
  try {
    const res = await fetch("/api/voice", { cache: "no-store" });
    if (!res.ok) return BROWSER_VOICE;
    const body = (await res.json()) as Partial<VoiceEngines>;
    return {
      stt: body.stt === "whisper" ? "whisper" : "browser",
      tts: body.tts === "elevenlabs" ? "elevenlabs" : "browser",
      wake: body.wake === "whisper" ? "whisper" : "none",
    };
  } catch {
    return BROWSER_VOICE;
  }
}
