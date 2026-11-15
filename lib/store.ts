import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { interpretKeywords } from "./assistant";
import { parseCommand, type AssistantRequest, type Command, type Interpretation } from "./command";
import { bridgeLink, BridgeError, checkRobot, type RobotHealth } from "./robot/bridge";
import { createSimLink, simLink } from "./robot/sim";
import { STOP_FAILURE, type Phase, type RobotLink, type RobotMessage } from "./robot/types";
import { angleOf, DEFAULT_TRAY, HANDOFF_ANGLE, MAX_NAME, pronoun, REST_ANGLE, slotAt, type Slot } from "./tray";
import { canListen, listen, type Listening, type ListenProblem } from "./voice/listen";
import { BROWSER_VOICE, fetchEngines, type VoiceEngines } from "./voice/engines";
import { speak, unlockSpeech } from "./voice/speak";

export type Mode = "idle" | "listening" | "thinking" | "moving";
export type Via = "voice" | "text" | "tap";

export type Target = { position: number; angle: number; name: string };

export type Turn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  time: string;
  via?: Via;
  understood?: string;
  action?: Command["action"] | null;
  target?: Target | null;
  source?: Interpretation["source"];
  link?: RobotLink["kind"];
  outcome?: "running" | "done" | "stopped" | "failed";
};

// The big line on the voice screen. `by` picks the voice: what a person says is set in serif.
export type Line = { id: string; text: string; by: "person" | "assistant"; spoken: boolean };

export type State = {
  mode: Mode;
  interim: string;
  line: Line;
  // How far the current line has been read out, as a character index. Infinity once it's done.
  spokenTo: number;

  phase: Phase;
  // Where the arm is headed, in tray degrees.
  angle: number;
  active: number | null;
  holding: number | null;
  presenting: number | null;
  // Items handed over and not yet put back, oldest first.
  away: number[];

  turns: Turn[];
  health: RobotHealth | null;
  // Speech engines the server is set up for (Whisper, ElevenLabs), else the browser's.
  engines: VoiceEngines;

  // Persisted settings.
  tray: Slot[];
  speakReplies: boolean;
  // Listen for "Hey Axel" without a tap (components/hands-free.tsx). Needs Whisper on the laptop.
  handsFree: boolean;
  robotMode: RobotLink["kind"];

  ask: (text: string, via: Via) => Promise<void>;
  startListening: () => void;
  finishListening: () => void;
  cancelListening: () => void;
  stopArm: () => void;
  renameSlot: (position: number, name: string) => void;
  resetTray: () => void;
  setSpeakReplies: (on: boolean) => void;
  setHandsFree: (on: boolean) => void;
  setRobotMode: (mode: RobotLink["kind"]) => void;
  refreshHealth: () => Promise<void>;
  refreshEngines: () => Promise<void>;
  clearConversation: () => void;
};

export const INTRO: Line = { id: "intro", text: "What can I bring you?", by: "assistant", spoken: false };

// Counter rather than crypto.randomUUID, which is missing on plain-http LAN addresses.
let seq = 0;
const uid = () => String(++seq);
const clock = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

let listening: Listening | null = null;
let listenCancelled = false;
let motion: AbortController | null = null;
let requestEpoch = 0;
let stopPending: Promise<void> | null = null;
// The big button flips from Stop back to Talk when a move ends. A Stop tap that lands just after
// that would start listening instead, so Talk ignores taps for a moment.
let motionEndedAt = 0;
const SETTLE_MS = 700;
let stopSpeaking: (() => void) | null = null;
// A line waiting for the current one to finish being read out.
let queued: string | null = null;

const PROBLEM_LINES: Record<ListenProblem | "unsupported" | "insecure", string> = {
  insecure: "The microphone only works on the secure https address. Open that one, or type instead.",
  denied: "The microphone is off for this page. Allow it in your browser settings, or type instead.",
  "no-speech": "I didn't hear anything. Tap the mic and try again.",
  failed: "Voice input stopped working. Try again, or type instead.",
  unsupported: "This browser can't listen. Type instead. Your keyboard's mic works too.",
};

