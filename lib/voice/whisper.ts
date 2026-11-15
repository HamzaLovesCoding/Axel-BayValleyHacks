import type { ListenHandlers, Listening } from "./listen";
import { canRecord, closeMic, openMic, recordUtterance, transcribe, type Utterance } from "./mic";

// Speech-to-text with Whisper running on the laptop: the phone records one utterance, POSTs it to
// /api/transcribe, and the server passes it to whisper.cpp (docs/contracts.md §4). Whisper has no
// interim words, so the screen shows "Go ahead" until the whole sentence comes back.

export { canRecord };

export function listenWhisper(handlers: ListenHandlers): Listening | null {
  if (!canRecord()) return null;

  let utterance: Utterance | null = null;
  let cancelled = false;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    handlers.onEnd();
  };

  handlers.onText("");
  void (async () => {
    try {
      await openMic();
    } catch (error) {
      handlers.onProblem((error as Error).name === "NotAllowedError" ? "denied" : "failed");
      return end();
    }
    try {
      if (cancelled) return;
      utterance = recordUtterance({ silenceMs: 900, maxMs: 10_000, waitMs: 5000 });
      const audio = await utterance.done;
      if (cancelled) return;
      if (!audio) return handlers.onProblem("no-speech");
      const text = await transcribe(audio);
      if (cancelled) return;
      if (text) handlers.onText(text);
      else handlers.onProblem("no-speech");
    } catch {
      if (!cancelled) handlers.onProblem("failed");
    } finally {
      closeMic();
      end();
    }
  })();

  return {
    finish: () => utterance?.stop(),
    cancel: () => {
      cancelled = true;
      utterance?.cancel();
    },
  };
}
