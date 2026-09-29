/**
 * Native `UIMenu`s attached to arbitrary views.
 *
 * Two triggers, matching how iOS uses menus:
 *
 *   - `press`: a pull-down from a button (the composer's "+", a picker row in
 *     Settings). The menu *is* the button's action, so the children must not be
 *     pressable themselves — the native view takes the tap.
 *   - `longPress`: a context menu. The system lifts the view out, blurs the
 *     rest, and shows the actions — the Messages long-press. Taps still reach
 *     the children, so a row stays tappable.
 *
 * `@react-native-menu/menu` has no web implementation (it renders the children
 * and nothing else), so off native a `press` menu falls back to `fallback`.
 */

import { MenuView } from "@react-native-menu/menu";
import type { MenuAction, NativeActionEvent } from "@react-native-menu/menu";
import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import { Platform, Pressable } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import * as haptics from "../haptics";
import type { IconName } from "./Icon";

export interface MenuItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: IconName;
  destructive?: boolean;
  disabled?: boolean;
  /** Shows a checkmark; for single-choice pickers. */
  checked?: boolean;
  onPress?: () => void;
  /** A submenu, or with `inline` a separated group within this menu. */
  children?: MenuItem[];
  inline?: boolean;
}

function toAction(item: MenuItem): MenuAction {
  return {
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    image: item.icon,
    state: item.checked ? "on" : undefined,
    attributes: { destructive: item.destructive, disabled: item.disabled },
    subactions: item.children?.map(toAction),
    displayInline: item.inline,
  };
}

function collect(items: MenuItem[], into: Map<string, () => void>): Map<string, () => void> {
  for (const item of items) {
    if (item.onPress) into.set(item.id, item.onPress);
    if (item.children) collect(item.children, into);
  }
  return into;
}

export default function Menu({
  items,
  title,
  trigger = "press",
  fallback,
  style,
  accessibilityLabel,
  children,
}: {
  items: MenuItem[];
  title?: string;
  trigger?: "press" | "longPress";
  /** What a `press` menu does where no native menu exists (web). */
  fallback?: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  children: ReactNode;
}) {
  const actions = useMemo(() => items.map(toAction), [items]);
  const handlers = useMemo(() => collect(items, new Map()), [items]);

  const onPressAction = useCallback(
    ({ nativeEvent }: NativeActionEvent) => {
      const handler = handlers.get(nativeEvent.event);
      if (!handler) return;
      haptics.selection();
      handler();
    },
    [handlers],
  );

  if (Platform.OS === "web") {
    if (trigger === "press" && fallback) {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          onPress={fallback}
          style={style}
        >
          {children}
        </Pressable>
      );
    }
    return <>{children}</>;
  }

  return (
    <MenuView
      title={title}
      actions={actions}
      onPressAction={onPressAction}
      shouldOpenOnLongPress={trigger === "longPress"}
      onOpenMenu={trigger === "longPress" ? haptics.tap : undefined}
      style={style}
    >
      {children}
    </MenuView>
  );
}
