/**
 * The Settings sheet: a navigation stack of its own, as in the iOS Settings
 * app, where a grouped list of summaries pushes the screen that edits each one.
 *
 * It is nested inside the root stack's page-sheet "Settings" route, so pushes
 * stay inside the sheet and "Done" dismisses the whole sheet through the parent
 * navigator. The bars are opaque and the same grey as the grouped background,
 * so, as in Settings, the bar and the list read as one surface.
 */

import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useTheme } from "../../theme";
import { barItems } from "../../ui/barItems";
import { ConversationForm } from "../ConversationScreen";
import AllowlistScreen from "./AllowlistScreen";
import ConnectionScreen from "./ConnectionScreen";
import PluginScreen from "./PluginScreen";
import PluginsScreen from "./PluginsScreen";
import ProviderScreen from "./ProviderScreen";
import ProvidersScreen from "./ProvidersScreen";
import RunnersScreen from "./RunnersScreen";
import SettingsHomeScreen from "./SettingsHomeScreen";
import type { SettingsStackParamList } from "./types";

const Stack = createNativeStackNavigator<SettingsStackParamList>();

export default function SettingsNavigator({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const theme = useTheme();

  return (
    <Stack.Navigator
      initialRouteName="SettingsHome"
      screenOptions={{
        headerTransparent: false,
        headerStyle: { backgroundColor: theme.color.grouped },
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerTintColor: theme.color.accent,
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: theme.color.grouped },
      }}
    >
      <Stack.Screen
        name="SettingsHome"
        options={({ navigation }) => ({
          title: "Settings",
          headerLargeTitle: true,
          ...barItems("right", [
            {
              kind: "button",
              label: "Done",
              variant: "done",
              onPress: () => navigation.getParent()?.goBack(),
            },
          ]),
        })}
      >
        {(props) => <SettingsHomeScreen {...props} onDisconnect={onDisconnect} />}
      </Stack.Screen>
      <Stack.Screen name="Providers" component={ProvidersScreen} options={{ title: "Providers" }} />
      {/* Titled with the provider's or plugin's name once it has loaded. */}
      <Stack.Screen name="Provider" component={ProviderScreen} options={{ title: "" }} />
      <Stack.Screen name="Plugins" component={PluginsScreen} options={{ title: "Plugins" }} />
      <Stack.Screen name="Plugin" component={PluginScreen} options={{ title: "" }} />
      <Stack.Screen name="Runners" component={RunnersScreen} options={{ title: "Runners" }} />
      <Stack.Screen name="Allowlist" component={AllowlistScreen} options={{ title: "Allowed Tools" }} />
      <Stack.Screen name="Conversation" options={{ title: "Instructions & Sampling" }}>
        {({ navigation }) => <ConversationForm navigation={navigation} sheet={false} />}
      </Stack.Screen>
      <Stack.Screen name="Connection" component={ConnectionScreen} options={{ title: "Server" }} />
    </Stack.Navigator>
  );
}
