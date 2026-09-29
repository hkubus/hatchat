/**
 * Settings: connection, provider keys, plugins, runners, and the tool policy.
 *
 * These are the same surfaces as the web app's Settings tab, reduced to what
 * makes sense on a phone. Everything here talks to the server — the app holds no
 * plugin logic, no provider state, and no secrets beyond the connection token.
 */

import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as api from "../api";
import type { PluginDescriptor, ProviderStatus, RunnerSummary } from "../api";
import { hasNativeGlass } from "../Glass";
import { currentConfig, saveConfig } from "../runtime";
import { useTheme } from "../theme";
import type { ChatStore } from "../useChat";
import { Badge, Banner, Button, Field, SectionHeader, Segmented, ToggleRow } from "../ui/controls";
import NavBar, { NavButton } from "../ui/NavBar";

const PLUGIN_STATUS = {
  active: { label: "active", tone: "good" as const },
  disabled: { label: "disabled", tone: "neutral" as const },
  "needs-config": { label: "needs config", tone: "warn" as const },
  error: { label: "error", tone: "bad" as const },
};

export default function SettingsScreen({
  chat,
  onDisconnect,
  onBack,
  showMenuButton,
  onMenu,
}: {
  chat: ChatStore;
  onDisconnect: () => Promise<void>;
  onBack: () => void;
  showMenuButton: boolean;
  onMenu: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  const [runners, setRunners] = useState<RunnerSummary[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [nextProviders, nextPlugins, nextRunners, nextTools] = await Promise.all([
        api.getProviders(),
        api.getPlugins(),
        api.getRunners(),
        // Tool names feed the allowlist suggestions; not worth failing the whole
        // screen if this one call does.
        api.getTools().catch(() => [] as string[]),
      ]);
      setProviders(nextProviders);
      setPlugins(nextPlugins);
      setRunners(nextRunners);
      setTools(nextTools);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function guard(run: () => Promise<unknown>, message: string): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await run();
      setNotice(message);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.color.grouped }]}>
      <NavBar
        title="Settings"
        leading={
          showMenuButton ? (
            <NavButton label="☰" accessibilityLabel="Open chats" onPress={onMenu} />
          ) : (
            <NavButton label="‹ Chats" accessibilityLabel="Back to chat" onPress={onBack} />
          )
        }
        trailing={
          showMenuButton ? (
            <NavButton label="Done" accessibilityLabel="Done" onPress={onBack} />
          ) : undefined
        }
      />
      <ScrollView
        style={{ backgroundColor: theme.color.grouped }}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Banner tone="error" title="Request failed" detail={error} /> : null}
        {notice ? <Banner tone="info" title={notice} onDismiss={() => setNotice(null)} /> : null}

        {/* --- tool policy ------------------------------------------------- */}
        <SectionHeader
          title="Tool policy"
          detail="How the agent is allowed to run tools in the current conversation."
        />
        <View style={[styles.card, { backgroundColor: theme.color.surface }]}>
          <Segmented
            value={chat.policyMode}
            onChange={chat.setPolicyMode}
            options={[
              { value: "ask", label: "ask" },
              { value: "auto", label: "auto" },
              { value: "allowlist", label: "allow" },
              { value: "deny", label: "deny" },
            ]}
          />
          {chat.policyMode === "allowlist" ? (
            <AllowlistEditor value={chat.allowedTools} onChange={chat.setAllowedTools} known={tools} />
          ) : null}
          <Text style={[styles.note, { color: theme.color.textFaint }]}>
            {POLICY_NOTES[chat.policyMode]}
          </Text>
        </View>

        {/* --- providers --------------------------------------------------- */}
        <SectionHeader
          title="Providers & API keys"
          detail="Keys are sent to the server and stored encrypted there. They never reach this device again."
        />
        {providers.length === 0 ? (
          <Text style={[styles.note, { color: theme.color.textFaint }]}>
            This server exposes no key-backed providers.
          </Text>
        ) : null}
        {providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            onSave={(value) =>
              guard(() => api.setSecret(provider.secretName, value), `${provider.label} key saved.`)
            }
            onClear={() =>
              guard(
                () => api.deleteSecret(provider.secretName),
                `${provider.label} key removed.`,
              )
            }
          />
        ))}

        {/* --- plugins ----------------------------------------------------- */}
        <SectionHeader
          title={`Plugins (${plugins.length})`}
          detail="Providers and tools are contributed by plugins on the server."
        />
        {plugins.map((plugin) => (
          <PluginRow
            key={plugin.id}
            plugin={plugin}
            onToggle={(enabled) =>
              guard(
                () => api.setPluginEnabled(plugin.id, enabled),
                `${plugin.name} ${enabled ? "enabled" : "disabled"}.`,
              )
            }
            onConfig={(config) =>
              guard(
                () => api.setPluginConfig(plugin.id, config),
                `${plugin.name} updated.`,
              )
            }
          />
        ))}

        {/* --- runners ----------------------------------------------------- */}
        <SectionHeader
          title={`Execution runners (${runners.length})`}
          detail="Work happens on a runner that dials out to the server. Secrets and approvals never leave it."
        />
        {runners.length === 0 ? (
          <Banner
            tone="warn"
            title="No runner connected"
            detail="Chat will work, but any tool call will fail until a runner is online."
          />
        ) : null}
        {runners.map((runner) => (
          <View
            key={runner.id}
            style={[styles.row, { backgroundColor: theme.color.surface }]}
          >
            <View style={styles.rowMain}>
              <Text style={[styles.rowTitle, { color: theme.color.text }]}>{runner.id}</Text>
              <Text style={[styles.note, { color: theme.color.textFaint }]}>
                {runner.capabilities.os}/{runner.capabilities.arch}
                {runner.capabilities.tags.length > 0 ? ` · ${runner.capabilities.tags.join(", ")}` : ""}
              </Text>
            </View>
            <Badge
              label={`${runner.load} busy`}
              tone={runner.load === 0 ? "good" : "warn"}
            />
          </View>
        ))}

        {/* --- connection -------------------------------------------------- */}
        <SectionHeader title="Connection" />
        <ConnectionCard onDisconnect={onDisconnect} />
      </ScrollView>
    </View>
  );
}

