"use client";

import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ArmStatus, CommandChips, DemoNote, SlotToken, VoiceBars } from "@/components/assistant-bits";
import { ROUND, TopBar } from "@/components/top-bar";
import { MicIcon, SendIcon, StopIcon, TrashIcon } from "@/components/ui/icons";
import { Mark } from "@/components/ui/logo";
import { INTRO, useAssistant, type Turn } from "@/lib/store";
import { angleOf, degrees, slotColor } from "@/lib/tray";

export function ChatScreen() {
  const turns = useAssistant((s) => s.turns);
  const mode = useAssistant((s) => s.mode);
  const interim = useAssistant((s) => s.interim);
  const clearConversation = useAssistant((s) => s.clearConversation);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, mode, interim]);

  return (
    <main className="mx-auto flex h-svh w-full max-w-[520px] flex-col">
      <TopBar
        title="Chat"
        subtitle={<ArmStatus className="text-[12px] text-muted" />}
        action={
          turns.length > 0 && (
            <button
              type="button"
              onClick={clearConversation}
              aria-label="Clear conversation"
              aria-disabled={mode !== "idle" || undefined}
              className={`${ROUND} aria-disabled:opacity-40`}
            >
              <TrashIcon size={20} />
            </button>
          )
        }
      />

      <div className="flex-1 overflow-y-auto px-5">
        {turns.length === 0 ? (
          <Intro />
        ) : (
          <ol className="flex flex-col gap-6 py-6" aria-live="polite">
            {turns.map((turn) => (turn.role === "user" ? <UserTurn key={turn.id} turn={turn} /> : <AssistantTurn key={turn.id} turn={turn} />))}
          </ol>
        )}
        {mode === "listening" && (
          <p className="mb-6 ml-auto flex w-fit max-w-[82%] items-center gap-2.5 rounded-[20px] rounded-br-[6px] bg-surface px-4 py-2.5 text-[16px] text-muted">
            <VoiceBars state="listening" size={16} className="text-accent" />
            {interim || "Listening"}
          </p>
        )}
        {mode === "thinking" && (
          <div className="flex items-center gap-3 pb-6">
            <Mark size={20} />
            <VoiceBars state="thinking" size={18} className="text-muted" />
            <span className="sr-only">Thinking</span>
          </div>
        )}
        <div ref={endRef} className="h-2" />
      </div>

      <footer className="px-5 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]">
        {turns.length > 0 && <CommandChips className="mb-3" />}
        <Composer />
      </footer>
    </main>
  );
}

