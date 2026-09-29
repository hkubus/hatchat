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
 *   3. Otherwise mount the chat state machine above a native stack navigator.
 *
 * The navigator is `react-native-screens`' native stack, i.e. a real
 * `UINavigationController`. That is what makes the chrome native rather than a
 * lookalike: large titles that collapse on scroll, the system search field,
 * edge-swipe back, `UIBarButtonItem`s with SF Symbols and pull-down menus, and —
 * built with the iOS 26 SDK — Liquid Glass bar buttons and the scroll-edge
 * effect, with no code here to draw any of it.
 *
 * The layout is the one Messages and Mail use on iPhone: a list of
 * conversations at the root, the conversation pushed on top, Settings and the
 * model picker presented as sheets.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, View } from "react-native";
import { DarkTheme, DefaultTheme, NavigationContainer } from "@react-navigation/native";
import type { Theme as NavigationTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { setUnauthorizedHandler } from "./src/api";
import { hasNativeGlass } from "./src/Glass";
import { ChatContext } from "./src/navigation";
import type { RootStackParamList } from "./src/navigation";
import type { HatConfig } from "./src/runtime";
import { clearConfig, loadConfig } from "./src/runtime";
import ChatScreen from "./src/screens/ChatScreen";
import ConnectScreen from "./src/screens/ConnectScreen";
import ModelScreen from "./src/screens/ModelScreen";
import SessionsScreen from "./src/screens/SessionsScreen";
import SettingsNavigator from "./src/screens/settings/SettingsNavigator";
import { useTheme } from "./src/theme";
import { useChat } from "./src/useChat";

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <Root />
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
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
    // screen is mounted.
    setUnauthorizedHandler(() => {
      void clearConfig().then(() => setGeneration((n) => n + 1));
    });
    return () => setUnauthorizedHandler(undefined);
  }, []);

  const disconnect = useCallback(async () => {
    await clearConfig();
    setGeneration((n) => n + 1);
  }, []);

  let body;
  if (!config) {
    body = (
      <View style={[styles.boot, { backgroundColor: theme.color.grouped }]}>
        <ActivityIndicator color={theme.color.textFaint} />
      </View>
    );
  } else if (!config.serverUrl) {
    body = <ConnectScreen onConnected={() => setGeneration((n) => n + 1)} />;
  } else {
    body = <Shell onDisconnect={disconnect} />;
  }

  // Every screen sets its own background, so the status bar has to follow the
  // appearance or the clock and battery are unreadable in one of the two modes.
  return (
    <>
      <StatusBar style={theme.dark ? "light" : "dark"} />
      {body}
    </>
  );
}

function Shell({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const theme = useTheme();
  const chat = useChat();

  const navigationTheme = useMemo<NavigationTheme>(() => {
    const base = theme.dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: theme.color.accent,
        background: theme.color.grouped,
        card: theme.color.bg,
        text: theme.color.text,
        border: theme.color.separator,
      },
    };
  }, [theme]);

  // On iOS the bar is transparent and the content scrolls underneath it. Below
  // iOS 26 the system blur gives the classic translucent bar; on iOS 26 the
  // system draws the scroll-edge effect itself, and a blur here would fight it.
  const translucent = Platform.OS === "ios";
  const barBlur = translucent && !hasNativeGlass() ? ("systemChromeMaterial" as const) : undefined;

  return (
    <ChatContext.Provider value={chat}>
      <NavigationContainer theme={navigationTheme}>
        <Stack.Navigator
          initialRouteName="Chats"
          screenOptions={{
            headerTransparent: translucent,
            headerBlurEffect: barBlur,
            headerShadowVisible: false,
            headerLargeTitleShadowVisible: false,
            headerBackButtonDisplayMode: "minimal",
            headerTintColor: theme.color.accent,
            contentStyle: { backgroundColor: theme.color.grouped },
          }}
        >
          <Stack.Screen
            name="Chats"
            component={SessionsScreen}
            options={{ title: "Chats", headerLargeTitle: true }}
          />
          <Stack.Screen
            name="Chat"
            component={ChatScreen}
            options={{ title: "", contentStyle: { backgroundColor: theme.color.bg } }}
          />
          <Stack.Screen
            name="Settings"
            options={{
              presentation: "pageSheet",
              // Settings is a stack of its own inside the sheet, so it can push
              // detail screens; that inner stack draws the bars.
              headerShown: false,
            }}
          >
            {() => <SettingsNavigator onDisconnect={onDisconnect} />}
          </Stack.Screen>
          <Stack.Screen
            name="Model"
            component={ModelScreen}
            options={{
              title: "Model",
              presentation: "pageSheet",
              headerTransparent: false,
              headerStyle: { backgroundColor: theme.color.grouped },
            }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </ChatContext.Provider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  boot: { flex: 1, alignItems: "center", justifyContent: "center" },
});
