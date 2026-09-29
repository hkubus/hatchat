/**
 * Navigation types and the chat-store context shared by every screen.
 *
 * The chat state machine is mounted once, above the navigator, so pushing and
 * popping screens never tears down a stream in flight. Screens reach it through
 * context instead of route params, which have to be serialisable.
 */

import { createContext, useContext } from "react";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { ChatStore } from "./useChat";

export type RootStackParamList = {
  Chats: undefined;
  Chat: undefined;
  Settings: undefined;
  Model: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;

export const ChatContext = createContext<ChatStore | null>(null);

export function useChatStore(): ChatStore {
  const chat = useContext(ChatContext);
  if (!chat) throw new Error("useChatStore must be used inside the connected shell");
  return chat;
}
