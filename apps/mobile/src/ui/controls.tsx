/**
 * Small shared primitives.
 *
 * The web app reaches for raw elements and utility classes; React Native has
 * neither, so the handful of controls that recur — a pressable that reads as a
 * button, a labelled field, a status dot — live here so the screens do not each
 * re-derive them.
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
import { useTheme } from "../theme";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Renders at 44pt minimum height, for anything in the main flow. */
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

  const palette: Record<NonNullable<ButtonProps["variant"]>, { bg: string; fg: string; border: string }> = {
    primary: { bg: theme.color.accent, fg: theme.color.accentText, border: "transparent" },
    secondary: {
      bg: theme.color.surfaceAlt,
      fg: theme.color.text,
      border: theme.color.border,
    },
    danger: { bg: theme.color.dangerSurface, fg: theme.color.danger, border: "transparent" },
    ghost: { bg: "transparent", fg: theme.color.accent, border: "transparent" },
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
        { backgroundColor: tone.bg, borderColor: tone.border },
        pressed && styles.pressed,
        inactive && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={tone.fg} size="small" />
      ) : (
        <Text style={[styles.buttonLabel, { color: tone.fg }]} numberOfLines={1}>
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
          { color: theme.color.text, backgroundColor: theme.color.surface },
        ]}
      />
      {hint ? (
        <Text style={[styles.hint, { color: theme.color.textFaint }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

/** A row of mutually exclusive options, rendered as a wrapping chip row. */
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
      <View style={styles.chipRow}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(option.value)}
              style={({ pressed }) => [
                styles.chip,
                {
                  backgroundColor: selected ? theme.color.accent : theme.color.surfaceAlt,
                  borderColor: selected ? theme.color.accent : theme.color.border,
                },
                pressed && styles.pressed,
              ]}
            >
              <Text
                style={[
                  styles.chipLabel,
                  { color: selected ? theme.color.accentText : theme.color.text },
                ]}
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
          <Text style={[styles.hint, { color: theme.color.textFaint }]}>{detail}</Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ true: theme.color.accent, false: theme.color.border }}
      />
    </View>
  );
}

/** A small coloured pill, used for capability and status readouts. */
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
      style={[styles.badge, { borderColor: color }]}
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
    error: theme.color.dangerSurface,
    warn: theme.color.warnSurface,
    info: theme.color.surfaceAlt,
  }[tone];
  const accent = {
    error: theme.color.danger,
    warn: theme.color.warn,
    info: theme.color.textDim,
  }[tone];

  return (
    <View style={[styles.banner, { backgroundColor: surface, borderColor: accent }]}>
      <View style={styles.bannerBody}>
        <Text style={[styles.bannerTitle, { color: accent }]}>{title}</Text>
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
          <Text style={[styles.bannerDismiss, { color: accent }]}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionTitle, { color: theme.color.text }]}>{title}</Text>
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
      <Text style={[styles.emptyTitle, { color: theme.color.text }]}>{title}</Text>
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
    minHeight: 48,
    paddingHorizontal: 20,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonCompact: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 10,
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: "600",
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
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  input: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  inputMultiline: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  hint: {
    fontSize: 12,
    lineHeight: 16,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  chipLabel: {
    fontSize: 14,
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
    fontSize: 16,
  },
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  bannerBody: {
    flex: 1,
    gap: 2,
  },
  bannerTitle: {
    fontSize: 14,
    fontWeight: "700",
  },
  bannerDetail: {
    fontSize: 13,
    lineHeight: 18,
  },
  bannerDismiss: {
    fontSize: 14,
    fontWeight: "700",
    paddingHorizontal: 4,
  },
  sectionHeader: {
    gap: 2,
    paddingTop: 8,
    paddingBottom: 4,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 48,
    gap: 6,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
  },
  emptyDetail: {
    fontSize: 14,
    textAlign: "center",
  },
  mono: {
    fontFamily: "ui-monospace",
    fontSize: 13,
    lineHeight: 18,
  },
});
