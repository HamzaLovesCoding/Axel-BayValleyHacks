"use client";

import { useEffect } from "react";
import { useAssistant } from "@/lib/store";
import { canListenBrowser, listenForStop } from "@/lib/voice/listen";
import { resumeAudio } from "@/lib/voice/mic";
import { startHandsFree } from "@/lib/voice/wake";
import { earFor, heardStop, matchWake } from "@/lib/voice/wake-phrase";
import { holdScreenAwake, needsScreenAwake } from "@/lib/wake-lock";

// The always-on ear. With Hands-free on it waits for "Hey Axel", but not while a command is being
// heard or thought about, and not while Axel is talking, so it never wakes itself up with its own
// voice. While the arm moves it listens for "stop" with or without Hands-free and the wake phrase
// (earFor() in lib/voice/wake-phrase.ts has the rules).
export function HandsFree() {
  const on = useAssistant((s) => s.handsFree && s.engines.wake === "whisper");
  const ear = useAssistant((s) =>
    earFor({
      mode: s.mode,
      stopping: s.stopping,
      speaking: Number.isFinite(s.spokenTo),
      handsFree: s.handsFree,
      whisper: s.engines.wake === "whisper",
      browser: canListenBrowser(),
    }),
  );
  // "Hey Axel" and the Whisper stop ear share one open mic, so moving between them doesn't restart it.
  const whisperEar = ear === "wake" || ear === "stop-whisper";
  const browserEar = ear === "stop-browser";
  const awake = useAssistant(needsScreenAwake);

  const stopIfHeard = (text: string) => {
    const s = useAssistant.getState();
    if (s.mode === "moving" && heardStop(text, Number.isFinite(s.spokenTo) ? s.line.text : null)) s.stopArm();
  };

  useEffect(() => {
    if (!whisperEar) return;
    return startHandsFree(
      (text) => {
        const s = useAssistant.getState();
        if (s.mode === "moving") return stopIfHeard(text);
        if (s.mode !== "idle") return;
        const rest = matchWake(text);
        if (rest === null) return;
        if (rest) void s.ask(rest, "voice");
        else s.startListening();
      },
      (problem) => {
        if (problem === "denied") useAssistant.getState().setHandsFree(false);
        console.warn(`Hands-free stopped: ${problem}`);
      },
    );
  }, [whisperEar]);

  useEffect(() => {
    if (browserEar) return listenForStop(stopIfHeard);
  }, [browserEar]);

  // The mic only works with the page in front and the screen on. A move needs the screen on too:
  // a locked phone has no Stop button.
  useEffect(() => {
    if (awake) return holdScreenAwake();
  }, [awake]);

  // After a reload, iOS keeps audio paused until the first tap anywhere.
  useEffect(() => {
    if (!on) return;
    document.addEventListener("pointerdown", resumeAudio);
    return () => document.removeEventListener("pointerdown", resumeAudio);
  }, [on]);

  return null;
}
