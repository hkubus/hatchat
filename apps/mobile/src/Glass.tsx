import { BlurView } from "expo-blur";
import {
  GlassContainer,
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from "expo-glass-effect";
import type { ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";
import { useTheme } from "./theme";

/**
 * Translucent chrome that renders as real Liquid Glass where that exists, and
 * degrades to a plain material blur everywhere else.
 *
 * Liquid Glass belongs to the *navigation layer* only — controls that float over
 * content (the composer, floating buttons). Content itself (bubbles, cards,
 * settings rows) stays solid, per the HIG: glass on glass, or glass under text
 * you have to read, is what makes an app look like a port.
 *
 * Environments this has to work in:
 *
 *   - iOS 26+: `expo-glass-effect`, which is `UIGlassEffect` underneath.
 *   - iOS below 26, Expo Go, web: `expo-blur` with a tint that supplies the
 *     surface colour and keeps text legible.
 *
 * The availability probe calls both checks: `isLiquidGlassAvailable` reports
 * whether the SDK has the components, and `isGlassEffectAPIAvailable` guards
 * against the iOS 26 betas that shipped without the runtime API (and crash).
 */

const liquid = (() => {
  if (Platform.OS !== "ios") return false;
  try {
    return isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
  } catch {
    return false;
  }
})();

/** True when this build is drawing Apple's real Liquid Glass. */
export function hasNativeGlass(): boolean {
  return liquid;
}

export type GlassVariant = "regular" | "clear";

export interface GlassProps {
  /** `regular` tints the material; `clear` keeps only the distortion. */
  variant?: GlassVariant;
  /** Glass that responds to touch (scales and shimmers). Use for buttons. */
  interactive?: boolean;
  /** Tints the glass, e.g. the accent colour for a primary action. */
  tint?: ColorValue;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  /** Blur strength for the fallback. Ignored when the native effect is in use. */
  intensity?: number;
}

export function Glass({ variant = "regular", interactive, tint, style, children, intensity }: GlassProps) {
  const theme = useTheme();

  if (liquid) {
    return (
      <GlassView
        glassEffectStyle={variant}
        isInteractive={interactive}
        tintColor={tint}
        style={[styles.host, style]}
      >
        {children}
      </GlassView>
    );
  }

  // The blur and tint are absolutely positioned *siblings* before the children,
  // not wrappers around them, so the caller's layout style (row direction,
  // padding, alignment) applies to the children exactly as it does natively.
  return (
    <View style={[styles.host, style]}>
      <BlurView
        intensity={intensity ?? 50}
        tint={theme.dark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: tint ?? theme.color.glassTint }]}
      />
      {children}
    </View>
  );
}

/**
 * Groups neighbouring glass shapes so they blend and morph into one another as
 * they move, the way the system does with adjacent bar buttons. A plain view
 * where Liquid Glass is unavailable.
 */
export function GlassGroup({
  spacing,
  style,
  children,
}: {
  spacing?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  if (liquid) {
    return (
      <GlassContainer spacing={spacing} style={style}>
        {children}
      </GlassContainer>
    );
  }
  return <View style={style}>{children}</View>;
}

const styles = StyleSheet.create({
  host: {
    overflow: "hidden",
  },
});
