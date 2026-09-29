/**
 * Settings root: what the current conversation may do, and what the server
 * behind it offers.
 *
 * These are the same surfaces as the web app's Settings tab, laid out the way
 * the iOS Settings app is: one grouped list of summaries, each row pushing the
 * screen that edits it. Everything here talks to the server — the app holds no
 * plugin logic, no provider state, and no secrets beyond the connection token.
 */

import type { ReasoningEffort } from "@hat/core";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ApprovalMode } from "../../api";
import { hasNativeGlass } from "../../Glass";
import { useChatStore } from "../../navigation";
import { currentConfig } from "../../runtime";
import { Badge } from "../../ui/controls";
import { ListRow, ListSection } from "../../ui/List";
import { Chevron, confirmDestructive, Notices, PickerRow, SettingsScroll, TILE } from "./shared";
import type { PickerOption } from "./shared";
import type { SettingsScreenProps } from "./types";
import { useServerData } from "./useServerData";

const EFFORTS: PickerOption<ReasoningEffort>[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const POLICIES: PickerOption<ApprovalMode>[] = [
  { value: "ask", label: "Ask", subtitle: "Tools that need approval wait for you" },
  { value: "auto", label: "Auto", subtitle: "Every tool runs without asking" },
  { value: "allowlist", label: "Allowlist", subtitle: "Allowed tools run; the rest ask" },
  { value: "deny", label: "Deny", subtitle: "All tool execution is blocked" },
];

const POLICY_NOTES: Record<ApprovalMode, string> = {
  ask: "Tools that require approval pause the turn and wait for you.",
  auto: "Every tool runs without asking. Only do this for a runner you trust.",
  allowlist: "Only the allowed tools run unattended; everything else asks.",
  deny: "All tool execution is blocked. Useful for a pure chat conversation.",
};

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//i, "") || "Not set";
}

export default function SettingsHomeScreen({
  navigation,
  onDisconnect,
}: SettingsScreenProps<"SettingsHome"> & { onDisconnect: () => Promise<void> }) {
  const chat = useChatStore();
  const { data, error } = useServerData("overview");
  const [host, setHost] = useState(() => hostOf(currentConfig().serverUrl));

  // The Connection screen may have changed the server while pushed.
  useFocusEffect(
    useCallback(() => {
      setHost(hostOf(currentConfig().serverUrl));
    }, []),
  );

  const reasoning = chat.selectedModel?.capabilities.reasoningEffort;
  const conversationFooter = [
    reasoning ? "Reasoning sets how long the current model thinks before answering." : null,
    POLICY_NOTES[chat.policyMode],
    "These settings apply to the current conversation.",
  ]
    .filter(Boolean)
    .join(" ");

  const providersSet = data?.providers.filter((p) => p.configured).length ?? 0;
  const pluginIssues =
    data?.plugins.filter((p) => p.status === "error" || p.status === "needs-config").length ?? 0;
  const runnersOnline = data?.runners.length ?? 0;

  return (
    <SettingsScroll>
      <Notices error={error} errorTitle="Could not load settings" />

      <ListSection header="Conversation" footer={conversationFooter}>
        {reasoning ? (
          <PickerRow
            title="Reasoning"
            icon="brain"
            iconColor={TILE.indigo}
            value={chat.reasoningEffort}
            options={EFFORTS}
            onChange={chat.setEffort}
          />
        ) : null}
        <PickerRow
          title="Tool Approval"
          icon="hand.raised.fill"
          iconColor={TILE.blue}
          value={chat.policyMode}
          options={POLICIES}
          onChange={chat.setPolicyMode}
        />
        {chat.policyMode === "allowlist" ? (
          <ListRow
            title="Allowed Tools"
            icon="checklist"
            iconColor={TILE.teal}
            value={String(chat.allowedTools.length)}
            accessory="chevron"
            onPress={() => navigation.navigate("Allowlist")}
          />
        ) : null}
      </ListSection>

      <ListSection header="Server">
        <ListRow
          title="Providers"
          icon="key.fill"
          iconColor={TILE.orange}
          value={data ? `${providersSet} of ${data.providers.length} set` : undefined}
          accessory="chevron"
          onPress={() => navigation.navigate("Providers")}
        />
        <ListRow
          title="Plugins"
          icon="puzzlepiece.extension.fill"
          iconColor={TILE.purple}
          value={data ? String(data.plugins.length) : undefined}
          accessory={
            pluginIssues > 0 ? (
              <View style={styles.trailing}>
                <Badge
                  label={pluginIssues === 1 ? "1 issue" : `${pluginIssues} issues`}
                  tone="warn"
                  title="Plugins with an error or missing configuration"
                />
                <Chevron />
              </View>
            ) : (
              "chevron"
            )
          }
          onPress={() => navigation.navigate("Plugins")}
        />
        <ListRow
          title="Runners"
          subtitle={data && runnersOnline === 0 ? "None connected — tools will fail" : undefined}
          icon="server.rack"
          iconColor={TILE.green}
          value={data ? `${runnersOnline} online` : undefined}
          accessory="chevron"
          onPress={() => navigation.navigate("Runners")}
        />
      </ListSection>

      <ListSection
        header="Connection"
        footer={
          hasNativeGlass()
            ? undefined
            : "Liquid Glass needs iOS 26 and a native build; until then the chrome uses a material blur."
        }
      >
        <ListRow
          title="Server"
          icon="network"
          iconColor={TILE.blue}
          value={host}
          accessory="chevron"
          onPress={() => navigation.navigate("Connection")}
        />
        <ListRow
          title="Chrome"
          icon="sparkles"
          iconColor={TILE.gray}
          value={hasNativeGlass() ? "Liquid Glass" : "Material Blur"}
        />
      </ListSection>

      <ListSection>
        <ListRow
          title="Disconnect"
          destructive
          onPress={() =>
            confirmDestructive({
              title: "Disconnect from this server?",
              message: "To reconnect you will need the server URL and its access token again.",
              action: "Disconnect",
              onConfirm: () => void onDisconnect(),
            })
          }
        />
      </ListSection>
    </SettingsScroll>
  );
}

const styles = StyleSheet.create({
  trailing: { flexDirection: "row", alignItems: "center", gap: 8 },
});
