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
 *   3. Otherwise mount the chat state machine inside an iOS-native split
 *      shell: chats live in a sidebar (persistent split on wide windows,
 *      slide-over drawer on iPhone), the detail is Chat or Settings under an
 *      iOS navigation bar. There is no bottom tab bar — navigation is the
 *      sidebar plus the bar, as in Mail and Settings.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { setUnauthorizedHandler } from "./src/api";
import type { HatConfig } from "./src/runtime";
import { clearConfig, loadConfig } from "./src/runtime";
import ChatScreen from "./src/screens/ChatScreen";
import ConnectScreen from "./src/screens/ConnectScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import { useTheme } from "./src/theme";
import Sidebar from "./src/ui/Sidebar";
import { useChat } from "./src/useChat";

type Route = "chat" | "settings";

const SIDEBAR_WIDTH = 320;

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
    // route is mounted.
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
  const { width } = useWindowDimensions();
  const isWide = width >= 768;

  const [route, setRoute] = useState<Route>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Drawer animation (narrow only): slide the panel in, fade the scrim.
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(slide, {
      toValue: sidebarOpen && !isWide ? 1 : 0,
      duration: 240,
      useNativeDriver: true,
    }).start();
  }, [sidebarOpen, isWide, slide]);

  const drawerWidth = Math.min(SIDEBAR_WIDTH, width * 0.85);
  const translateX = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [-drawerWidth - 16, 0],
  });
  const scrimOpacity = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.35],
  });

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const openSidebar = useCallback(() => setSidebarOpen(true), []);

  const goChat = useCallback(() => {
    setRoute("chat");
    setSidebarOpen(false);
  }, []);

  const goSettings = useCallback(() => {
    setRoute("settings");
    setSidebarOpen(false);
  }, []);

  const sidebar = (
    <Sidebar
      chat={chat}
      onSelect={goChat}
      onNewChat={goChat}
      onOpenSettings={goSettings}
      settingsActive={route === "settings"}
    />
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.color.bg }]}>
      {isWide ? (
        <View style={styles.split}>
          <SafeAreaView
            edges={["top", "left", "bottom"]}
            style={[styles.sidebarPane, { borderRightColor: theme.color.hairline }]}
          >
            {sidebar}
          </SafeAreaView>
          <View style={styles.detail}>
            {route === "chat" ? (
              <ChatScreen chat={chat} showMenuButton={false} onMenu={openSidebar} onNewChat={goChat} />
            ) : (
              <SettingsScreen
                chat={chat}
                onDisconnect={onDisconnect}
                onBack={goChat}
                showMenuButton={false}
                onMenu={openSidebar}
              />
            )}
          </View>
        </View>
      ) : (
        <View style={styles.detail}>
          {route === "chat" ? (
            <ChatScreen chat={chat} showMenuButton onMenu={openSidebar} onNewChat={goChat} />
          ) : (
            <SettingsScreen
              chat={chat}
              onDisconnect={onDisconnect}
              onBack={goChat}
              showMenuButton
              onMenu={openSidebar}
            />
          )}

          {/* Slide-over drawer + scrim. Kept mounted so the close animates;
              pointer events only while open. */}
          <Animated.View
            style={[styles.scrim, { opacity: scrimOpacity }]}
            pointerEvents={sidebarOpen ? "auto" : "none"}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close chats"
              onPress={closeSidebar}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
          <Animated.View
            style={[
              styles.drawer,
              {
                width: drawerWidth,
                transform: [{ translateX }],
                borderRightColor: theme.color.hairline,
                backgroundColor: theme.color.grouped,
              },
            ]}
          >
            <SafeAreaView edges={["top", "left", "bottom"]} style={styles.drawerSafe}>
              {sidebar}
            </SafeAreaView>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: "center", justifyContent: "center" },
  root: { flex: 1 },
  split: { flex: 1, flexDirection: "row" },
  sidebarPane: { width: SIDEBAR_WIDTH, borderRightWidth: StyleSheet.hairlineWidth },
  detail: { flex: 1 },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000",
  },
  drawer: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    borderRightWidth: StyleSheet.hairlineWidth,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 16,
    shadowOffset: { width: 4, height: 0 },
    elevation: 8,
  },
  drawerSafe: { flex: 1 },
});