const safeStorage: StateStorage = {
  getItem: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
  removeItem: (key) => {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

async function interpret(request: AssistantRequest): Promise<Interpretation> {
  try {
    const res = await fetch("/api/assistant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as Partial<Interpretation>;
    if (typeof body.reply !== "string" || typeof body.understood !== "string") throw new Error("Bad reply");
    return {
      reply: body.reply,
      understood: body.understood,
      command: parseCommand(body.command, request.tray),
      source: body.source === "model" ? "model" : "keywords",
    };
  } catch {
    // Server unreachable: keep working with the on-device demo matcher.
    return interpretKeywords(request);
  }
}

const itemName = (slot: Slot | undefined) => slot?.name.trim().toLowerCase() || "item";

export const useAssistant = create<State>()(
  persist(
    (set, get) => {
      let lastStatusError: string | null = null;
      const networkLine = "I couldn't reach the arm. Check the robot connection in Setup.";
      // `urgent` is for "the arm may not have stopped": said even with replies muted, and with the
      // browser's own voice so it never waits on the speech service.
      const say = (text: string, by: Line["by"] = "assistant", aloud = true, urgent = false) => {
        urgent ||= text === STOP_FAILURE;
        if (urgent) queued = null;
        stopSpeaking?.();
        stopSpeaking = null;
        const line: Line = { id: uid(), text, by, spoken: aloud && (urgent || get().speakReplies) };
        set({ line, spokenTo: line.spoken ? 0 : Infinity });
        if (!line.spoken) return;
        stopSpeaking = speak(
          text,
          (charIndex) => {
            if (get().line.id === line.id) set({ spokenTo: charIndex });
          },
          () => {
            if (get().line.id !== line.id) return;
            set({ spokenTo: Infinity });
            const next = queued;
            queued = null;
            if (next) say(next);
          },
          urgent ? "browser" : get().engines.tts,
        );
      };

      // Says it now, or right after the current line if one is still being read out.
      const sayNext = (text: string) => {
        if (get().spokenTo === Infinity) say(text);
        else queued = text;
      };

      const patchTurn = (id: string, patch: Partial<Turn>) =>
        set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

      const addTurn = (turn: Omit<Turn, "id" | "time">) => {
        const id = uid();
        set((s) => ({ turns: [...s.turns, { ...turn, id, time: clock() }] }));
        return id;
      };

      // The model can be wrong about what the arm is holding. Check against what we actually know.
      const check = (result: Interpretation): Interpretation => {
        const { holding, presenting, tray } = get();
        const command = result.command;
        const held = slotAt(tray, holding);
        const refuse = (reply: string) => ({ ...result, reply, command: null });
        if (!command) return result;
        if (command.action === "fetch" && held)
          return refuse("I'm already holding something. Release it or put it back first.");
        if (command.action === "fetch" && presenting != null)
          return refuse("I'm waiting for you to hand something back first.");
        if (command.action === "release" && holding == null && presenting == null)
          return refuse("I'm not holding anything.");
        if (command.action === "return" && presenting != null)
          return refuse("I'm already waiting for you to hand it to me.");
        if (command.action === "return" && holding != null && holding !== command.position)
          return refuse("I'm holding something else. Release it or put it back first.");
        if (command.action === "take" && presenting !== command.position)
          return refuse(`I'm not waiting for the ${itemName(slotAt(tray, command.position))} right now.`);
        return result;
      };

      const toMessage = (command: Command): RobotMessage => {
        if (command.action === "release" || command.action === "stop") return { action: command.action };
        const slot = slotAt(get().tray, command.position);
        return { action: command.action, position: command.position, angle: angleOf(command.position), item: slot?.name ?? "" };
      };

      const run = async (command: Command, turnId: string) => {
        const link = get().robotMode === "robot" ? bridgeLink : createSimLink(() => get());
        const message = toMessage(command);
        const position = "position" in command ? command.position : (get().holding ?? get().presenting);
        const slot = slotAt(get().tray, position);
        const wasPresenting = get().presenting != null;
        let reached: Phase = get().phase;

        const controller = new AbortController();
        motion = controller;
        set({ mode: "moving", active: position ?? null, health: get().health ? { ...get().health!, canRelease: false } : null });
        patchTurn(turnId, { outcome: "running", link: link.kind });

        try {
          await link.run(
            message,
            (event) => {
              reached = event.phase;
              const fallback =
                event.phase === "bringing" || event.phase === "holding" || event.phase === "releasing" || event.phase === "presenting"
                  ? HANDOFF_ANGLE
                  : event.phase === "stowing" || event.phase === "stowed"
                    ? REST_ANGLE
                    : "angle" in message
                      ? message.angle
                      : get().angle;
              set({ phase: event.phase, angle: event.angle ?? fallback });
              if ((command.action === "fetch" && ["bringing", "holding"].includes(event.phase)) ||
                  (command.action === "take" && event.phase === "returning"))
                set({ holding: position, presenting: null });
              if (["release", "return", "take"].includes(command.action) && ["stowing", "stowed"].includes(event.phase))
                set({ holding: null, presenting: null });
              if (event.phase === "holding" && slot) {
                const them = pronoun(slot.name);
                sayNext(
                  `${them === "them" ? "Here are" : "Here's"} the ${itemName(slot)}. Say “release” when you've got ${them}.`,
                );
              }
            },
            controller.signal,
          );

          if (command.action === "fetch") set({ holding: command.position, presenting: null, phase: "holding", angle: HANDOFF_ANGLE });
          else if (command.action === "return" && reached === "presenting") {
            set({ holding: null, presenting: command.position, phase: "presenting", angle: HANDOFF_ANGLE });
            const reply = `Put the ${itemName(slot)} in my hand and say go.`;
            patchTurn(turnId, { text: reply });
            sayNext(reply);
          } else {
            set((s) => ({
              holding: null, presenting: null,
              away: command.action === "release" && position != null && !wasPresenting
                ? [...s.away.filter((p) => p !== position), position]
                : command.action === "return" || command.action === "take" ? s.away.filter((p) => p !== command.position) : s.away,
              phase: "stowed", angle: REST_ANGLE, active: null,
            }));
            say("Done. Anything else?", "assistant", false);
          }
          patchTurn(turnId, { outcome: "done" });
        } catch (error) {
          if (controller.signal.aborted) {
            // If it stopped after closing the gripper, assume the item is still in it.
            const gripped = command.action === "fetch" && ["bringing", "holding"].includes(reached);
            set({ phase: "stopped", holding: gripped ? command.position : get().holding });
            patchTurn(turnId, { outcome: "stopped" });
          } else {
            set({ phase: "stopped" });
            patchTurn(turnId, { outcome: "failed" });
            say(
              link.kind === "robot"
                ? (error instanceof BridgeError ? error.message : networkLine)
                : "Something went wrong in the simulator.",
            );
          }
        } finally {
          if (motion === controller) motion = null;
          motionEndedAt = performance.now();
          set({ mode: stopPending ? "moving" : "idle" });
          if (link.kind === "robot") void get().refreshHealth();
        }
      };

      return {
        mode: "idle",
        interim: "",
        line: INTRO,
        spokenTo: Infinity,
        phase: "stowed",
        angle: REST_ANGLE,
        active: null,
        holding: null,
        presenting: null,
        away: [],
        turns: [],
        health: null,
        engines: BROWSER_VOICE,
        tray: DEFAULT_TRAY,
        speakReplies: true,
        handsFree: false,
        robotMode: "sim",

        ask: async (raw, via) => {
          const text = raw.trim();
          if (!text) return;
          const { mode, tray, holding, presenting, away, turns } = get();
          // Stop and hand-back confirmation are local, so neither waits for an AI response.
          // "Wait" and "hold on" also stop, except while the open gripper is waiting for the item:
          // there they just mean "not yet", and must not cancel the hand-back.
          const notYet = /\b(wait|hold on)\b/i.test(text);
          const waitingForItem = presenting != null && mode === "idle";
          if (/\b(stop|halt|freeze)\b/i.test(text) || (notYet && !waitingForItem)) {
            addTurn({ role: "user", text, via });
            return get().stopArm();
          }
          if (stopPending || mode === "thinking" || mode === "listening") return;
          unlockSpeech();

          if (mode === "moving") {
            addTurn({ role: "user", text, via });
            const reply = "I'm still moving. Say “stop” if you need me to.";
            addTurn({ role: "assistant", text: reply });
            return say(reply);
          }

          addTurn({ role: "user", text, via });
          set({ mode: "thinking" });
          say(text, "person", false);

          const epoch = ++requestEpoch;
          const request: AssistantRequest = {
            text, tray, holding, presenting, lastFetched: away.at(-1) ?? null,
            history: turns.slice(-8).map((t) => ({ role: t.role, text: t.text })),
          };
          const confirmation = presenting != null && (notYet || /^(go|ok|okay|got it|take it)[.!?]*$/i.test(text));
          const interpretation = confirmation ? interpretKeywords(request) : await interpret(request);
          if (epoch !== requestEpoch) return;
          const result = check(interpretation);

          const command = result.command;
          const position = command && "position" in command ? command.position : command?.action === "release" ? holding : null;
          const slot = slotAt(tray, position);
          const target: Target | null =
            command?.action === "release"
              ? { position: holding ?? 0, angle: HANDOFF_ANGLE, name: "You" }
              : slot
                ? { position: slot.position, angle: angleOf(slot.position), name: slot.name }
                : null;

          const turnId = addTurn({
            role: "assistant",
            text: result.reply,
            understood: result.understood,
            action: command?.action ?? null,
            target,
            source: result.source,
          });
          say(result.reply);

          if (command?.action === "stop") return get().stopArm();
          if (command) return run(command, turnId);
          set({ mode: "idle" });
        },

        startListening: () => {
          if (get().mode !== "idle" || performance.now() - motionEndedAt < SETTLE_MS) return;
          unlockSpeech();
          stopSpeaking?.();
          const engine = get().engines.stt;
          // Browsers only give a page the mic on https (or localhost).
          if (typeof window !== "undefined" && window.isSecureContext === false) return say(PROBLEM_LINES.insecure, "assistant", false);
          if (!canListen(engine)) return say(PROBLEM_LINES.unsupported, "assistant", false);

          listenCancelled = false;
          set({ mode: "listening", interim: "" });
          listening = listen({
            onText: (text) => set({ interim: text }),
            onProblem: (problem) => say(PROBLEM_LINES[problem], "assistant", false),
            onEnd: () => {
              listening = null;
              const text = get().interim.trim();
              set({ mode: "idle", interim: "" });
              if (text && !listenCancelled) void get().ask(text, "voice");
            },
          }, engine);
          if (!listening) {
            set({ mode: "idle" });
            say(PROBLEM_LINES.failed, "assistant", false);
          }
        },

        finishListening: () => listening?.finish(),

        cancelListening: () => {
          listenCancelled = true;
          listening?.cancel();
        },

        stopArm: () => {
          if (stopPending) return;
          const link = get().robotMode === "robot" ? bridgeLink : simLink;
          // Start the dedicated Stop request before cancelling the stream or doing speech work.
          const stopping = link.stop();
          unlockSpeech();
          requestEpoch++;
          motion?.abort();
          queued = null;
          stopSpeaking?.();
          set({ phase: "stopped", presenting: null, mode: "moving", health: get().health ? { ...get().health!, canRelease: false } : null });
          const turnId = addTurn({ role: "assistant", text: "Stopping.", understood: "Stop the arm", action: "stop", outcome: "running" });
          say("Stopping.", "assistant", false);
          stopPending = stopping.then(() => {
            const reply = "Stopped. Tell me what to do next.";
            patchTurn(turnId, { text: reply, outcome: "done" });
            say(reply);
          }).catch(() => {
            // A transport failure or malformed acknowledgement is also an unconfirmed Stop.
            const reply = STOP_FAILURE;
            lastStatusError = reply;
            set({ health: { ...(get().health ?? { configured: true }), reachable: false, error: reply } });
            patchTurn(turnId, { text: reply, outcome: "failed" });
            say(reply, "assistant", true, true);
          }).finally(() => {
            stopPending = null;
            if (!motion) set({ mode: "idle" });
            if (link.kind === "robot") void get().refreshHealth();
          });
        },

        renameSlot: (position, name) =>
          set((s) => ({
            tray: s.tray.map((slot) => (slot.position === position ? { ...slot, name: name.slice(0, MAX_NAME) } : slot)),
          })),

        resetTray: () => set({ tray: DEFAULT_TRAY }),

        setHandsFree: (handsFree) => set({ handsFree }),

        setSpeakReplies: (on) => {
          if (!on && get().line.text !== STOP_FAILURE) stopSpeaking?.();
          set({ speakReplies: on });
        },

        setRobotMode: (robotMode) => {
          if (get().mode !== "idle" || stopPending) return;
          lastStatusError = null;
          set({ robotMode, holding: null, presenting: null, away: [], phase: "stowed", angle: REST_ANGLE, active: null, health: null });
          if (robotMode === "robot") void get().refreshHealth();
        },

        refreshHealth: async () => {
          const robotMode = get().robotMode;
          const epoch = requestEpoch;
          const health = await checkRobot();
          if (get().robotMode !== robotMode || epoch !== requestEpoch) return;
          set({ health });
          if (robotMode === "robot") {
            if (health.error && health.error !== lastStatusError) {
              lastStatusError = health.error;
              queued = null;
              addTurn({ role: "assistant", text: health.error });
              say(health.error, "assistant", true, /confirm the arm stopped/i.test(health.error));
            } else if (health.reachable) lastStatusError = null;
          }
          if (robotMode === "robot" && !motion && !["thinking", "listening"].includes(get().mode) && health.holding !== undefined && health.presenting !== undefined) {
            const { holding, presenting } = health;
            const stopped = !health.reachable || health.needsRecovery || get().phase === "stopped";
            set({ holding, presenting, active: holding ?? presenting,
              mode: health.busy || stopPending ? "moving" : "idle",
              phase: stopped ? "stopped" : holding != null ? "holding" : presenting != null ? "presenting" : "stowed",
              angle: stopped ? get().angle : holding != null || presenting != null ? HANDOFF_ANGLE : REST_ANGLE });
          }
        },

        refreshEngines: async () => {
          set({ engines: await fetchEngines() });
        },

        clearConversation: () => {
          if (get().mode !== "idle") return;
          set({ turns: [], line: INTRO, spokenTo: Infinity });
        },
      };
    },
    {
      name: "assistant-settings",
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      // Rehydrated in a client effect so the server render and first client render match.
      skipHydration: true,
      partialize: (s) => ({ tray: s.tray, speakReplies: s.speakReplies, robotMode: s.robotMode, handsFree: s.handsFree }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<State>;
        const tray =
          Array.isArray(saved.tray) && saved.tray.length === DEFAULT_TRAY.length
            ? DEFAULT_TRAY.map((d, i) => ({
                position: d.position,
                name: typeof saved.tray?.[i]?.name === "string" ? saved.tray[i].name.slice(0, MAX_NAME) : d.name,
              }))
            : current.tray;
        return {
          ...current,
          tray,
          speakReplies: typeof saved.speakReplies === "boolean" ? saved.speakReplies : current.speakReplies,
          robotMode: saved.robotMode === "robot" ? "robot" : "sim",
          handsFree: saved.handsFree === true,
        };
      },
    },
  ),
);
