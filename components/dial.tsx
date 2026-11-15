"use client";

import type { CSSProperties, KeyboardEvent } from "react";
import { PHASE_LABEL, VoiceBars, type VoiceState } from "@/components/assistant-bits";
import { DIAL_MS, useCountedAngle, useUnwrappedAngle } from "@/components/motion";
import { useAssistant } from "@/lib/store";
import { angleOf, degrees, HANDOFF_ANGLE, slotAt, slotColor } from "@/lib/tray";

const C = 100;
const rad = (deg: number) => (deg * Math.PI) / 180;
// Tray degrees run counter-clockwise from 3 o'clock; SVG y points down, hence the minus on sin.
const at = (deg: number, r: number) => {
  // Rounded: server and browser trig differ in the last digits, which breaks hydration.
  const round = (n: number) => Math.round(n * 100) / 100;
  return { x: round(C + r * Math.cos(rad(deg))), y: round(C - r * Math.sin(rad(deg))) };
};
const pt = (deg: number, r: number) => {
  const p = at(deg, r);
  return `${p.x} ${p.y}`;
};

const FACE = 99;
const RING_IN = 69;
const RING_OUT = 95;
const MID = (RING_IN + RING_OUT) / 2;
// Half the angular gap between neighbouring tiles.
const GAP = 1.1;
const LABEL_SIZE = 7.4;
const BEAM = 13;
const BEAM_R = 65;

// A ring segment with rounded corners, drawn counter-clockwise from `from` to `to`.
function sector(from: number, to: number, rIn: number, rOut: number, corner: number) {
  const dOut = (Math.asin(corner / (rOut - corner)) * 180) / Math.PI;
  const dIn = (Math.asin(corner / (rIn + corner)) * 180) / Math.PI;
  const edgeOut = (rOut - corner) * Math.cos(rad(dOut));
  const edgeIn = (rIn + corner) * Math.cos(rad(dIn));
  const turn = `A ${corner} ${corner} 0 0 0`;
  return [
    `M ${pt(from + dOut, rOut)}`,
    `A ${rOut} ${rOut} 0 0 0 ${pt(to - dOut, rOut)}`,
    `${turn} ${pt(to, edgeOut)}`,
    `L ${pt(to, edgeIn)}`,
    `${turn} ${pt(to - dIn, rIn)}`,
    `A ${rIn} ${rIn} 0 0 1 ${pt(from + dIn, rIn)}`,
    `${turn} ${pt(from, edgeIn)}`,
    `L ${pt(from, edgeOut)}`,
    `${turn} ${pt(from + dOut, rOut)}`,
    "Z",
  ].join(" ");
}

// Everything a tile needs to draw itself. `below` tiles sit under the centre, so their label runs
// the other way round to stay upright.
function tile(center: number, half: number, below = false) {
  const from = center - half + GAP;
  const to = center + half - GAP;
  const base = MID + (below ? 1 : -1) * LABEL_SIZE * 0.36;
  return {
    shape: sector(from, to, RING_IN, RING_OUT, 5),
    // Reaches past the visible tile on both sides so the tap target clears 44px on a small phone.
    hit: sector(center - half, center + half, RING_IN - 6, FACE, 1),
    label: below
      ? `M ${pt(from, base)} A ${base} ${base} 0 0 0 ${pt(to, base)}`
      : `M ${pt(to, base)} A ${base} ${base} 0 0 1 ${pt(from, base)}`,
  };
}

const YOU = tile(HANDOFF_ANGLE, 18, true);
const TRAVEL = [205, 215, 225, 235, 245, 295, 305, 315, 325, 335];

const fit = (name: string, max: number) => (name.length > max ? `${name.slice(0, max - 1).trimEnd()}…` : name);

type TileState = "idle" | "active" | "away" | "empty" | "place" | "offered";