function Intro() {
  const tray = useAssistant((s) => s.tray);
  const busy = useAssistant((s) => s.mode !== "idle");
  const ask = useAssistant((s) => s.ask);
  const items = tray.filter((s) => s.name.trim());

  return (
    <div className="pt-8 pb-6">
      <h2 className="text-[clamp(26px,7.6vw,32px)] leading-[1.15] font-medium tracking-[-0.025em]">{INTRO.text}</h2>

      <ul className="mt-6 grid grid-cols-2 gap-2" aria-label="On the tray">
        {items.map((slot) => (
          <li key={slot.position}>
            <button
              type="button"
              aria-disabled={busy || undefined}
              onClick={() => !busy && void ask(`Bring me the ${slot.name.trim().toLowerCase()}`, "tap")}
              aria-label={`Bring me the ${slot.name}`}
              style={{ "--c": slotColor(slot.position) } as CSSProperties}
              className="press flex h-24 w-full flex-col justify-between rounded-2xl bg-[color-mix(in_oklab,var(--c)_12%,var(--surface))] p-3.5 text-left hover:bg-[color-mix(in_oklab,var(--c)_22%,var(--surface))] aria-disabled:opacity-50"
            >
              <span className="flex w-full items-center justify-between">
                <SlotToken position={slot.position} />
                <span className="font-mono text-[12px] text-muted tabular-nums">{degrees(angleOf(slot.position))}</span>
              </span>
              <span className="block truncate text-[17px] font-medium">{slot.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const VIA: Record<NonNullable<Turn["via"]>, string> = { voice: "Spoken", text: "Typed", tap: "Tapped" };

function UserTurn({ turn }: { turn: Turn }) {
  return (
    <li className="rise flex flex-col items-end gap-1">
      <p className="max-w-[82%] rounded-[20px] rounded-br-[6px] bg-fg px-4 py-2.5 text-[16px] leading-snug text-bg">{turn.text}</p>
      <p className="pr-1 text-[12px] text-muted">
        {turn.time}
        {turn.via && ` · ${VIA[turn.via]}`}
      </p>
    </li>
  );
}

const OUTCOME: Record<NonNullable<Turn["outcome"]>, { label: string; tone: string }> = {
  running: { label: "Moving", tone: "live-dot bg-accent" },
  done: { label: "Done", tone: "bg-ok" },
  stopped: { label: "Stopped", tone: "bg-amber-500" },
  failed: { label: "Couldn't reach the arm", tone: "bg-red-500" },
};

function AssistantTurn({ turn }: { turn: Turn }) {
  return (
    <li className="rise flex items-start gap-3">
      <Mark size={20} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <p className="text-[16px] leading-[1.5]">{turn.text}</p>
        {turn.target ? <ActionCard turn={turn} target={turn.target} /> : turn.understood && <Tag>{turn.understood}</Tag>}
        <DemoNote turn={turn} short className="text-[12px]" />
      </div>
    </li>
  );
}

// What the arm was asked to do and how it's going, in the item's colour.
function ActionCard({ turn, target }: { turn: Turn; target: NonNullable<Turn["target"]> }) {
  const outcome = turn.outcome && OUTCOME[turn.outcome];
  // A release has no spot of its own; position 0 means nothing was in the gripper.
  const onTray = target.position > 0;
  return (
    <div
      className="relative flex items-center gap-3 overflow-hidden rounded-2xl bg-surface p-3"
      style={{ "--c": onTray ? slotColor(target.position) : "var(--muted)" } as CSSProperties}
    >
      {onTray && <SlotToken position={target.position} size={36} className="text-[13px]" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium">{turn.understood}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted">
          {outcome && (
            <>
              <span className={`size-1.5 shrink-0 rounded-full ${outcome.tone}`} aria-hidden />
              {outcome.label}
              <span aria-hidden>·</span>
            </>
          )}
          <span className="font-mono text-[12px] tabular-nums">{degrees(target.angle)}</span>
        </p>
      </div>
      {turn.outcome === "running" && <span className="progress absolute inset-x-0 bottom-0 h-0.5" aria-hidden />}
    </div>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-7 w-fit items-center rounded-lg bg-surface px-2.5 text-[13px] text-muted">{children}</span>;
}

function Composer() {
  const mode = useAssistant((s) => s.mode);
  const ask = useAssistant((s) => s.ask);
  const startListening = useAssistant((s) => s.startListening);
  const finishListening = useAssistant((s) => s.finishListening);
  const stopArm = useAssistant((s) => s.stopArm);
  const [text, setText] = useState("");

  // While the arm moves, typing is still allowed so "stop" can be typed.
  const canSend = text.trim() !== "" && (mode === "idle" || mode === "moving");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    void ask(text, "text");
    setText("");
  };

  const round = "press grid size-14 shrink-0 place-items-center rounded-full";

  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <label className="flex h-14 min-w-0 flex-1 items-center rounded-full border border-transparent bg-surface pr-1.5 pl-5 transition-colors focus-within:border-line">
        <span className="sr-only">Tell the arm what you need</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask for something"
          enterKeyHint="send"
          autoComplete="off"
          // 16px+: below that, iOS zooms the page when the field is focused.
          className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted focus-visible:outline-none"
        />
        <button
          type="submit"
          aria-label="Send"
          aria-disabled={!canSend || undefined}
          className="press grid size-11 shrink-0 place-items-center rounded-full bg-fg text-bg aria-disabled:opacity-15"
        >
          <SendIcon size={18} />
        </button>
      </label>
      {mode === "moving" ? (
        <button type="button" onClick={stopArm} aria-label="Stop the arm" className={`${round} bg-accent text-on-accent`}>
          <StopIcon size={20} />
        </button>
      ) : (
        <button
          type="button"
          onClick={mode === "listening" ? finishListening : startListening}
          aria-label={mode === "listening" ? "Done talking" : "Talk"}
          aria-pressed={mode === "listening"}
          aria-disabled={mode === "thinking" || undefined}
          className={`${round} aria-disabled:opacity-50 ${mode === "listening" ? "bg-accent text-on-accent" : "bg-surface text-muted hover:text-fg"}`}
        >
          {mode === "listening" ? (
            <VoiceBars state="listening" size={20} />
          ) : (
            <MicIcon size={20} />
          )}
        </button>
      )}
    </form>
  );
}
