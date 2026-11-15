"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { SlotToken } from "@/components/assistant-bits";
import { TopBar } from "@/components/top-bar";
import { StopIcon } from "@/components/ui/icons";
import { BRAND } from "@/lib/site";
import { useAssistant } from "@/lib/store";
import { readTheme, setTheme, subscribeTheme } from "@/lib/theme";
import { angleOf, degrees, MAX_NAME } from "@/lib/tray";
import { canListen } from "@/lib/voice/listen";
import { resumeAudio } from "@/lib/voice/mic";
import { canSpeak } from "@/lib/voice/speak";

const noop = () => () => {};
const useClientValue = (read: () => boolean) => useSyncExternalStore(noop, read, () => true);

export function SetupScreen() {
  return (
    <main className="mx-auto min-h-svh w-full max-w-[520px] px-5 pb-[max(env(safe-area-inset-bottom),32px)]">
      <div className="sticky top-0 z-10 -mx-5">
        <TopBar title="Settings" />
      </div>

      <div className="mt-6 flex flex-col gap-8">
        <TraySection />
        <VoiceSection />
        <AppearanceSection />
        <ArmSection />
        <AssistantSection />
      </div>
      <StopBar />
    </main>
  );
}

// Stop has to be within reach on every screen while the arm moves, not only where a move starts.
function StopBar() {
  const moving = useAssistant((s) => s.mode === "moving");
  const stopArm = useAssistant((s) => s.stopArm);
  if (!moving) return null;
  return (
    <>
      <div className="h-24" aria-hidden />
      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-[520px] px-5 pb-[max(env(safe-area-inset-bottom),16px)]">
        <button
          type="button"
          onClick={stopArm}
          aria-label="Stop the arm"
          className="press flex h-16 w-full items-center justify-center gap-2.5 rounded-full bg-fg text-[17px] font-medium text-bg shadow-[0_12px_28px_-12px_rgb(0_0_0/0.45)]"
        >
          <StopIcon size={22} />
          <span aria-hidden>Stop</span>
        </button>
      </div>
    </>
  );
}