const POLICY_NOTES: Record<ChatStore["policyMode"], string> = {
  ask: "Tools that require approval pause the turn and wait for you.",
  auto: "Every tool runs without asking. Only do this for a runner you trust.",
  allowlist: "Only the tools listed below run unattended; everything else asks.",
  deny: "All tool execution is blocked. Useful for a pure chat conversation.",
};

function AllowlistEditor({
  value,
  onChange,
  known,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** Tool names the server reports, offered as one-tap suggestions. */
  known: string[];
}) {
  const theme = useTheme();
  const [text, setText] = useState(value.join(", "));
  useEffect(() => setText(value.join(", ")), [value]);

  const selected = new Set(value);

  const toggle = (name: string) => {
    onChange(selected.has(name) ? value.filter((v) => v !== name) : [...value, name]);
  };

  return (
    <View style={styles.block}>
      <Field
        label="Auto-approved tools"
        value={text}
        onChangeText={(next) => {
          setText(next);
          onChange(
            next
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }}
        placeholder="shell_exec, read_file"
        hint="Comma-separated, or tap below."
      />
      {known.length === 0 ? (
        <Text style={[styles.note, { color: theme.color.textFaint }]}>
          The server has no registered tools right now, so there is nothing to
          allowlist. Tool names can still be typed by hand.
        </Text>
      ) : (
        <View style={styles.chipRow}>
          {known.map((name) => (
            <Pressable
              key={name}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected.has(name) }}
              accessibilityLabel={name}
              onPress={() => toggle(name)}
              style={[
                styles.chip,
                {
                  backgroundColor: selected.has(name) ? theme.color.accent : theme.color.surfaceAlt,
                },
              ]}
            >
              <Text
                style={[
                  styles.chipLabel,
                  { color: selected.has(name) ? theme.color.accentText : theme.color.text },
                ]}
              >
                {name}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function ProviderRow({
  provider,
  onSave,
  onClear,
}: {
  provider: ProviderStatus;
  onSave: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const theme = useTheme();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <View
      style={[styles.row, { backgroundColor: theme.color.surface }]}
    >
      <View style={styles.rowMain}>
        <Text style={[styles.rowTitle, { color: theme.color.text }]}>{provider.label}</Text>
        <Text style={[styles.note, { color: theme.color.textFaint }]}>
          {provider.secretName} · {provider.registered ? "registered" : "not registered"}
        </Text>
      </View>
      <View style={styles.rowSide}>
        <Badge
          label={provider.configured ? "key set" : "no key"}
          tone={provider.configured ? "good" : "warn"}
        />
        {provider.configured ? (
          <Button
            label="Remove"
            compact
            variant="danger"
            onPress={() => void onClear()}
          />
        ) : null}
      </View>
      <Field
        label={provider.configured ? "Replace key" : "Set key"}
        value={value}
        onChangeText={setValue}
        secureTextEntry
        placeholder={provider.secretName}
      />
      <Button
        label="Save key"
        variant="primary"
        loading={busy}
        disabled={!value.trim()}
        onPress={() => {
          setBusy(true);
          void onSave(value.trim())
            .then(() => setValue(""))
            .finally(() => setBusy(false));
        }}
      />
    </View>
  );
}

function PluginRow({
  plugin,
  onToggle,
  onConfig,
}: {
  plugin: PluginDescriptor;
  onToggle: (enabled: boolean) => Promise<void>;
  onConfig: (config: Record<string, unknown>) => Promise<void>;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const status = PLUGIN_STATUS[plugin.status];

  return (
    <View
      style={[styles.row, { backgroundColor: theme.color.surface }]}
    >
      <ToggleRow
        label={plugin.name}
        detail={`${plugin.id} v${plugin.version} · ${plugin.source}`}
        value={plugin.enabled}
        onValueChange={(next) => void onToggle(next)}
      />
      <View style={styles.rowSide}>
        <Badge label={status.label} tone={status.tone} />
      </View>
      {plugin.error ? (
        <Text style={[styles.note, { color: theme.color.danger }]}>{plugin.error}</Text>
      ) : null}

      {plugin.configSchema?.properties ? (
        <>
          <Button
            label={expanded ? "Hide configuration" : "Configure"}
            compact
            onPress={() => setExpanded((v) => !v)}
          />
          {expanded
            ? Object.entries(plugin.configSchema.properties).map(([key, property]) => (
                <PluginField
                  key={key}
                  name={key}
                  property={property}
                  value={plugin.config[key]}
                  onSave={async (next) => {
                    await onConfig({ ...plugin.config, [key]: next });
                  }}
                />
              ))
            : null}
        </>
      ) : null}
    </View>
  );
}

/**
 * One field of a plugin's JSON Schema.
 *
 * Only the shapes the schema-to-form conversion in the kernel actually emits are
 * handled: string, number, boolean, and enum. Anything else is shown read-only
 * rather than guessed at, because writing a wrong value into a plugin's config
 * is worse than not offering the field.
 */
function PluginField({
  name,
  property,
  value,
  onSave,
}: {
  name: string;
  property: { type?: string; description?: string; enum?: unknown[]; default?: unknown };
  value: unknown;
  onSave: (next: unknown) => Promise<void>;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [busy, setBusy] = useState(false);
  const theme = useTheme();

  if (property.enum) {
    return (
      <Segmented
        label={name}
        value={String(value ?? property.default ?? "")}
        onChange={(next) => void onSave(next)}
        options={property.enum.map((option) => ({ value: String(option), label: String(option) }))}
      />
    );
  }

  if (property.type === "boolean") {
    return (
      <ToggleRow
        label={name}
        detail={property.description}
        value={value === undefined ? Boolean(property.default) : Boolean(value)}
        onValueChange={(next) => void onSave(next)}
      />
    );
  }

  if (property.type !== "string" && property.type !== "number" && property.type !== "integer") {
    // No editor for shapes the schema-to-form conversion does not emit (objects,
    // arrays). Writing a guessed value into a plugin's config is worse than not
    // offering the field at all.
    return (
      <Text style={[styles.note, { color: theme.color.textFaint }]}>
        {name}: edit this on the server (unsupported field type “{property.type}”).
      </Text>
    );
  }

  const numeric = property.type !== "string";

  return (
    <View style={styles.block}>
      <Field
        label={name}
        value={text}
        onChangeText={setText}
        hint={property.description}
        keyboardType={numeric ? "numeric" : "default"}
      />
      <Button
        label="Save"
        compact
        variant="primary"
        loading={busy}
        // A number field that has not been touched must not write "0" over a
        // value the server already has.
        disabled={!text.trim() || text === String(value ?? "")}
        onPress={() => {
          setBusy(true);
          void onSave(numeric ? Number(text) : text)
            .then(() => undefined)
            .finally(() => setBusy(false));
        }}
      />
    </View>
  );
}

function ConnectionCard({ onDisconnect }: { onDisconnect: () => Promise<void> }) {
  const theme = useTheme();
  const [serverUrl, setServerUrl] = useState(currentConfig().serverUrl);
  const [token, setToken] = useState(currentConfig().token);
  const [busy, setBusy] = useState(false);

  return (
    <View
      style={[styles.row, { backgroundColor: theme.color.surface }]}
    >
      <Field label="Server URL" value={serverUrl} onChangeText={setServerUrl} keyboardType="url" />
      <Field
        label="Access token"
        value={token}
        onChangeText={setToken}
        secureTextEntry
        hint="Stored in the iOS keychain."
      />
      <Button
        label="Save connection"
        variant="primary"
        loading={busy}
        onPress={() => {
          setBusy(true);
          void saveConfig({ serverUrl, token }).finally(() => setBusy(false));
        }}
      />
      <Text style={[styles.note, { color: theme.color.textFaint }]}>
        Chrome:{" "}
        {hasNativeGlass()
          ? "native Liquid Glass (UIGlassEffect)."
          : "expo-blur material — the local Liquid Glass module is not in this build."}
      </Text>
      <Button label="Disconnect" variant="danger" onPress={() => void onDisconnect()} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 16, gap: 4 },
  card: { borderRadius: 12, padding: 14, gap: 12 },
  block: { gap: 10 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    minHeight: 32,
    paddingHorizontal: 14,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  chipLabel: { fontSize: 14, fontWeight: "600" },
  row: { borderRadius: 12, padding: 14, gap: 12, marginTop: 8 },
  rowMain: { gap: 2 },
  rowSide: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  rowTitle: { fontSize: 17, fontWeight: "600", letterSpacing: -0.2 },
  note: { fontSize: 13, lineHeight: 18 },
});
