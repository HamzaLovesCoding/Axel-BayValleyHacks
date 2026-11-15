"use client";

import { usePathname } from "next/navigation";
import { Boot } from "./boot";
import { HandsFree } from "./hands-free";

// The locked screen must not rehydrate hands-free settings or start background API/mic work.
export function AppRuntime() {
  const pathname = usePathname();
  if (pathname === "/passcode") return null;
  return <><Boot /><HandsFree /></>;
}
