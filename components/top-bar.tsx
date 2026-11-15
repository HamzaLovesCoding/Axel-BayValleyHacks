import Link from "next/link";
import type { ReactNode } from "react";
import { BackIcon } from "@/components/ui/icons";

export const ROUND = "press grid size-11 place-items-center rounded-full text-muted hover:bg-surface hover:text-fg";

// Header for the screens behind the voice screen: back on the left, one optional action on the right.
export function TopBar({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 grid grid-cols-[44px_1fr_44px] items-center gap-3 border-b border-line bg-bg/85 px-3 pt-[max(env(safe-area-inset-top),8px)] pb-2 backdrop-blur-md">
      <Link href="/" transitionTypes={["nav-back"]} aria-label="Back to voice" className={ROUND}>
        <BackIcon size={20} />
      </Link>
      <div className="flex min-w-0 flex-col items-center">
        <h1 className="text-[16px] font-medium">{title}</h1>
        {subtitle}
      </div>
      {action ?? <span />}
    </header>
  );
}
