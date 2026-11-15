"use client";

import { useEffect } from "react";
import { useAssistant } from "@/lib/store";
import { resumeAudio } from "@/lib/voice/mic";
import { startHandsFree } from "@/lib/voice/wake";
import { matchWake, saysStop } from "@/lib/voice/wake-phrase";
import { holdScreenAwake, needsScreenAwake } from "@/lib/wake-lock";

// "Hey Axel" without a tap. Listens only while nothing else is using the mic or the speaker: not
// while a command is being heard or thought about, and not while Axel is talking, so it never wakes
// itself up with its own voice. While the arm moves, "stop" works without the wake phrase.
export function HandsFree() {
  const on = useAssistant((s) => s.handsFree && s.engines.wake === "whisper");
  const mode = useAssistant((s) => s.mode);
  const speaking = useAssistant((s) => Number.isFinite(s.spokenTo));
  const active = on && (mode === "idle" || mode === "moving") && !speaking;
  const awake = useAssistant(needsScreenAwake);

  useEffect(() => {
    if (!active) return;
    return startHandsFree(
      (text) => {
        const s = useAssistant.getState();
        if (s.mode === "moving") {
          if (saysStop(text)) s.stopArm();
          return;
        }
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
  }, [active]);

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
