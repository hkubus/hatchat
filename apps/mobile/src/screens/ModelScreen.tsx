/**
 * Model selection, presented as a native page sheet.
 *
 * The web app renders a popover grouped by provider. A phone has no hover and
 * no room for a popover, so this is a sheet with the same grouping and the
 * system search field — the grouping is the part that matters, because the
 * model ids are `provider/model` and an ungrouped flat list of several hundred
 * OpenRouter entries is unusable.
 */

import { useLayoutEffect, useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import type { ModelInfo } from "@hat/core";
import { capTags } from "../capTags";
import * as haptics from "../haptics";
import { useChatStore } from "../navigation";
import type { ScreenProps } from "../navigation";
import { useTheme } from "../theme";
import { barItems } from "../ui/barItems";
import { Badge, Empty, SECTION_RADIUS } from "../ui/controls";
import Icon from "../ui/Icon";

export default function ModelScreen({ navigation }: ScreenProps<"Model">) {
  const theme = useTheme();
  const chat = useChatStore();
  const [query, setQuery] = useState("");

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: "Search Models",
        autoCapitalize: "none",
        hideWhenScrolling: false,
        onChangeText: (event) => setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
      },
      ...barItems("right", [
        { kind: "button", label: "Done", variant: "done", onPress: () => navigation.goBack() },
      ]),
    });
  }, [navigation]);

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? chat.models.filter(
          (m) =>
            m.id.toLowerCase().includes(needle) ||
            m.label.toLowerCase().includes(needle) ||
            m.provider.toLowerCase().includes(needle),
        )
      : chat.models;

    const byProvider = new Map<string, ModelInfo[]>();
    for (const model of filtered) {
      const bucket = byProvider.get(model.provider);
      if (bucket) bucket.push(model);
      else byProvider.set(model.provider, [model]);
    }
    return [...byProvider.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, data]) => ({ title, data }));
  }, [chat.models, query]);

  return (
    <SectionList
      style={{ backgroundColor: theme.color.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.list}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      stickySectionHeadersEnabled={false}
      sections={sections}
      keyExtractor={(model) => model.id}
      renderSectionHeader={({ section }) => (
        <Text style={[styles.sectionTitle, { color: theme.color.textDim }]}>
          {section.title.toUpperCase()}
        </Text>
      )}
      renderItem={({ item: model, index, section }) => {
        const selected = model.id === chat.model;
        const first = index === 0;
        const last = index === section.data.length - 1;
        const tags = capTags(model.capabilities, model.contextWindow);
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={model.label}
            onPress={() => {
              haptics.selection();
              chat.setModel(model.id);
              navigation.goBack();
            }}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? theme.color.fill : theme.color.surface },
              first && { borderTopLeftRadius: SECTION_RADIUS, borderTopRightRadius: SECTION_RADIUS },
              last && { borderBottomLeftRadius: SECTION_RADIUS, borderBottomRightRadius: SECTION_RADIUS },
            ]}
          >
            <View style={styles.rowBody}>
              <View style={styles.rowMain}>
                <Text style={[styles.label, { color: theme.color.text }]} numberOfLines={1}>
                  {model.label}
                </Text>
                {tags.length > 0 ? (
                  <View style={styles.tags}>
                    {tags.map((tag) => (
                      <Badge key={tag.key} label={tag.label} title={tag.title} />
                    ))}
                  </View>
                ) : null}
              </View>
              {selected ? (
                <Icon name="checkmark" size={17} weight="semibold" color={theme.color.accent} />
              ) : null}
            </View>
            {!last ? (
              <View style={[styles.separator, { backgroundColor: theme.color.separator }]} />
            ) : null}
          </Pressable>
        );
      }}
      ListEmptyComponent={
        <Empty
          title={query ? "No Results" : "No Models"}
          detail={query ? `No model matches “${query}”.` : "This server reports no models."}
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "500",
    letterSpacing: 0.2,
    paddingHorizontal: 16,
    paddingTop: 22,
    paddingBottom: 7,
  },
  row: { paddingLeft: 16 },
  rowBody: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11, paddingRight: 16 },
  rowMain: { flex: 1, gap: 6 },
  label: { fontSize: 17, letterSpacing: -0.4 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
  separator: { height: StyleSheet.hairlineWidth },
});