function Tile({
  id,
  geometry,
  label,
  state,
  color,
  dim = false,
  delay = 0,
  request,
  onAsk,
}: {
  id: string;
  geometry: ReturnType<typeof tile>;
  label: string;
  state: TileState;
  color: string;
  dim?: boolean;
  delay?: number;
  // What tapping it says. Omitted when there is nothing to ask for.
  request?: { phrase: string; enabled: boolean };
  onAsk: (phrase: string) => void;
}) {
  const press = () => request?.enabled && onAsk(request.phrase);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    press();
  };

  return (
    <g
      className="tile"
      data-state={state}
      data-dim={dim || undefined}
      style={{ "--c": color } as CSSProperties}
      {...(request
        ? { role: "button", tabIndex: 0, "aria-label": request.phrase, "aria-disabled": !request.enabled || undefined, onClick: press, onKeyDown }
        : { "aria-hidden": true })}
    >
      <g className="tile-in" style={{ animationDelay: `${delay}ms` }}>
        <g className="tile-press">
          <path className="tile-shape" d={geometry.shape} />
          <path id={id} d={geometry.label} fill="none" />
          <text className="tile-label" fontSize={LABEL_SIZE} fontWeight={550} textAnchor="middle">
            <textPath href={`#${id}`} startOffset="50%">
              {label}
            </textPath>
          </text>
        </g>
      </g>
      {request && <path d={geometry.hit} fill="transparent" />}
    </g>
  );
}

