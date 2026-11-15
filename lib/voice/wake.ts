import { closeMic, openMic, recordUtterance, transcribe, type Utterance } from "./mic";

// Hands-free "Hey Axel": the phone keeps the mic open, cuts out each thing that's said, and has the
// laptop's Whisper transcribe it. The caller decides what counts (matchWake() in ./wake-phrase.ts),
// so this file only turns speech into text. Free, and the audio never leaves the laptop. It needs
// the page open with the screen on: iPhones cut the mic in the background.

export type HandsFreeProblem = "denied" | "failed";

// Starts listening; returns a stop function.
export function startHandsFree(onText: (text: string) => void, onProblem: (problem: HandsFreeProblem) => void): () => void {
  let running = true;
  let current: Utterance | null = null;

  void (async () => {
    try {
      await openMic();
    } catch (error) {
      if (running) onProblem((error as Error).name === "NotAllowedError" ? "denied" : "failed");
      return;
    }
    let failures = 0;
    while (running) {
      // A fresh recorder every few silent seconds keeps each clip short and starting just before the
      // speech, which is what makes the transcription quick.
      current = recordUtterance({ silenceMs: 700, maxMs: 7000, waitMs: 4000 });
      const audio = await current.done;
      if (!running) break;
      if (!audio) continue;
      try {
        const text = await transcribe(audio);
        failures = 0;
        if (running && text) onText(text);
      } catch {
        // Whisper restarting or the laptop busy: back off rather than hammer it.
        if (++failures === 3) onProblem("failed");
        await new Promise((r) => setTimeout(r, Math.min(10_000, 1000 * failures)));
      }
    }
    closeMic();
  })();

  return () => {
    running = false;
    current?.cancel();
  };
}
