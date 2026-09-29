/**
 * Plugins installed on the server, each with its on/off switch.
 *
 * Providers and tools are contributed by plugins, so this is where a missing
 * provider or tool is usually explained. Only plugins that declare a config
 * schema push a detail screen; the rest have nothing more to show.
 */

import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as api from "../../api";
import type { PluginDescriptor } from "../../api";
import { useTheme } from "../../theme";
import { ListRow, ListSection } from "../../ui/List";
import { Notices, SectionBanner, SettingSwitch, SettingsScroll } from "./shared";
import type { SettingsScreenProps } from "./types";
import { useServerData } from "./useServerData";

export default function PluginsScreen({ navigation }: SettingsScreenProps<"Plugins">) {
  const theme = useTheme();
  const { data: plugins, error, notice, dismissNotice, guard } = useServerData("plugins");
  // A controlled Switch snaps back until the refetch lands; hold the new value
  // while the request is in flight.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const toggle = async (plugin: PluginDescriptor, enabled: boolean) => {
    setPending((prev) => ({ ...prev, [plugin.id]: enabled }));
    await guard(
      () => api.setPluginEnabled(plugin.id, enabled),
      `${plugin.name} ${enabled ? "enabled" : "disabled"}.`,
    );
    setPending(({ [plugin.id]: _, ...rest }) => rest);
  };

  const statusText = (plugin: PluginDescriptor) =>
    plugin.status === "error" ? (
      <Text style={[styles.status, { color: theme.color.danger }]}>Error</Text>
    ) : plugin.status === "needs-config" ? (
      <Text style={[styles.status, { color: theme.color.warn }]}>Needs Config</Text>
    ) : null;

  const failed = plugins?.filter((p) => p.error) ?? [];

  return (
    <SettingsScroll>
      <Notices error={error} notice={notice} onDismissNotice={dismissNotice} />
      {plugins?.length === 0 ? (
        <SectionBanner tone="info" title="This server has no plugins installed." />
      ) : null}
      {plugins && plugins.length > 0 ? (
        <ListSection footer="Providers and tools are contributed by plugins on the server.">
          {plugins.map((plugin) => {
            const configurable = Boolean(plugin.configSchema?.properties);
            return (
              <ListRow
                key={plugin.id}
                title={plugin.name}
                subtitle={`${plugin.id} v${plugin.version} · ${plugin.source}`}
                accessory={
                  <View style={styles.trailing}>
                    {statusText(plugin)}
                    <SettingSwitch
                      value={pending[plugin.id] ?? plugin.enabled}
                      onValueChange={(next) => void toggle(plugin, next)}
                    />
                  </View>
                }
                onPress={
                  configurable
                    ? () => navigation.navigate("Plugin", { pluginId: plugin.id })
                    : undefined
                }
              />
            );
          })}
        </ListSection>
      ) : null}
      {/* Configurable plugins show their error on their own screen too; the
          others have no screen, so this is the only place it appears. */}
      {failed.map((plugin) => (
        <SectionBanner key={plugin.id} tone="error" title={plugin.name} detail={plugin.error} />
      ))}
    </SettingsScroll>
  );
}

const styles = StyleSheet.create({
  trailing: { flexDirection: "row", alignItems: "center", gap: 8 },
  status: { fontSize: 13, fontWeight: "600" },
});
