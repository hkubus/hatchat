/**
 * Small shared primitives, drawn in the iOS idiom.
 *
 * iOS does not use bordered cards with 20pt radii for everything — it uses
 * inset-grouped lists (rounded 10–12pt white cards on a grey ground),
 * `UISegmentedControl`-style segmented picks, tinted pills, and filled
 * system-blue buttons. These primitives match that language so every screen
 * reads as first-party.
 */

import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  KeyboardTypeOptions,
  StyleProp,
  TextStyle,
  ViewStyle,
} from "react-native";
import { hasNativeGlass } from "../Glass";
import { useTheme } from "../theme";
import Icon from "./Icon";

/**
 * Corner radius of an inset-grouped section. iOS 26 rounds these far more than
 * earlier releases, so match whichever design language the device is using.
 */
export const SECTION_RADIUS = hasNativeGlass() ? 24 : 10;

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Compact height for inline / toolbar use. */
  compact?: boolean;
}

export function Button({
  label,
  onPress,
  variant = "secondary",
  disabled,
  loading,
  style,
  compact,
}: ButtonProps) {
  const theme = useTheme();
  const inactive = disabled || loading;

  const palette: Record<NonNullable<ButtonProps["variant"]>, { bg: string; fg: string }> = {
    primary: { bg: theme.color.accent, fg: theme.color.accentText },
    secondary: { bg: theme.color.surfaceAlt, fg: theme.color.text },
    danger: { bg: `${theme.color.danger}1f`, fg: theme.color.danger },
    ghost: { bg: "transparent", fg: theme.color.accent },
  };
  const tone = palette[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(inactive) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: tone.bg },
        pressed && styles.pressed,
        inactive && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={tone.fg} size="small" />
      ) : (
        <Text style={[styles.buttonLabel, compact && styles.buttonLabelCompact, { color: tone.fg }]} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export interface FieldProps {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  hint?: string;
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences";
  keyboardType?: KeyboardTypeOptions;
  multiline?: boolean;
  autoCorrect?: boolean;
  editable?: boolean;
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  hint,
  secureTextEntry,
  autoCapitalize = "none",
  keyboardType,
  multiline,
  autoCorrect = false,
  editable = true,
}: FieldProps) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.color.textDim }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.color.textFaint}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        keyboardType={keyboardType}
        multiline={multiline}
        editable={editable}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          {
            color: theme.color.text,
            backgroundColor: theme.dark ? theme.color.surfaceAlt : "#f2f2f7",
          },
        ]}
      />
      {hint ? (
        <Text style={[styles.hint, { color: theme.color.textFaint }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** iOS `UISegmentedControl` idiom: one track, sliding selected segment. */
export interface SegmentedProps<T extends string> {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  style?: StyleProp<ViewStyle>;
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  style,
}: SegmentedProps<T>) {
  const theme = useTheme();
  return (
    <View style={style}>
      {label ? (
        <Text style={[styles.fieldLabel, { color: theme.color.textDim }]}>{label}</Text>
      ) : null}
      <View style={[styles.segmentTrack, { backgroundColor: theme.color.surfaceAlt }]}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(option.value)}
              style={({ pressed }) => [
                styles.segment,
                selected && [
                  styles.segmentSelected,
                  {
                    backgroundColor: theme.color.surface,
                    borderColor: theme.color.separator,
                    shadowColor: "#000",
                  },
                ],
                pressed && !selected && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.segmentLabel,
                  { color: selected ? theme.color.text : theme.color.textDim },
                  selected && styles.segmentLabelSelected,
                ]}
                numberOfLines={1}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export interface ToggleRowProps {
  label: string;
  detail?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}

export function ToggleRow({ label, detail, value, onValueChange, disabled }: ToggleRowProps) {
  const theme = useTheme();
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleLabels}>
        <Text style={[styles.toggleLabel, { color: theme.color.text }]}>{label}</Text>
        {detail ? (
          <Text style={[styles.hint, { color: theme.color.textFaint }]} numberOfLines={2}>{detail}</Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: theme.color.accent, false: theme.dark ? "#48484a" : "#e9e9eb" }}
      />
    </View>
  );
}

/** A small tinted pill, used for capability and status readouts. */
export function Badge({
  label,
  tone = "neutral",
  title,
}: {
  label: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  title?: string;
}) {
  const theme = useTheme();
  const color = {
    neutral: theme.color.textDim,
    good: theme.color.success,
    warn: theme.color.warn,
    bad: theme.color.danger,
  }[tone];

  return (
    <View
      style={[styles.badge, { backgroundColor: `${color}1f` }]}
      accessibilityLabel={title ? `${label}. ${title}` : undefined}
    >
      <Text style={[styles.badgeLabel, { color }]}>{label}</Text>
    </View>
  );
}

export function Banner({
  tone,
  title,
  detail,
  onDismiss,
}: {
  tone: "error" | "warn" | "info";
  title: string;
  detail?: string;
  onDismiss?: () => void;
}) {
  const theme = useTheme();
  const surface = {
    error: theme.dark ? theme.color.dangerSurface : "#fee9e7",
    warn: theme.dark ? theme.color.warnSurface : "#fff4e0",
    info: theme.color.surfaceAlt,
  }[tone];
  const accent = {
    error: theme.color.danger,
    warn: theme.color.warn,
    info: theme.color.textDim,
  }[tone];

  return (
    <View style={[styles.banner, { backgroundColor: surface }]}>
      <View style={styles.bannerBody}>
        <Text style={[styles.bannerTitle, { color: theme.color.text }]}>{title}</Text>
        {detail ? (
          <Text style={[styles.bannerDetail, { color: theme.color.textDim }]}>{detail}</Text>
        ) : null}
      </View>
      {onDismiss ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          onPress={onDismiss}
          hitSlop={12}
        >
          <Icon name="xmark" size={13} weight="bold" color={accent} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Inset-grouped section header, as in iOS Settings. */
export function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionTitle, { color: theme.color.textDim }]}>{title.toUpperCase()}</Text>
      {detail ? (
        <Text style={[styles.hint, { color: theme.color.textFaint }]}>{detail}</Text>
      ) : null}
    </View>
  );
}

export function Empty({ title, detail }: { title: string; detail?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyTitle, { color: theme.color.textDim }]}>{title}</Text>
      {detail ? (
        <Text style={[styles.emptyDetail, { color: theme.color.textFaint }]}>{detail}</Text>
      ) : null}
    </View>
  );
}

