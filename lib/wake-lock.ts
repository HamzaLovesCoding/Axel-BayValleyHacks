import type { Phase } from "./robot/types";

export function needsScreenAwake(state: {
  mode: string; phase: Phase; presenting: number | null; handsFree: boolean; engines: { wake: string };
}) {
  return state.mode === "moving" || state.presenting != null || state.phase === "presenting" ||
    state.phase === "holding" || (state.handsFree && state.engines.wake === "whisper");
}

// The browser may revoke a lock on backgrounding. Reacquire on foreground, without overlapping
// requests or leaking a late sentinel after React cleanup (including Strict Mode remounts).
export function holdScreenAwake(
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
  wake: Pick<WakeLock, "request"> | undefined = navigator.wakeLock,
): () => void {
  if (!wake) return () => {};
  let disposed = false;
  let pending = false;
  let lock: WakeLockSentinel | null = null;
  const release = (sentinel: WakeLockSentinel) => { void sentinel.release().catch(() => {}); };
  const request = () => {
    if (disposed || pending || lock || page.visibilityState !== "visible") return;
    pending = true;
    void wake.request("screen").then((sentinel) => {
      if (disposed || page.visibilityState !== "visible") release(sentinel);
      else if (!sentinel.released) {
        lock = sentinel;
        sentinel.addEventListener("release", lost);
      }
    }).catch(() => {
      // Unsupported/denied locks must not prevent Stop or other app controls from working.
    }).finally(() => { pending = false; });
  };
  const lost = () => {
    lock?.removeEventListener("release", lost);
    lock = null;
    request();
  };
  request();
  page.addEventListener("visibilitychange", request);
  return () => {
    disposed = true;
    page.removeEventListener("visibilitychange", request);
    if (lock) {
      lock.removeEventListener("release", lost);
      release(lock);
      lock = null;
    }
  };
}
