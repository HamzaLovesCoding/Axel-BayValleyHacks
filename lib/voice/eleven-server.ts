// Server-only ElevenLabs adapter. Never return upstream errors or request headers to the phone.
export const ELEVEN_MODEL = "eleven_flash_v2_5";

type Timing = { i: number; t: number };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function timings(value: unknown, text: string): Timing[] {
  if (!object(value) || !Array.isArray(value.characters) || !Array.isArray(value.character_start_times_seconds))
    throw new Error("Missing alignment");
  const chars: unknown[] = value.characters;
  const starts: unknown[] = value.character_start_times_seconds;
  if (chars.length !== starts.length || chars.some((c) => typeof c !== "string" || !c.length) || chars.join("") !== text)
    throw new Error("Alignment does not match input");
  const times: number[] = [];
  let previous = 0;
  chars.forEach((char, index) => {
    const t = starts[index];
    if (typeof t !== "number" || !Number.isFinite(t) || t < previous) throw new Error("Invalid alignment time");
    previous = t;
    // Provider characters can be Unicode code points; UI indices are UTF-16 string offsets.
    for (let i = 0; i < String(char).length; i++) times.push(t);
  });
  return [...text.matchAll(/\S+/gu)].map((word) => ({ i: word.index, t: times[word.index] }));
}

export async function handleSpeak(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voice) return json({ error: "ElevenLabs speech is not configured." }, 503);
  const body: unknown = await req.json().catch(() => null);
  if (!object(body) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 300)
    return json({ error: "Say something between 1 and 300 characters." }, 400);
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text: body.text, model_id: ELEVEN_MODEL, voice_settings: {
        stability: 0.65, similarity_boost: 0.75, style: 0, use_speaker_boost: false, speed: 0.95,
      } }),
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(10_000)]),
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Speech provider failed");
    }
    const data: unknown = await response.json();
    if (!object(data) || typeof data.audio_base64 !== "string" || !data.audio_base64.length ||
        data.audio_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.audio_base64))
      throw new Error("Invalid audio");
    return json({ audio: data.audio_base64, mime: "audio/mpeg", chars: timings(data.alignment, body.text) });
  } catch {
    return json({ error: "I couldn't make the voice audio. I'll use the browser voice." }, 502);
  }
}