function Group({ title, note, action, children }: { title: string; note?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const id = `group-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id}>
      <div className="flex h-6 items-center justify-between px-4">
        <h2 id={id} className="text-[13px] text-muted">
          {title}
        </h2>
        {action}
      </div>
      <div className="mt-2 overflow-hidden rounded-2xl bg-surface">{children}</div>
      {note && <p className="mt-2 px-4 text-[13px] leading-normal text-muted">{note}</p>}
    </section>
  );
}

const ROW = "flex items-center gap-4 px-4 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-line";

function TraySection() {
  const tray = useAssistant((s) => s.tray);
  const renameSlot = useAssistant((s) => s.renameSlot);
  const resetTray = useAssistant((s) => s.resetTray);

  return (
    <Group
      title="Tray"
      action={
        <button type="button" onClick={resetTray} className="press -my-3 -mr-2 px-2 py-3 text-[13px] text-muted hover:text-fg">
          Reset
        </button>
      }
    >
      <ul>
        {tray.map((slot) => (
          <li key={slot.position} className={`${ROW} focus-within:bg-surface-2/50`}>
            <SlotToken position={slot.position} />
            <input
              value={slot.name}
              onChange={(e) => renameSlot(slot.position, e.target.value)}
              maxLength={MAX_NAME}
              placeholder="Empty"
              aria-label={`Item in position ${slot.position}`}
              autoComplete="off"
              className="h-12 min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-faint focus-visible:outline-none"
            />
            <span className="font-mono text-[13px] text-muted tabular-nums">{degrees(angleOf(slot.position))}</span>
          </li>
        ))}
      </ul>
    </Group>
  );
}

function VoiceSection() {
  const speakReplies = useAssistant((s) => s.speakReplies);
  const setSpeakReplies = useAssistant((s) => s.setSpeakReplies);
  const listens = useClientValue(canListen);
  const speaks = useClientValue(canSpeak);
  const handsFree = useAssistant((s) => s.handsFree);
  const setHandsFree = useAssistant((s) => s.setHandsFree);
  const wake = useAssistant((s) => s.engines.wake === "whisper");
  const stt = useAssistant((s) => s.engines.stt);

  return (
    <Group title="Voice">
      <Setting label="Read replies aloud" hint={speaks ? undefined : "Not supported in this browser"}>
        <Switch on={speakReplies && speaks} onChange={setSpeakReplies} disabled={!speaks} label="Read replies aloud" />
      </Setting>
      <Setting label="Voice input" hint={listens ? `Saying “${BRAND}” first is optional` : "Not supported here. Your keyboard's mic still works"}>
        <Badge on={listens}>{listens ? (stt === "whisper" ? "Whisper" : "On") : "Off"}</Badge>
      </Setting>
      <Setting
        label="Hands-free"
        hint={wake ? `Say “Hey ${BRAND}” instead of tapping. Keeps the screen on` : "Needs Whisper running on the laptop"}
      >
        <Switch
          on={handsFree && wake}
          onChange={(on) => {
            // Inside the tap, so iOS lets the mic's audio meter run.
            resumeAudio();
            setHandsFree(on);
          }}
          disabled={!wake}
          label="Hands-free"
        />
      </Setting>
    </Group>
  );
}

function AppearanceSection() {
  const dark = useSyncExternalStore(subscribeTheme, () => readTheme() === "dark", () => false);
  return (
    <Group title="Appearance">
      <Setting label="Dark mode">
        <Switch on={dark} onChange={(on) => setTheme(on ? "dark" : "light")} label="Dark mode" />
      </Setting>
    </Group>
  );
}

function ArmSection() {
  const robotMode = useAssistant((s) => s.robotMode);
  const setRobotMode = useAssistant((s) => s.setRobotMode);
  const health = useAssistant((s) => s.health);
  const refreshHealth = useAssistant((s) => s.refreshHealth);
  const moving = useAssistant((s) => s.mode === "moving");
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    await refreshHealth();
    setChecking(false);
  };

  const bridge = !health
    ? "Checking"
    : !health.configured
      ? "Set ROBOT_BRIDGE_URL on the server"
      : health.reachable
        ? "Connected"
        : "Not responding";

  return (
    <Group title="Arm">
      <div className="p-1.5">
        <div role="radiogroup" aria-label="Arm" className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1">
          {(["sim", "robot"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={robotMode === value}
              aria-disabled={moving || undefined}
              onClick={() => setRobotMode(value)}
              className="h-11 rounded-lg text-[15px] text-muted transition-[color,background-color] duration-150 aria-checked:bg-surface aria-checked:font-medium aria-checked:text-fg aria-checked:shadow-[0_1px_2px_rgb(0_0_0/0.12)] aria-disabled:opacity-50"
            >
              {value === "sim" ? "Simulator" : "Robot"}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-line">
        <Setting label="Robot bridge" hint={bridge}>
          <button
            type="button"
            onClick={check}
            aria-disabled={checking || undefined}
            className="press h-11 rounded-lg bg-surface-2 px-4 text-[14px] font-medium aria-disabled:opacity-50"
          >
            {checking ? "Checking" : "Check"}
          </button>
        </Setting>
      </div>
    </Group>
  );
}

function AssistantSection() {
  const [model, setModel] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/assistant", { cache: "no-store" })
      .then((res) => res.json() as Promise<{ model: boolean }>)
      .then((body) => setModel(body.model))
      .catch(() => setModel(false));
  }, []);

  return (
    <Group title="Assistant">
      <Setting
        label="Understanding"
        hint={
          model === null
            ? "Checking"
            : model
              ? "Understands hints like “I'm thirsty”"
              : "Item names only. Add an API key on the server for the AI model"
        }
      >
        {model !== null && <Badge on={model}>{model ? "AI model" : "Demo"}</Badge>}
      </Setting>
    </Group>
  );
}

function Setting({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={`${ROW} min-h-14 py-3`}>
      <div className="min-w-0 flex-1">
        <p className="text-[16px]">{label}</p>
        {hint && <p className="mt-0.5 text-[13px] leading-snug text-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Badge({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-[14px] text-muted">
      <span className={`size-1.5 rounded-full ${on ? "bg-ok" : "bg-faint"}`} aria-hidden />
      {children}
    </span>
  );
}

function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={() => !disabled && onChange(!on)}
      className={`relative h-[31px] w-[51px] rounded-full before:absolute before:inset-x-0 before:-inset-y-2 before:content-[''] transition-colors duration-200 aria-disabled:opacity-50 ${on ? "bg-accent" : "bg-surface-2"}`}
    >
      <span
        className={`absolute top-[2px] left-[2px] size-[27px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.2)] transition-transform duration-300 ease-[var(--ease-glide)] ${on ? "translate-x-5" : ""}`}
      />
    </button>
  );
}
