/**
 * App shell.
 *
 * Three gates before any chat state exists:
 *
 *   1. Read the connection config from the keychain. Until it resolves, render
 *      nothing — booting the chat state against an empty server URL would fire
 *      a burst of requests at "" and surface as a confusing error.
 *   2. With no server URL, the user has never connected: show the connect
 *      screen. This is the same gate the desktop shell uses, and for the same
 *      reason — the app is a thin client that has to be pointed at a server.
 *   3. Otherwise mount the chat state machine and the three tabs.
 *
 * The tab bar is drawn in JS rather than using a native tab controller. That is
 * the one place this app knowingly gives up automatic iOS 26 glass: a native
 * `UITabBarController` gets the Liquid Glass treatment from the system for
 * free, and moving this onto Expo Router's native tabs is the follow-up noted
 * in docs/ios-app.md. The `Glass` wrapper is used here so the bar still picks
 * up the real material wherever it does exist.
 */

import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { setUnauthorizedHandler } from "./src/api";
import { Glass } from "./src/Glass";
import type { HatConfig } from "./src/runtime";
import { clearConfig, loadConfig } from "./src/runtime";
import ChatScreen from "./src/screens/ChatScreen";
import ConnectScreen from "./src/screens/ConnectScreen";
import SessionsScreen from "./src/screens/SessionsScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import { useTheme } from "./src/theme";
import { useChat } from "./src/useChat";

type Tab = "chat" | "sessions" | "settings";

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: "chat", label: "Chat", glyph: "💬" },
  { id: "sessions", label: "Chats", glyph: "🗂" },
  { id: "settings", label: "Settings", glyph: "⚙︎" },
];

export default function App() {
  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const theme = useTheme();
  const [config, setConfig] = useState<HatConfig | null>(null);
  // Bumped to re-read the keychain after the config is cleared underneath us.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    void loadConfig().then(setConfig);
  }, [generation]);

  useEffect(() => {
    // A 401 anywhere means the stored token stopped being accepted — the
    // server's `HAT_AUTH_TOKEN` was rotated. Dropping the config returns the
    // user to the connect screen instead of letting every screen fail on its
    // own. Registered here, above the chat state, so it fires no matter which
    // tab is mounted.
    setUnauthorizedHandler(() => {
      void clearConfig().then(() => setGeneration((n) => n + 1));
    });
    return () => setUnauthorizedHandler(undefined);
  }, []);

  const disconnect = useCallback(async () => {
    await clearConfig();
    setGeneration((n) => n + 1);
  }, []);

  // Every screen sets its own background, so the status bar has to follow the
  // appearance or the clock and battery are unreadable in one of the two modes.
  return (
    <>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      <RootBody config={config} onDisconnect={disconnect} setGeneration={setGeneration} />
    </>
  );
}

function RootBody({
  config,
  onDisconnect,
  setGeneration,
}: {
  config: HatConfig | null;
  onDisconnect: () => Promise<void>;
  setGeneration: (updater: (n: number) => number) => void;
}) {
  const theme = useTheme();

  if (!config) {
    return (
      <View style={[styles.boot, { backgroundColor: theme.color.bg }]}>
        <ActivityIndicator color={theme.color.textFaint} />
      </View>
    );
  }

  if (!config.serverUrl) {
    return <ConnectScreen onConnected={() => setGeneration((n) => n + 1)} />;
  }

  return <Shell onDisconnect={onDisconnect} />;
}

function Shell({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const theme = useTheme();
  const chat = useChat();
  const [tab, setTab] = useState<Tab>("chat");

  const openChat = useCallback(() => setTab("chat"), []);

  return (
    <View style={[styles.root, { backgroundColor: theme.color.bg }]}>
      <SafeAreaView style={styles.body} edges={["top", "left", "right"]}>
        {tab === "chat" ? <ChatScreen chat={chat} /> : null}
        {tab === "sessions" ? <SessionsScreen chat={chat} onOpenChat={openChat} /> : null}
        {tab === "settings" ? <SettingsScreen chat={chat} onDisconnect={onDisconnect} /> : null}
      </SafeAreaView>

      <Glass style={[styles.tabBar, { borderTopColor: theme.color.hairline }]} intensity={70}>
        {TABS.map((item) => {
          const selected = item.id === tab;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={item.label}
              onPress={() => setTab(item.id)}
              style={styles.tab}
            >
              <Text style={[styles.glyph, selected && styles.glyphSelected]}>{item.glyph}</Text>
              <Text
                style={[
                  styles.tabLabel,
                  { color: selected ? theme.color.accent : theme.color.textFaint },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: "center", justifyContent: "center" },
  root: { flex: 1 },
  body: { flex: 1 },
  tabBar: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingTop: 10,
    paddingBottom: 6,
    minHeight: 52,
  },
  glyph: { fontSize: 20, opacity: 0.55 },
  glyphSelected: { opacity: 1 },
  tabLabel: { fontSize: 11, fontWeight: "600" },
});
