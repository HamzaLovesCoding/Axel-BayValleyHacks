import { connection } from "next/server";
import type { VoiceEngines } from "@/lib/voice/engines";

// Tells the phone which speech engines this server is set up for (docs/contracts.md §4).
export async function GET() {
  // Read the env at request time, not at build time.
  await connection();
  const engines: VoiceEngines = {
    stt: process.env.WHISPER_URL ? "whisper" : "browser",
    tts: process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID ? "elevenlabs" : "browser",
    wake: process.env.WHISPER_URL ? "whisper" : "none",
  };
  return Response.json(engines);
}
