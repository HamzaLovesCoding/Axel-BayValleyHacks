// Does a transcript start with "Hey Axel"? Whisper spells the name a few ways, so the close ones count
// too. Sound-alikes that are also ordinary words ("excel", "accel") only count after "hey", so a
// sentence that happens to start with one doesn't wake the arm.

const GREETING = "(?:hey|hi|hay|ok|okay|a)";
const NAME = "(?:axel|axle|axl|axil|axell|aksel|axel's)";
const SOUND_ALIKE = "(?:excel|accel|exel|axe)";
const WAKE = new RegExp(`^(?:${GREETING} )?${NAME}\\b|^${GREETING} ${SOUND_ALIKE}\\b`);

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The words after the wake phrase ("" if it was just "Hey Axel"), or null if it wasn't said.
export function matchWake(text: string): string | null {
  const clean = normalize(text);
  const match = clean.match(WAKE);
  if (!match) return null;
  return clean.slice(match[0].length).trim();
}

// Said while the arm moves, with or without the wake phrase.
export const saysStop = (text: string) => /\b(stop|halt|freeze|wait)\b/.test(normalize(text));

// What the always-on ear should be doing. While the arm moves it listens for "stop" whether or not
// Hands-free is on, because Stop must be reachable by voice on every move. Whisper hears through the
// phone's echo cancelling, so it keeps listening while Axel talks; the browser's own recogniser
// shares the speaker with the browser voice, so it waits for the line to end.
export type Ear = "off" | "wake" | "stop-whisper" | "stop-browser";

export function earFor(s: {
  mode: "idle" | "listening" | "thinking" | "moving";
  // A Stop is already on its way: free the mic and speaker for its result.
  stopping: boolean;
  speaking: boolean;
  handsFree: boolean;
  whisper: boolean;
  browser: boolean;
}): Ear {
  if (s.mode === "moving") {
    if (s.stopping) return "off";
    if (s.whisper) return "stop-whisper";
    return s.browser && !s.speaking ? "stop-browser" : "off";
  }
  return s.mode === "idle" && s.handsFree && s.whisper && !s.speaking ? "wake" : "off";
}

// "Stop" heard while the arm moves. If the line Axel is reading out has the word in it, the mic may
// only be hearing Axel, so that one doesn't count.
export const heardStop = (text: string, speakingLine: string | null) =>
  saysStop(text) && !(speakingLine && saysStop(speakingLine));
