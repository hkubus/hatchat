import { BlurView } from "expo-blur";
// Imported from `expo` rather than `expo-modules-core`: Expo re-exports both
// of these, and taking the module core as a direct dependency is what
// `expo-doctor` flags (it is not part of the public surface of this package).
import { requireNativeView as requireNativeViewManager, requireOptionalNativeModule } from "expo";
import type { ComponentType } from "react";
import { Platform, StyleSheet, View } from "react-native";
import type { GlassProps, GlassVariant } from "../modules/liquid-glass";
import { useTheme } from "./theme";

export type { GlassProps, GlassVariant };

/**
 * Translucent chrome that renders as real Liquid Glass where that exists, and
 * degrades to a plain material blur everywhere else.
 *
 * Three environments have to work, and this wrapper hides which one you are in:
 *
 *   - iOS 26+ with the local module built in: `UIGlassEffect`, the real thing.
 *   - iOS below 26: the module compiles, and the Swift `#available` check in
 *     `LiquidGlassModule.swift` picks `UIBlurEffect(.systemMaterial)`.
 *   - Expo Go, or any build made before `expo prebuild`: the native module is
 *     not in the binary at all, so `expo-blur` stands in.
 *
 * The availability probe has to be `requireOptionalNativeModule`, and it has to
 * run before `requireNativeViewManager`. The latter does not fail when a view is
 * unregistered — it hands back a host component for a view that does not exist,
 * which renders as a red box instead of falling back.
 */

type NativeGlass = ComponentType<GlassProps>;

let nativeGlass: NativeGlass | null = null;
try {
  if (Platform.OS === "ios" && requireOptionalNativeModule("LiquidGlass") !== null) {
    nativeGlass = requireNativeViewManager<GlassProps>("LiquidGlass");
  }
} catch {
  nativeGlass = null;
}

/** True when this build has Apple's real `UIGlassEffect` available. */
export function hasNativeGlass(): boolean {
  return nativeGlass !== null;
}

export function Glass({ variant = "regular", style, children, intensity }: GlassProps & {
  /** Blur strength for the fallback. Ignored when the native effect is in use. */
  intensity?: number;
}) {
  const theme = useTheme();
  // Capitalised alias: a lowercase JSX tag would be read as an intrinsic
  // element name rather than as this variable.
  const NativeGlass = nativeGlass;

  if (NativeGlass) {
    return (
      <NativeGlass variant={variant} style={style}>
        {children}
      </NativeGlass>
    );
  }

  return (
    <View style={[styles.host, style]}>
      <BlurView
        intensity={intensity ?? 40}
        tint={theme.dark ? "systemMaterialDark" : "systemMaterialLight"}
        style={StyleSheet.absoluteFill}
      />
      {/* The blur alone is nearly transparent; this tint supplies the surface
          colour and the contrast that keeps text legible over it. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.color.glassTint }]} />
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    overflow: "hidden",
  },
  content: {
    flex: 1,
  },
});
