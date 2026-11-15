import { BRAND } from "@/lib/site";

// The tray seen from above: the half the arm can reach, and the dot where it hands things over.
export function Mark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden className={`shrink-0 ${className}`}>
      <path d="M2.5 14a9.5 9.5 0 0 1 19 0Z" fill="currentColor" />
      <circle cx="12" cy="20" r="2.4" fill="var(--accent)" />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="flex items-center gap-2 text-[17px] font-medium tracking-[-0.01em]">
      <Mark size={20} />
      {BRAND}
    </span>
  );
}
