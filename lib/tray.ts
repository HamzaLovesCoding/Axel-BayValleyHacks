export type Slot = { position: number; name: string };

// Position n sits at (n − 1) × 30°. 0° is 3 o'clock and angles grow counter-clockwise, so the
// seven positions fill the half of the tray the base can reach (0–180°).
export const angleOf = (position: number) => (position - 1) * 30;

// The person sits at 270°: the arm folds back over its base to hand things over.
export const HANDOFF_ANGLE = 270;
export const REST_ANGLE = 90;

export const DEFAULT_TRAY: Slot[] = ["Keys", "Glasses", "Water", "Pills", "Phone", "Remote", "Book"].map((name, i) => ({
  position: i + 1,
  name,
}));

export const MAX_NAME = 24;

// Colours live in globals.css (--slot-1 … --slot-7) so they follow the light/dark theme.
export const slotColor = (position: number) => `var(--slot-${position})`;

export const degrees = (deg: number) => `${String(Math.round(((deg % 360) + 360) % 360)).padStart(3, "0")}°`;

// "Bring me the glasses" → them; "the water" → it. Good enough for the default items.
export const pronoun = (name: string) => (/s$/i.test(name.trim()) ? "them" : "it");

export const slotAt = (tray: Slot[], position: number | null | undefined) =>
  position == null ? undefined : tray.find((s) => s.position === position);
