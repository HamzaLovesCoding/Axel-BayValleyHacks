"use client";

import { useEffect, useLayoutEffect } from "react";
import { useAssistant } from "@/lib/store";
import { applyTheme, readTheme } from "@/lib/theme";

// Loads saved settings after the first render, so server and client markup match, then checks
// whether the robot bridge is up and which speech engines the server has.
export function Boot() {
  // The layout's inline script sets the theme on first load. This re-applies it before paint after
  // React resets <html> attributes (Strict Mode's dev remount), and syncs the browser bar colour.
  useLayoutEffect(() => applyTheme(readTheme()), []);
  useEffect(() => {
    let active = true;
    void Promise.resolve(useAssistant.persist.rehydrate()).then(() => {
      if (!active) return;
      void useAssistant.getState().refreshHealth();
      void useAssistant.getState().refreshEngines();
    });
    const refresh = () => {
      if (useAssistant.getState().robotMode === "robot") void useAssistant.getState().refreshHealth();
    };
    const leaving = () => {
      const state = useAssistant.getState();
      if (state.robotMode === "robot" && state.mode === "moving") state.stopArm();
    };
    // Lives here, not in a screen, so Esc stops the arm from every screen. It also cancels a request
    // that is still being understood, before it can start a move.
    const onKey = (e: KeyboardEvent) => {
      const state = useAssistant.getState();
      if (e.key === "Escape" && (state.mode === "moving" || state.mode === "thinking")) state.stopArm();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("pagehide", leaving);
    const timer = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("pagehide", leaving);
    };
  }, []);
  return null;
}
