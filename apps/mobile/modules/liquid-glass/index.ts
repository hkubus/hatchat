/**
 * Local Expo module: the JS binding for the `LiquidGlass` native view.
 *
 * This is only the binding. Deciding *whether* to use it is the app's job, and
 * lives in `src/Glass.tsx`, which falls back to `expo-blur` in builds where the
 * native module is not present.
 */

import { requireNativeView as requireNativeViewManager } from "expo";
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";

export type GlassVariant = "regular" | "clear";

export interface GlassProps {
  /** `regular` tints the material; `clear` keeps only the distortion. */
  variant?: GlassVariant;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

/**
 * Do not import this directly from UI code. `requireNativeViewManager` does not
 * fail when the view is unregistered — it returns a host component pointing at
 * a view that does not exist, which renders as a red box. Probe with
 * `requireOptionalNativeModule` first, as `src/Glass.tsx` does.
 */
export const GlassView = requireNativeViewManager<GlassProps>("LiquidGlass");

export type GlassViewComponent = typeof GlassView;

export default GlassView;
