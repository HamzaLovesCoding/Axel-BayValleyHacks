"use client";

import { StopIcon } from "@/components/ui/icons";
import { useAssistant } from "@/lib/store";

// Stop has to be within reach on every screen while the arm moves, not only where a move starts.
export function StopBar() {
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
