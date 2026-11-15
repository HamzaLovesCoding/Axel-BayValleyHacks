import { connection } from "next/server";
import { handleSpeak } from "@/lib/voice/eleven-server";

// The key stays in the server adapter; failures let the phone use its browser voice.
export async function POST(req: Request) {
  await connection();
  return handleSpeak(req);
}
