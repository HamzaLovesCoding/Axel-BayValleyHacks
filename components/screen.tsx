import { ViewTransition, type ReactNode } from "react";

// Slides screens left/right on links tagged nav-forward / nav-back. Lives in each page, not the
// layout, because layouts persist across navigations and never enter or exit.
const SLIDE = { "nav-forward": "nav-forward", "nav-back": "nav-back", default: "none" };

export function Screen({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter={SLIDE} exit={SLIDE} default="none">
      {children}
    </ViewTransition>
  );
}
