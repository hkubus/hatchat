/**
 * Navigation-bar buttons.
 *
 * On iOS these become real `UIBarButtonItem`s — SF Symbol icons, native
 * pull-down `UIMenu`s, and on iOS 26 the grouped Liquid Glass capsule the
 * system draws around bar items. Nothing about them is drawn in JS.
 *
 * `unstable_header*Items` is iOS-only, so every item also renders as a plain
 * React button for the web preview and Android. A menu there falls back to a
 * single action (`fallbackPress`), since there is no native menu to open.
 */

import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
  NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useTheme } from "../theme";
import Icon from "./Icon";
import type { IconName } from "./Icon";

export type BarItem =
  | {
      kind: "button";
      label: string;
      icon?: IconName;
      variant?: "plain" | "done" | "prominent";
      disabled?: boolean;
      onPress: () => void;
    }
  | {
      kind: "menu";
      label: string;
      icon: IconName;
      menu: NativeStackHeaderItemMenu["menu"];
      fallbackPress: () => void;
    };

function toNative(item: BarItem): NativeStackHeaderItem {
  const icon = item.icon ? { type: "sfSymbol" as const, name: item.icon } : undefined;
  if (item.kind === "menu") {
    return { type: "menu", label: item.label, accessibilityLabel: item.label, icon, menu: item.menu };
  }
  return {
    type: "button",
    label: item.label,
    accessibilityLabel: item.label,
    icon,
    variant: item.variant,
    disabled: item.disabled,
    onPress: item.onPress,
  };
}

function FallbackItems({ items }: { items: BarItem[] }) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      {items.map((item) => {
        const onPress = item.kind === "menu" ? item.fallbackPress : item.onPress;
        const disabled = item.kind === "button" && item.disabled;
        return (
          <Pressable
            key={item.label}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            onPress={onPress}
            disabled={disabled}
            hitSlop={6}
            style={({ pressed }) => [styles.button, (pressed || disabled) && { opacity: 0.4 }]}
          >
            {item.icon ? (
              <Icon name={item.icon} size={20} color={theme.color.accent} />
            ) : (
              <Text
                style={[
                  styles.label,
                  { color: theme.color.accent },
                  item.kind === "button" && item.variant === "done" && styles.labelDone,
                ]}
              >
                {item.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Navigator options that place `items` on one side of the bar. */
export function barItems(
  side: "left" | "right",
  items: BarItem[],
): Partial<NativeStackNavigationOptions> {
  const native = () => items.map(toNative);
  const fallback = () => <FallbackItems items={items} />;
  return side === "left"
    ? { unstable_headerLeftItems: native, headerLeft: fallback }
    : { unstable_headerRightItems: native, headerRight: fallback };
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 4 },
  button: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 17 },
  labelDone: { fontWeight: "600" },
});
