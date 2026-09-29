/**
 * Conversation list.
 *
 * This is the same sidebar the app shell shows persistently: an iOS
 * inset-grouped list with search, in-place rename, and two-step delete. It is
 * kept as a screen so deep links and tests still have a stable entry point —
 * the shell itself renders `Sidebar` directly.
 */

import Sidebar from "../ui/Sidebar";
import type { ChatStore } from "../useChat";

export default function SessionsScreen({
  chat,
  onOpenChat,
}: {
  chat: ChatStore;
  onOpenChat: () => void;
}) {
  return (
    <Sidebar
      chat={chat}
      onSelect={onOpenChat}
      onNewChat={onOpenChat}
      onOpenSettings={() => undefined}
      settingsActive={false}
    />
  );
}
