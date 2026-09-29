/**
 * Inset-grouped lists, as in the Settings app.
 *
 * `ListSection` is the rounded card with an optional header above and footer
 * below; `ListRow` is one row in it. Separators are inserted between rows by
 * the section and inset to the text, the way `UITableView` draws them, so a
 * caller never places them by hand.
 *
 * Rows follow the standard cell layouts: an optional coloured icon tile, a
 * title with an optional subtitle, and a trailing value plus accessory
 * (disclosure chevron, checkmark, or any element such as a `Switch`).
 */

import { Children, Fragment, isValidElement } from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import { useTheme } from "../theme";
import { SECTION_RADIUS } from "./controls";
import Icon from "./Icon";
import type { IconName } from "./Icon";

const ICON_TILE = 29;

export function ListSection({
  header,
  footer,
  children,
  style,
}: {
  header?: string;
  footer?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const rows = Children.toArray(children).filter(isValidElement);
  // Separators are inset past the icon tile when the rows carry icons.
  const inset = rows.some((row) => (row.props as { icon?: unknown }).icon) ? 16 + ICON_TILE + 14 : 16;

  return (
    <View style={[styles.section, style]}>
      {header ? (
        <Text style={[styles.header, { color: theme.color.textDim }]}>{header.toUpperCase()}</Text>
      ) : null}
      <View style={[styles.card, { backgroundColor: theme.color.surface }]}>
        {rows.map((row, index) => (
          <Fragment key={row.key ?? index}>
            {index > 0 ? (
              <View
                style={[styles.separator, { marginLeft: inset, backgroundColor: theme.color.separator }]}
              />
            ) : null}
            {row}
          </Fragment>
        ))}
      </View>
      {footer ? (
        <Text style={[styles.footer, { color: theme.color.textDim }]}>{footer}</Text>
      ) : null}
    </View>
  );
}

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** Trailing secondary text, e.g. the current value of a setting. */
  value?: string;
  /** SF Symbol shown white on a coloured rounded tile, as in Settings. */
  icon?: IconName;
  iconColor?: ColorValue;
  /** `chevron` for rows that push, `check` for the selected option. */
  accessory?: "chevron" | "check" | ReactNode;
  destructive?: boolean;
  /** Tinted like a button, for action rows ("Add Tool…"). */
  action?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
}

export function ListRow({
  title,
  subtitle,
  value,
  icon,
  iconColor,
  accessory,
  destructive,
  action,
  disabled,
  onPress,
  onLongPress,
  accessibilityLabel,
}: ListRowProps) {
  const theme = useTheme();
  const titleColor = destructive
    ? theme.color.danger
    : action
      ? theme.color.accent
      : theme.color.text;

  const trailing =
    accessory === "chevron" ? (
      <Icon name="chevron.right" size={13} weight="semibold" color={theme.color.textFaint} />
    ) : accessory === "check" ? (
      <Icon name="checkmark" size={16} weight="semibold" color={theme.color.accent} />
    ) : (
      accessory
    );

  const body = (
    <>
      {icon ? (
        <View style={[styles.tile, { backgroundColor: iconColor ?? theme.color.accent }]}>
          <Icon name={icon} size={16} weight="medium" color="#ffffff" />
        </View>
      ) : null}
      <View style={styles.labels}>
        <Text style={[styles.title, { color: titleColor }]} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: theme.color.textDim }]} numberOfLines={3}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text style={[styles.value, { color: theme.color.textDim }]} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {trailing}
    </>
  );

  if (!onPress && !onLongPress) {
    return (
      <View style={[styles.row, disabled && styles.disabled]} accessibilityLabel={accessibilityLabel}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: theme.color.fill },
        disabled && styles.disabled,
      ]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 18 },
  header: {
    fontSize: 13,
    letterSpacing: 0.2,
    paddingHorizontal: 16,
    paddingBottom: 7,
  },
  footer: {
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 16,
    paddingTop: 7,
  },
  card: { borderRadius: SECTION_RADIUS, overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  tile: {
    width: ICON_TILE,
    height: ICON_TILE,
    borderRadius: 7,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  labels: { flex: 1, gap: 2 },
  title: { fontSize: 17, letterSpacing: -0.4 },
  subtitle: { fontSize: 13, lineHeight: 17 },
  value: { fontSize: 17, maxWidth: "45%", letterSpacing: -0.4 },
  disabled: { opacity: 0.45 },
});
