"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

export function useReducedMotion() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(REDUCED);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

// The equivalent of `to` closest to `from`, so a turn from 30° to 270° goes −120°, not +240°.
export const nearest = (from: number, to: number) => from + ((((to - from) % 360) + 540) % 360) - 180;

// Same curve as --ease-servo.
const servo = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);

export const DIAL_MS = 420;

// An unwrapped angle for CSS rotation, so transitions take the short way round.
export function useUnwrappedAngle(angle: number) {
  const [state, setState] = useState({ target: angle, value: angle });
  if (state.target !== angle) {
    const value = nearest(state.value, angle);
    setState({ target: angle, value });
    return value;
  }
  return state.value;
}

// The readout counts through every degree on its way to a new angle, like the nav readout.
export function useCountedAngle(angle: number) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(angle);
  const current = useRef(angle);

  useEffect(() => {
    const from = current.current;
    const to = nearest(from, angle);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const k = reduced ? 1 : Math.min(1, (now - start) / DIAL_MS);
      current.current = from + (to - from) * servo(k);
      setShown(current.current);
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [angle, reduced]);

  return shown;
}
