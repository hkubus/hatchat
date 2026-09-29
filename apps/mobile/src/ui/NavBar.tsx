/**
 * iOS navigation bar.
 *
 * The system bar is a blur with a hairline underneath, 17pt semibold inline
 * title (plus an optional 12pt subtitle), and blue bar-button items with 44pt
 * targets. This matches that language with the `Glass` material so it stays
 * translucent over the transcript, including where the real Liquid Glass
 * module is present. The top safe area lives *inside* the glass, so the blur
 * extends behind the status bar the way the system bar does.
 */

import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Glass } from "../Glass";
import { useTheme } from "../theme";

export function NavButton({
  label,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const textButton = label.length > 2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && { opacity: 0.5 }]}
    >
      <Text
        style={[
          textButton ? styles.buttonText : styles.buttonGlyph,
          { color: theme.color.accent },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export default function NavBar({
  title,
  subtitle,
  onTitlePress,
  leading,
  trailing,
}: {
  title: string;
  subtitle?: string;
  onTitlePress?: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Glass intensity={70} style={[styles.bar, { borderBottomColor: theme.color.hairline }]}>
      <SafeAreaView edges={["top"]}>
        <View style={styles.row}>
          <View style={styles.side}>{leading}</View>
          <Pressable
            accessibilityRole={onTitlePress ? "button" : undefined}
            accessibilityLabel={onTitlePress ? `${title}. Change model` : undefined}
            onPress={onTitlePress}
            disabled={!onTitlePress}
            style={styles.center}
          >
            <Text style={[styles.title, { color: theme.color.text }]} numberOfLines={1}>
              {title}
              {onTitlePress ? <Text style={[styles.chevron, { color: theme.color.textDim }]}> ⌄</Text> : null}
            </Text>
            {subtitle ? (
              <Text style={[styles.subtitle, { color: theme.color.textDim }]} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </Pressable>
          <View style={[styles.side, styles.sideRight]}>{trailing}</View>
        </View>
      </SafeAreaView>
    </Glass>
  );
}

const styles = StyleSheet.create({
  bar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    paddingHorizontal: 4,
  },
  side: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 88,
  },
  sideRight: {
    justifyContent: "flex-end",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
    paddingVertical: 6,
  },
  title: {
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: -0.4,
    textAlign: "center",
  },
  chevron: {
    fontSize: 13,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: 12,
    textAlign: "center",
  },
  button: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  buttonGlyph: {
    fontSize: 22,
    fontWeight: "400",
  },
  buttonText: {
    fontSize: 17,
    fontWeight: "400",
  },
});
