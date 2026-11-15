import type { Metadata } from "next";
import { ChatScreen } from "@/components/chat-screen";
import { Screen } from "@/components/screen";

export const metadata: Metadata = { title: "Conversation" };

export default function Chat() {
  return (
    <Screen>
      <ChatScreen />
    </Screen>
  );
}
