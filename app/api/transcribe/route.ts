import { connection } from "next/server";

// Speech to text with Whisper running on the laptop (whisper.cpp's `whisper-server --convert`).
// docs/contracts.md §4. The audio is never stored or logged.

const MAX_BYTES = 2_000_000; // about 30 s of compressed speech

const extension = (type: string) =>
  /mp4|m4a|aac/.test(type) ? "m4a" : /ogg/.test(type) ? "ogg" : /wav/.test(type) ? "wav" : "webm";

// Whisper marks silence and noise as "[BLANK_AUDIO]", "(wind blowing)" and so on. Drop those.
const clean = (text: string) =>
  text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export async function POST(req: Request) {
  await connection();
  const base = process.env.WHISPER_URL?.replace(/\/+$/, "");
  if (!base) return Response.json({ error: "WHISPER_URL is not set on the server." }, { status: 503 });

  const type = req.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
  const audio = await req.arrayBuffer();
  if (audio.byteLength === 0) return Response.json({ error: "No audio." }, { status: 400 });
  if (audio.byteLength > MAX_BYTES) return Response.json({ error: "That recording is too long." }, { status: 413 });

  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `speech.${extension(type)}`);
  form.append("response_format", "json");
  form.append("temperature", "0");
  // No initial prompt with "Axel" in it: on near-silence Whisper can echo its prompt back, which
  // would wake the arm by itself. lib/voice/wake-phrase.ts accepts the usual misspellings instead.

  try {
    const res = await fetch(`${base}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Whisper answered ${res.status}`);
    const body = (await res.json()) as { text?: unknown; error?: unknown };
    if (typeof body.text !== "string") throw new Error(typeof body.error === "string" ? body.error : "No text from Whisper");
    return Response.json({ text: clean(body.text) });
  } catch (error) {
    console.error("Whisper failed:", (error as Error).message);
    return Response.json({ error: "Couldn't reach Whisper on the laptop." }, { status: 502 });
  }
}
