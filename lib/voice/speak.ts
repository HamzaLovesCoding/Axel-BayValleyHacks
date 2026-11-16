import { speakEleven, stopEleven, unlockEleven } from "./eleven";
import type { VoiceEngines } from "./engines";
import { resumeAudio } from "./mic";

// Text-to-speech. ElevenLabs (./eleven.ts) when the server has ELEVENLABS_API_KEY, otherwise the
// browser's speechSynthesis: free and offline, but the voice depends on the phone.

export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

// iOS only lets a page speak after it has spoken once inside a tap. Call this from a tap handler.
let unlocked = false;
export function unlockSpeech() {
  unlockEleven();
  // The stop ear opens the mic once the arm moves, outside any tap. iOS only lets its level meter
  // run if the audio was started inside one, and every move begins with a tap or a spoken command.
  resumeAudio();
  if (unlocked || !canSpeak()) return;
  const silent = new SpeechSynthesisUtterance(" ");
  silent.volume = 0;
  window.speechSynthesis.speak(silent);
  unlocked = true;
}

function pickVoice() {
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  return (
    voices.find((v) => v.localService && /samantha|ava|daniel|karen|serena/i.test(v.name)) ??
    voices.find((v) => /google us english/i.test(v.name)) ??
    voices.find((v) => v.default) ??
    voices[0]
  );
}

// Holding the utterance at module level stops Safari from garbage-collecting it mid-sentence,
// which silently drops its `end` event.
let current: SpeechSynthesisUtterance | null = null;

const CHARS_PER_MS = 0.014;

// `onProgress` gets the index of the character being spoken, for lighting up words as they're said.
export function speak(
  text: string,
  onProgress: (charIndex: number) => void,
  onEnd: () => void,
  engine: VoiceEngines["tts"] = "browser",
): () => void {
  if (engine === "elevenlabs") {
    const stop = speakEleven(text, onProgress, onEnd, (finish) => speakBrowser(text, onProgress, finish));
    if (stop) return stop;
  }
  stopEleven();
  return speakBrowser(text, onProgress, onEnd);
}

function speakBrowser(text: string, onProgress: (charIndex: number) => void, onEnd: () => void): () => void {
  if (!canSpeak()) {
    onEnd();
    return () => {};
  }
  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.95;
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  current = utterance;

  let finished = false;
  let sawBoundary = false;
  // Replaced by the real start time if the `start` event fires; some voices never send it.
  let started = performance.now();
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(estimate);
    clearTimeout(safety);
    if (current === utterance) current = null;
    onEnd();
  };

  utterance.onstart = () => {
    started = performance.now();
  };
  utterance.onboundary = (event) => {
    sawBoundary = true;
    onProgress(event.charIndex);
  };
  utterance.onend = finish;
  utterance.onerror = finish;

  // Some voices never fire `boundary`. Estimate progress from elapsed time instead.
  const estimate = setInterval(() => {
    if (sawBoundary) return;
    onProgress(Math.floor((performance.now() - started) * CHARS_PER_MS));
  }, 80);
  // And some never fire `end`.
  const safety = setTimeout(finish, 2500 + text.length / CHARS_PER_MS);

  synth.speak(utterance);
  return () => {
    synth.cancel();
    finish();
  };
}
