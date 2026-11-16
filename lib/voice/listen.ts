import type { VoiceEngines } from "./engines";
import { canRecord, listenWhisper } from "./whisper";

// Speech-to-text. Two engines behind one interface: Whisper on the laptop (./whisper.ts) when the
// server has WHISPER_URL, otherwise the browser's Web Speech API, which is free with no key and
// works in Safari on iOS 14.5+ and Chrome. Firefox has neither, so the app falls back to typing
// (the keyboard's dictation mic still works there).

// lib.dom doesn't ship SpeechRecognition types, so declare only the parts used here.
type Alternative = { transcript: string };
type Result = ArrayLike<Alternative> & { isFinal: boolean };
type ResultEvent = { results: ArrayLike<Result> };
type ErrorEvent = { error: string };

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: ResultEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type RecognitionConstructor = new () => Recognition;

function recognitionClass(): RecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export const canListenBrowser = () => recognitionClass() !== undefined;

export const canListen = (engine: VoiceEngines["stt"] = "browser") =>
  (engine === "whisper" && canRecord()) || canListenBrowser();

export type ListenProblem = "denied" | "no-speech" | "failed";

export type ListenHandlers = {
  // Everything heard so far, interim words included.
  onText: (text: string) => void;
  onProblem: (problem: ListenProblem) => void;
  onEnd: () => void;
};

export type Listening = { finish: () => void; cancel: () => void };

export function listen(handlers: ListenHandlers, engine: VoiceEngines["stt"] = "browser"): Listening | null {
  if (engine === "whisper") {
    const whisper = listenWhisper(handlers);
    if (whisper) return whisper;
  }
  return listenBrowser(handlers);
}

function listenBrowser(handlers: ListenHandlers): Listening | null {
  const Recognition = recognitionClass();
  if (!Recognition) return null;

  const rec = new Recognition();
  rec.lang = "en-US";
  rec.interimResults = true;
  // One utterance per tap: recognition ends on its own when the person stops talking.
  rec.continuous = false;
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    let text = "";
    for (let i = 0; i < event.results.length; i++) text += event.results[i][0]?.transcript ?? "";
    handlers.onText(text.trim());
  };
  rec.onerror = (event) => {
    if (event.error === "aborted") return;
    if (event.error === "not-allowed" || event.error === "service-not-allowed") handlers.onProblem("denied");
    else if (event.error === "no-speech") handlers.onProblem("no-speech");
    else handlers.onProblem("failed");
  };
  rec.onend = handlers.onEnd;

  try {
    rec.start();
  } catch {
    return null;
  }
  return { finish: () => rec.stop(), cancel: () => rec.abort() };
}

// The browser engine's ear for "stop" while the arm moves (the Whisper one is ./wake.ts). Hands every
// transcript, interim words included, to the caller. The recogniser ends itself every so often, so
// this starts it again until told to stop. Returns the function that ends it.
export function listenForStop(onHeard: (text: string) => void): () => void {
  const Recognition = recognitionClass();
  if (!Recognition) return () => {};
  let active = true;
  let rec: Recognition | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A move lasts well under a minute; this only stops a recogniser that fails instantly from spinning.
  let restarts = 0;

  const start = () => {
    if (!active) return;
    rec = new Recognition();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    rec.onresult = (event) => {
      let text = "";
      for (let i = 0; i < event.results.length; i++) text += ` ${event.results[i][0]?.transcript ?? ""}`;
      if (active) onHeard(text.trim());
    };
    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") active = false;
    };
    rec.onend = () => {
      if (active && ++restarts <= 40) timer = setTimeout(start, 250);
    };
    try {
      rec.start();
    } catch {
      active = false;
    }
  };
  start();

  return () => {
    active = false;
    clearTimeout(timer);
    try {
      rec?.abort();
    } catch {}
  };
}