// The tray seen from above, and the way to use it: every spot is a tile you can tap to ask for
// what's on it, You sits at the bottom where the arm hands things over, and a beam of light
// follows the arm. The middle is the assistant itself: listening, thinking, talking, or busy.
export function Dial({ className = "" }: { className?: string }) {
  const tray = useAssistant((s) => s.tray);
  const angle = useAssistant((s) => s.angle);
  const active = useAssistant((s) => s.active);
  const holding = useAssistant((s) => s.holding);
  const presenting = useAssistant((s) => s.presenting);
  const away = useAssistant((s) => s.away);
  const mode = useAssistant((s) => s.mode);
  const phase = useAssistant((s) => s.phase);
  const speaking = useAssistant((s) => Number.isFinite(s.spokenTo));
  const ask = useAssistant((s) => s.ask);
  const unwrapped = useUnwrappedAngle(angle);
  const shown = useCountedAngle(angle);

  const item = slotAt(tray, active);
  const held = slotAt(tray, holding);
  const busy = mode !== "idle";
  const live = mode === "listening" || mode === "moving";
  const tint = item ? slotColor(item.position) : "var(--accent)";
  // On its way back to the tray, the item has already left the hand-over point.
  const offered = slotAt(tray, presenting);
  const atYou = offered ?? (held && phase !== "returning" && phase !== "placing" ? held : undefined);
  const onAsk = (phrase: string) => void ask(phrase, "tap");

  const voice: VoiceState = mode === "listening" ? "listening" : mode === "thinking" ? "thinking" : speaking ? "speaking" : "idle";
  const title = mode === "listening" ? "Listening" : mode === "thinking" ? "Thinking" : (item?.name.trim() || (mode === "moving" ? "Moving" : PHASE_LABEL[phase]));
  const detail = mode === "moving" || mode === "idle" ? (item ? PHASE_LABEL[phase] : null) : null;
  const sweep = [at(90, FACE), at(30, FACE)];
  const rotate: CSSProperties = {
    transform: `rotate(${-unwrapped}deg)`,
    transformOrigin: `${C}px ${C}px`,
    transition: `transform ${DIAL_MS * 2.2}ms var(--ease-servo)`,
  };

  return (
    <div className={`relative aspect-square ${className}`}>
      {/* Ambient light in the colour of whatever the arm is busy with. */}
      <div
        className="dial-glow pointer-events-none absolute -inset-[10%] rounded-full blur-2xl"
        style={{
          background: `radial-gradient(closest-side, color-mix(in oklab, ${tint} 30%, transparent), transparent)`,
          opacity: mode === "idle" ? 0.4 : 1,
        }}
        aria-hidden
      />

      <svg viewBox="0 0 200 200" className="relative size-full overflow-visible" role="group" aria-label="Tray">
        <defs>
          <radialGradient id="dial-beam" gradientUnits="userSpaceOnUse" cx={C} cy={C} r={BEAM_R}>
            <stop offset="0.42" stopColor={tint} stopOpacity={0} />
            <stop offset="1" stopColor={tint} stopOpacity={0.36} />
          </radialGradient>
        </defs>

        <g aria-hidden>
          {mode === "listening" && (
            <>
              <circle className="dial-pulse" cx={C} cy={C} r={FACE} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
              <circle className="dial-pulse" cx={C} cy={C} r={FACE} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
            </>
          )}

          <circle
            className="dial-face"
            cx={C}
            cy={C}
            r={FACE}
            fill="var(--surface)"
            stroke={live ? tint : "var(--line)"}
            strokeWidth={live ? 1.5 : 1}
          />

          {mode === "thinking" && (
            <path
              className="dial-sweep"
              d={`M ${sweep[0].x} ${sweep[0].y} A ${FACE} ${FACE} 0 0 1 ${sweep[1].x} ${sweep[1].y}`}
              fill="none"
              stroke="var(--fg)"
              strokeWidth={2}
              strokeLinecap="round"
            />
          )}

          {/* The stretch the arm swings through on its way down to you. */}
          {TRAVEL.map((d) => (
            <circle key={d} cx={at(d, MID).x} cy={at(d, MID).y} r={0.9} fill="var(--faint)" />
          ))}

          <g style={rotate}>
            <path
              d={`M ${C} ${C} L ${pt(BEAM, BEAM_R)} A ${BEAM_R} ${BEAM_R} 0 0 1 ${pt(-BEAM, BEAM_R)} Z`}
              fill="url(#dial-beam)"
              opacity={busy ? 1 : 0.5}
              className="transition-opacity duration-500"
            />
            <path
              d={`M ${pt(7, BEAM_R)} A ${BEAM_R} ${BEAM_R} 0 0 1 ${pt(-7, BEAM_R)}`}
              fill="none"
              stroke={tint}
              strokeWidth={2.6}
              strokeLinecap="round"
              className="transition-[stroke] duration-500"
            />
          </g>
        </g>

        {tray.map((slot, i) => {
          const name = slot.name.trim();
          const on = slot.position === active && mode === "moving";
          // Off the tray: in the gripper, on its way over, or handed to the person.
          const gone = slot.position === holding || away.includes(slot.position) || (on && phase === "bringing");
          return (
            <Tile
              key={slot.position}
              id={`dial-spot-${slot.position}`}
              geometry={tile(angleOf(slot.position), 15)}
              label={fit(name, 8)}
              state={!name ? "empty" : gone ? "away" : on ? "active" : "idle"}
              color={slotColor(slot.position)}
              dim={busy && !on}
              delay={80 + i * 45}
              request={
                name
                  ? { phrase: gone ? `Put the ${name.toLowerCase()} back` : `Bring me the ${name.toLowerCase()}`, enabled: !busy }
                  : undefined
              }
              onAsk={onAsk}
            />
          );
        })}

        <Tile
          id="dial-spot-you"
          geometry={YOU}
          label={atYou ? fit(atYou.name.trim(), 10) : "You"}
          state={offered ? "offered" : atYou ? "active" : "place"}
          color={atYou ? slotColor(atYou.position) : "var(--muted)"}
          delay={80 + tray.length * 45}
          request={atYou ? { phrase: offered ? "Take it" : "Release", enabled: !busy } : undefined}
          onAsk={onAsk}
        />
      </svg>

      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="flex w-[54%] flex-col items-center text-center">
          <VoiceBars
            state={voice}
            size={26}
            className={mode === "listening" ? "text-accent" : item ? "" : "text-faint"}
            style={item && mode !== "listening" ? { color: slotColor(item.position) } : undefined}
          />
          <p
            key={title}
            className={`rise mt-3 max-w-full truncate font-medium tracking-[-0.02em] ${item && !["listening", "thinking"].includes(mode) ? "text-[clamp(20px,6vw,24px)] leading-tight" : "text-[17px]"}`}
          >
            {title}
          </p>
          <p className="mt-1 flex max-w-full items-center gap-1.5 text-[13px] text-muted">
            {detail && <span className="truncate">{detail}</span>}
            <span className="font-mono text-[12px] tabular-nums" aria-hidden>
              {degrees(shown)}
            </span>
          </p>
          <span className="sr-only">Arm heading {Math.round(angle)} degrees.</span>
        </div>
      </div>
    </div>
  );
}
