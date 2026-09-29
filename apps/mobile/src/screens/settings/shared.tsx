/**
 * Pieces every Settings screen uses, so the screens read as one app: the
 * scroll view with the insets and keyboard behaviour a grouped form needs, the
 * request banners, the pop-up-button row, and the destructive confirmation.
 */

import type { ReactNode } from "react";
import { Alert, Platform, ScrollView, StyleSheet, Switch, View } from "react-native";
import type { ColorValue } from "react-native";
import * as haptics from "../../haptics";
import { useTheme } from "../../theme";
import { Banner } from "../../ui/controls";
import Icon from "../../ui/Icon";
import type { IconName } from "../../ui/Icon";
import { ListRow } from "../../ui/List";
import Menu from "../../ui/Menu";

/** iOS system colours for the Settings-style icon tiles. */
export const TILE = {
  orange: "#ff9500",
  purple: "#af52de",
  green: "#34c759",
  blue: "#007aff",
  indigo: "#5856d6",
  teal: "#30b0c7",
  red: "#ff3b30",
  gray: "#8e8e93",
} as const;

export function SettingsScroll({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <ScrollView
      style={{ backgroundColor: theme.color.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

/** The error and notice banners a `guard`ed screen shows above its lists. */
export function Notices({
  error,
  errorTitle = "Request failed",
  notice,
  onDismissNotice,
}: {
  error: string | null;
  errorTitle?: string;
  notice?: string | null;
  onDismissNotice?: () => void;
}) {
  if (!error && !notice) return null;
  return (
    <View style={styles.banners}>
      {error ? <Banner tone="error" title={errorTitle} detail={error} /> : null}
      {notice ? <Banner tone="info" title={notice} onDismiss={onDismissNotice} /> : null}
    </View>
  );
}

/** A banner spaced like a list section, for empty and warning states. */
export function SectionBanner(props: Parameters<typeof Banner>[0]) {
  return (
    <View style={styles.banners}>
      <Banner {...props} />
    </View>
  );
}

/** A padded cell inside a `ListSection` for a text field and its Save button. */
export function FormRow({ children }: { children: ReactNode }) {
  return <View style={styles.form}>{children}</View>;
}

/** The trailing chevron, for rows whose accessory slot holds something else too. */
export function Chevron() {
  const theme = useTheme();
  return <Icon name="chevron.right" size={13} weight="semibold" color={theme.color.textFaint} />;
}

export function SettingSwitch({
  value,
  onValueChange,
  disabled,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      trackColor={{ true: theme.color.accent, false: theme.dark ? "#48484a" : "#e9e9eb" }}
    />
  );
}

export interface PickerOption<T> {
  value: T;
  label: string;
  subtitle?: string;
}

/**
 * The iOS pop-up button row: the current value on the trailing side, and a
 * native menu of the options on tap. The row itself is not pressable, because
 * the native menu takes the tap. Where no native menu exists (web), a tap
 * cycles to the next option instead.
 */
export function PickerRow<T>({
  title,
  subtitle,
  icon,
  iconColor,
  value,
  options,
  onChange,
}: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  iconColor?: ColorValue;
  value: T;
  options: PickerOption<T>[];
  onChange: (next: T) => void;
}) {
  const theme = useTheme();
  const index = options.findIndex((option) => option.value === value);
  const current = options[index];

  return (
    <Menu
      accessibilityLabel={`${title}: ${current?.label ?? "none"}`}
      items={options.map((option, i) => ({
        id: String(i),
        title: option.label,
        subtitle: option.subtitle,
        checked: i === index,
        onPress: () => onChange(option.value),
      }))}
      fallback={() => {
        const next = options[(index + 1) % options.length];
        if (next) onChange(next.value);
      }}
    >
      <ListRow
        title={title}
        subtitle={subtitle}
        icon={icon}
        iconColor={iconColor}
        value={current?.label}
        accessory={
          <Icon name="chevron.up.chevron.down" size={13} weight="semibold" color={theme.color.textFaint} />
        }
      />
    </Menu>
  );
}

/**
 * Ask before something destructive. `Alert` does nothing on web, so the web
 * preview falls back to the browser's own confirm dialog.
 */
export function confirmDestructive({
  title,
  message,
  action,
  onConfirm,
}: {
  title: string;
  message?: string;
  action: string;
  onConfirm: () => void;
}): void {
  haptics.warning();
  if (Platform.OS === "web") {
    const confirm = (globalThis as { confirm?: (text: string) => boolean }).confirm;
    if (confirm?.(message ? `${title}\n\n${message}` : title)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: action, style: "destructive", onPress: onConfirm },
  ]);
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 40 },
  banners: { marginTop: 18, gap: 10 },
  form: { padding: 16, gap: 12 },
});
