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
