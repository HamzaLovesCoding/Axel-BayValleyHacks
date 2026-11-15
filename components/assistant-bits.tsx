"use client";

import Link from "next/link";
import { useMemo, type CSSProperties } from "react";
import { useCountedAngle } from "@/components/motion";
import type { Phase } from "@/lib/robot/types";
import { useAssistant, type Line, type Mode, type Turn } from "@/lib/store";
import { degrees, slotAt, slotColor } from "@/lib/tray";

export const PHASE_LABEL: Record<Phase, string> = {
  stowed: "Ready",
  turning: "Turning",
  gripping: "Gripping",
  bringing: "Bringing it to you",
  holding: "Holding it out",
  releasing: "Letting go",
  presenting: "Hand it to me",
  returning: "Taking it back",
  placing: "Setting it down",
  stowing: "Moving clear",
  stopped: "Stopped",
};

export function statusText(mode: Mode, phase: Phase, item: string | undefined) {
  if (mode === "listening") return "Listening";
  if (mode === "thinking") return "Thinking";
  if (item && (phase === "turning" || phase === "gripping")) return `${PHASE_LABEL[phase]} · ${item}`;
  return PHASE_LABEL[phase];
}

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

// The assistant's voice as five bars. The same glyph stands for it everywhere: in the middle of
// the dial, on the Talk button, and next to its replies in chat.
export function VoiceBars({
  state = "idle",
  size = 20,
  className = "",
  style,
}: {
  state?: VoiceState;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span className={`voice ${className}`} data-state={state} style={{ "--h": `${size}px`, ...style } as CSSProperties} aria-hidden>
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

// A tray spot's number in its colour. Wherever an item is named, this sits next to it.
export function SlotToken({ position, size = 28, className = "" }: { position: number; size?: number; className?: string }) {
  return (
    <span
      className={`slot-token grid shrink-0 place-items-center rounded-full font-mono text-[12px] font-medium tabular-nums ${className}`}
      style={{ "--c": slotColor(position), width: size, height: size } as CSSProperties}
    >
      {position}
    </span>
  );
}

// What the arm is doing, plus its heading counting through every degree.
export function ArmStatus({ className = "" }: { className?: string }) {
  const angle = useAssistant((s) => s.angle);
  const mode = useAssistant((s) => s.mode);
  const phase = useAssistant((s) => s.phase);
  const item = useAssistant((s) => slotAt(s.tray, s.active)?.name);
  const shown = useCountedAngle(angle);
  const busy = mode !== "idle";

  return (
    <p className={`flex min-w-0 items-center gap-1.5 ${className}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${busy ? "live-dot bg-accent" : "bg-faint"}`} aria-hidden />
      <span className="truncate">{statusText(mode, phase, item)}</span>
      <span className="font-mono tabular-nums text-faint" aria-hidden>
        {degrees(shown)}
      </span>
      <span className="sr-only">Arm heading {Math.round(angle)} degrees.</span>
    </p>
  );
}

const WORDS = /\S+\s*/g;

// The big line. Words fill in as they're read out, and the word being read turns orange.
export function SpokenLine({ line, spokenTo, className = "" }: { line: Line; spokenTo: number; className?: string }) {
  const words = useMemo(() => [...line.text.matchAll(WORDS)].map((m) => ({ text: m[0], start: m.index ?? 0 })), [line.text]);
  const reading = Number.isFinite(spokenTo);
  const now = reading ? words.findLastIndex((w) => w.start <= spokenTo) : -1;
  const quoted = line.by === "person";

  return (
    <p key={line.id} className={`rise ${className}`}>
      {quoted && <span className="text-faint">“</span>}
      {words.map((w, i) => (
        <span key={i} className="word" data-lit={w.start <= spokenTo ? "" : undefined} data-now={i === now ? "" : undefined}>
          {w.text}
        </span>
      ))}
      {quoted && <span className="text-faint">”</span>}
    </p>
  );
}

export function useSuggestions() {
  const tray = useAssistant((s) => s.tray);
  const holding = useAssistant((s) => s.holding);
  const hasAway = useAssistant((s) => s.away.length > 0);
  const presenting = useAssistant((s) => s.presenting != null);
  return useMemo(() => {
    if (holding != null) return ["Release", "Put it back"];
    // The open gripper is waiting: the only useful thing to say is go.
    if (presenting) return ["Go"];
    const names = tray.map((s) => s.name.trim().toLowerCase());
    const list: string[] = [];
    if (hasAway) list.push("Put it back");
    if (names[1]) list.push(`Bring me the ${names[1]}`);
    if (names.includes("water")) list.push("I'm so thirsty");
    if (names[3]) list.push(`Bring me the ${names[3]}`);
    return list;
  }, [tray, holding, hasAway, presenting]);
}

// Tapping a chip is the same as saying it. aria-disabled (not disabled) keeps keyboard focus while busy.
export function CommandChips({ className = "" }: { className?: string }) {
  const suggestions = useSuggestions();
  const tray = useAssistant((s) => s.tray);
  const held = useAssistant((s) => slotAt(s.tray, s.holding));
  const busy = useAssistant((s) => s.mode !== "idle");
  const ask = useAssistant((s) => s.ask);
  const slotIn = (phrase: string) => tray.find((s) => s.name.trim() && phrase.toLowerCase().endsWith(s.name.trim().toLowerCase()));
  const chip = "press flex items-center justify-center gap-2 rounded-full text-[15px] whitespace-nowrap aria-disabled:opacity-40";

  // With something in the gripper there are only two things to do next, so they get the full width.
  if (held) {
    return (
      <ul className={`grid grid-cols-2 gap-2 ${className}`} aria-label="Things you can say" style={{ "--c": slotColor(held.position) } as CSSProperties}>
        {suggestions.map((phrase, i) => (
          <li key={phrase}>
            <button
              type="button"
              aria-disabled={busy || undefined}
              onClick={() => !busy && void ask(phrase, "tap")}
              className={`${chip} h-12 w-full font-medium ${i === 0 ? "bg-[color-mix(in_oklab,var(--c)_22%,var(--surface))] hover:bg-[color-mix(in_oklab,var(--c)_30%,var(--surface))]" : "bg-surface hover:bg-surface-2"}`}
            >
              {i === 0 && <span className="size-2 rounded-full bg-(--c)" aria-hidden />}
              {phrase}
            </button>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul
      className={`no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 [mask-image:linear-gradient(90deg,#000_calc(100%-28px),transparent)] ${className}`}
      aria-label="Things you can say"
    >
      {suggestions.map((phrase) => {
        const slot = slotIn(phrase);
        return (
          <li key={phrase} className="shrink-0">
            <button
              type="button"
              aria-disabled={busy || undefined}
              onClick={() => !busy && void ask(phrase, "tap")}
              className={`${chip} h-11 bg-surface px-4 hover:bg-surface-2`}
            >
              {slot && <span className="size-2 rounded-full" style={{ background: slotColor(slot.position) }} aria-hidden />}
              {phrase}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function StatusPill() {
  const robotMode = useAssistant((s) => s.robotMode);
  const health = useAssistant((s) => s.health);
  const live = robotMode === "robot" && health?.reachable;
  const label = robotMode === "sim" ? "Simulator" : live ? "Robot" : "Offline";

  return (
    <Link
      href="/setup"
      transitionTypes={["nav-forward"]}
      aria-label={`${robotMode === "sim" ? "Simulator" : live ? "Robot connected" : "Robot offline"}. Open settings.`}
      className="press flex h-11 items-center gap-2 rounded-full bg-surface px-3.5 text-[14px] text-muted hover:text-fg"
    >
      <span className={`size-1.5 rounded-full ${live ? "bg-ok" : robotMode === "sim" ? "bg-muted" : "border border-muted"}`} aria-hidden />
      {label}
    </Link>
  );
}

// Says so wherever the simulator or the keyword stand-in produced what's on screen.
export function DemoNote({ turn, short = false, className = "" }: { turn: Pick<Turn, "source" | "link">; short?: boolean; className?: string }) {
  const parts = [
    turn.link === "sim" && "Simulated arm",
    turn.source === "keywords" && (short ? "Keyword demo" : "Keyword demo, not the AI model"),
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return <p className={`text-[13px] text-muted ${className}`}>{parts.join(" · ")}</p>;
}
