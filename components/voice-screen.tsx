"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CommandChips, DemoNote, SpokenLine, StatusPill, VoiceBars } from "@/components/assistant-bits";
import { Dial } from "@/components/dial";
import { ChatIcon, MicIcon, SlidersIcon, StopIcon } from "@/components/ui/icons";
import { Brand } from "@/components/ui/logo";
import { BRAND } from "@/lib/site";
import { INTRO, useAssistant } from "@/lib/store";

export function VoiceScreen() {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-[520px] flex-col overflow-x-clip px-5 pt-[max(env(safe-area-inset-top),12px)] pb-[max(env(safe-area-inset-bottom),16px)]">
      <header className="flex h-12 items-center justify-between">
        <h1>
          <Brand />
        </h1>
        <StatusPill />
      </header>

      <Conversation />

      <div className="flex flex-1 items-center justify-center py-5">
        <div className="w-[min(100%,380px,44svh)]">
          <Dial />
        </div>
      </div>

      <CommandChips />
      <Controls />
    </main>
  );
}

// What was just said, by either side. It leads the screen: the dial and the controls answer it.
function Conversation() {
  const mode = useAssistant((s) => s.mode);
  const interim = useAssistant((s) => s.interim);
  const line = useAssistant((s) => s.line);
  const spokenTo = useAssistant((s) => s.spokenTo);
  const last = useAssistant((s) => s.turns.findLast((t) => t.role === "assistant"));
  const handsFree = useAssistant((s) => s.handsFree && s.engines.wake === "whisper");

  const big = "text-[clamp(26px,7.6vw,32px)] leading-[1.15] font-medium tracking-[-0.025em] text-pretty";

  return (
    <section aria-live="polite" className="mt-4 min-h-[4.6rem]">
      {mode === "listening" ? (
        <p key="listening" className={`rise ${big}`}>
          {interim ? (
            <>
              <span className="text-faint">“</span>
              {interim}
              <span className="text-faint">”</span>
            </>
          ) : (
            <span className="text-faint">Go ahead</span>
          )}
        </p>
      ) : line.id === INTRO.id ? (
        <p key="intro" className={big}>
          {INTRO.text}
        </p>
      ) : (
        <SpokenLine line={line} spokenTo={spokenTo} className={big} />
      )}
      {mode !== "listening" && last && <DemoNote turn={last} className="mt-2.5" />}
      {mode === "idle" && handsFree && (
        <p className="mt-2.5 flex items-center gap-2 text-[14px] text-muted">
          <span className="live-dot size-1.5 rounded-full bg-accent" aria-hidden />
          Say “Hey {BRAND}”
        </p>
      )}
    </section>
  );
}

function Controls() {
  const mode = useAssistant((s) => s.mode);
  const startListening = useAssistant((s) => s.startListening);
  const finishListening = useAssistant((s) => s.finishListening);
  const stopArm = useAssistant((s) => s.stopArm);

  // Talk and Done are orange; Stop flips to ink so the change of job is impossible to miss.
  const center =
    mode === "moving"
      ? { label: "Stop", aria: "Stop the arm", onClick: stopArm, tone: "bg-fg text-bg", icon: <StopIcon size={22} /> }
      : mode === "listening"
        ? {
            label: "Done",
            aria: "Done talking",
            onClick: finishListening,
            tone: "talk-live bg-accent text-on-accent",
            icon: <VoiceBars state="listening" size={20} />,
          }
        : mode === "thinking"
          ? {
              label: "Thinking",
              aria: "Thinking",
              onClick: undefined,
              tone: "bg-surface-2 text-muted",
              icon: <VoiceBars state="thinking" size={20} />,
            }
          : {
              label: "Talk",
              aria: "Talk",
              onClick: startListening,
              tone: "bg-accent text-on-accent shadow-[0_12px_28px_-14px_var(--accent)] hover:brightness-105",
              icon: <MicIcon size={22} />,
            };

  return (
    <nav aria-label="Controls" className="mt-4 grid grid-cols-[56px_1fr_56px] items-center gap-3">
      <SideLink href="/chat" label="Type instead">
        <ChatIcon size={20} />
      </SideLink>

      <button
        type="button"
        onClick={center.onClick}
        aria-disabled={!center.onClick || undefined}
        aria-pressed={mode === "listening" ? true : undefined}
        aria-label={center.aria}
        className={`press flex h-16 items-center justify-center gap-2.5 rounded-full text-[17px] font-medium aria-disabled:active:scale-100 ${center.tone}`}
      >
        {center.icon}
        <span aria-hidden>{center.label}</span>
      </button>

      <SideLink href="/setup" label="Settings">
        <SlidersIcon size={20} />
      </SideLink>
    </nav>
  );
}

function SideLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      transitionTypes={["nav-forward"]}
      aria-label={label}
      className="press grid size-14 place-items-center rounded-full bg-surface text-muted hover:bg-surface-2 hover:text-fg"
    >
      {children}
    </Link>
  );
}
