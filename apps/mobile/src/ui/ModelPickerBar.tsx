/**
 * Model selection for the composer.
 *
 * The web app renders a popover grouped by provider with favourite toggles. A
 * phone has no hover and no room for a popover, so this is a modal sheet with
 * the same grouping and search — the grouping is the part that matters, because
 * the model ids are `provider/model` and an ungrouped flat list of several
 * hundred OpenRouter entries is unusable.
 */

import { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ModelInfo } from "@hat/core";
import { capTags } from "../capTags";
import { useTheme } from "../theme";
import { Badge, Button } from "./controls";

export default function ModelPickerBar({
  models,
  value,
  onChange,
}: {
  models: ModelInfo[];
  value: string;
  onChange: (next: string) => void;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const current = models.find((m) => m.id === value);

  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? models.filter(
          (m) =>
            m.id.toLowerCase().includes(needle) ||
            m.label.toLowerCase().includes(needle) ||
            m.provider.toLowerCase().includes(needle),
        )
      : models;

    const byProvider = new Map<string, ModelInfo[]>();
    for (const model of filtered) {
      const bucket = byProvider.get(model.provider);
      if (bucket) bucket.push(model);
      else byProvider.set(model.provider, [model]);
    }
    return [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models, query]);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Choose a model"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.trigger,
          { backgroundColor: theme.color.surfaceAlt, borderColor: theme.color.border },
          pressed && { opacity: 0.6 },
        ]}
      >
        <Text style={[styles.triggerText, { color: theme.color.text }]} numberOfLines={1}>
          {current?.label ?? value ?? "model"}
        </Text>
        <Text style={[styles.caret, { color: theme.color.textDim }]}>▾</Text>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <ModelSheet
          grouped={grouped}
          query={query}
          onQueryChange={setQuery}
          value={value}
          onPick={(id) => {
            onChange(id);
            setOpen(false);
            setQuery("");
          }}
          onClose={() => setOpen(false)}
        />
      </Modal>
    </>
  );
}

function ModelSheet({
  grouped,
  query,
  onQueryChange,
  value,
  onPick,
  onClose,
}: {
  grouped: [string, ModelInfo[]][];
  query: string;
  onQueryChange: (next: string) => void;
  value: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.sheet, { backgroundColor: theme.color.bg }]}>
      <View style={[styles.sheetHead, { borderBottomColor: theme.color.hairline }]}>
        <Text style={[styles.sheetTitle, { color: theme.color.text }]}>Model</Text>
        <Button label="Done" compact onPress={onClose} />
      </View>

      <TextInput
        value={query}
        onChangeText={onQueryChange}
        placeholder="Search models"
        placeholderTextColor={theme.color.textFaint}
        autoCapitalize="none"
        style={[
          styles.search,
          { color: theme.color.text, backgroundColor: theme.color.surface },
        ]}
      />

      <ScrollView contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 16 }]}>
        {grouped.length === 0 ? (
          <Text style={[styles.empty, { color: theme.color.textFaint }]}>
            No model matches “{query}”.
          </Text>
        ) : null}

        {grouped.map(([provider, providerModels]) => (
          <View key={provider} style={styles.group}>
            <Text style={[styles.groupTitle, { color: theme.color.textDim }]}>{provider}</Text>
            {providerModels.map((model) => {
              const selected = model.id === value;
              return (
                <Pressable
                  key={model.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => onPick(model.id)}
                  style={({ pressed }) => [
                    styles.item,
                    {
                      backgroundColor: selected ? theme.color.surfaceAlt : theme.color.surface,
                      borderColor: selected ? theme.color.accent : theme.color.border,
                    },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <View style={styles.itemHead}>
                    <Text
                      style={[styles.itemLabel, { color: theme.color.text }]}
                      numberOfLines={1}
                    >
                      {model.label}
                    </Text>
                    {selected ? (
                      <Text style={[styles.check, { color: theme.color.accent }]}>✓</Text>
                    ) : null}
                  </View>
                  <View style={styles.tags}>
                    {capTags(model.capabilities, model.contextWindow).map((tag) => (
                      <Badge key={tag.key} label={tag.label} title={tag.title} />
                    ))}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    maxWidth: 220,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  triggerText: { fontSize: 14, fontWeight: "600", flexShrink: 1 },
  caret: { fontSize: 11 },
  sheet: { flex: 1 },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: { fontSize: 20, fontWeight: "700" },
  search: {
    margin: 16,
    marginBottom: 0,
    minHeight: 44,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  list: { padding: 16, gap: 20 },
  empty: { fontSize: 15, textAlign: "center", paddingVertical: 32 },
  group: { gap: 8 },
  groupTitle: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  item: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  itemHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  itemLabel: { fontSize: 16, fontWeight: "600", flexShrink: 1 },
  check: { fontSize: 16, fontWeight: "700" },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