export function Mono({
  children,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const theme = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[styles.mono, { color: theme.color.textDim }, style]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 50,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonCompact: {
    minHeight: 34,
    paddingHorizontal: 14,
    borderRadius: 9,
  },
  buttonLabel: {
    fontSize: 17,
    fontWeight: "600",
  },
  buttonLabelCompact: {
    fontSize: 15,
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.4,
  },
  field: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
  input: {
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 17,
  },
  inputMultiline: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  hint: {
    fontSize: 13,
    lineHeight: 18,
  },
  segmentTrack: {
    flexDirection: "row",
    borderRadius: 9,
    padding: 2,
    gap: 2,
  },
  segment: {
    flex: 1,
    minHeight: 32,
    paddingHorizontal: 10,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
  },
  segmentSelected: {
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.12,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  segmentLabel: {
    fontSize: 13,
    fontWeight: "500",
  },
  segmentLabelSelected: {
    fontWeight: "600",
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    minHeight: 44,
  },
  toggleLabels: {
    flex: 1,
    gap: 2,
  },
  toggleLabel: {
    fontSize: 17,
  },
  badge: {
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  badgeLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    borderRadius: 14,
    padding: 14,
  },
  bannerBody: {
    flex: 1,
    gap: 2,
  },
  bannerTitle: {
    fontSize: 15,
    fontWeight: "600",
  },
  bannerDetail: {
    fontSize: 14,
    lineHeight: 19,
  },
  sectionHeader: {
    gap: 2,
    paddingTop: 16,
    paddingBottom: 6,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
    paddingHorizontal: 32,
    gap: 6,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyDetail: {
    fontSize: 15,
    textAlign: "center",
    lineHeight: 20,
  },
  mono: {
    fontFamily: "ui-monospace",
    fontSize: 13,
    lineHeight: 18,
  },
});
