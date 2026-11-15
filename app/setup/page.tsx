import type { Metadata } from "next";
import { Screen } from "@/components/screen";
import { SetupScreen } from "@/components/setup-screen";

export const metadata: Metadata = { title: "Setup" };

export default function Setup() {
  return (
    <Screen>
      <SetupScreen />
    </Screen>
  );
}
