/**
 * Design tokens.
 *
 * The web app styles itself with a `styles.css` of custom properties. React
 * Native has no cascade and no `prefers-color-scheme` media query in the same
 * form, so the palette is resolved once here from the OS appearance and handed
 * to the styles as plain objects.
 *
 * Colours are deliberately close to the web app's so the two clients read as
 * one product, but the radii and spacing are tuned for touch: nothing tappable
 * is under 44pt, and the type scale starts a step larger.
 */

import { useColorScheme } from "react-native";

export interface Theme {
  dark: boolean;
  color: {
    /** Screen background, behind everything. */
    bg: string;
    /** Cards, tool results, list rows. */
    surface: string;
    surfaceAlt: string;
    border: string;
    text: string;
    textDim: string;
    textFaint: string;
    /** Bubbles for the user's own messages. */
    userBubble: string;
    userBubbleText: string;
    assistantBubble: string;
    accent: string;
    accentText: string;
    /** Approval prompt. */
    warn: string;
    warnSurface: string;
    danger: string;
    dangerSurface: string;
    success: string;
    /** Hairline used to separate the composer from the transcript. */
    hairline: string;
    /** Translucent fill laid over the glass chrome. */
    glassTint: string;
  };
  space: (n: number) => number;
  radius: { sm: number; md: number; lg: number; pill: number };
  font: {
    body: number;
    small: number;
    tiny: number;
    title: number;
    mono: string;
  };
}

const MONO =
  // Hermes ships no monospace family by name on iOS; these are the SF Mono
  // faces, with Menlo as the simulator/desktop fallback.
  'ui-monospace, "SF Mono", Menlo, monospace';

const light: Theme["color"] = {
  bg: "#f6f6f7",
  surface: "#ffffff",
  surfaceAlt: "#f0f0f2",
  border: "#e0e0e4",
  text: "#16161a",
  textDim: "#5c5c66",
  textFaint: "#8e8e98",
  userBubble: "#16161a",
  userBubbleText: "#ffffff",
  assistantBubble: "#ffffff",
  accent: "#0a58d6",
  accentText: "#ffffff",
  warn: "#8a5a00",
  warnSurface: "#fff4d6",
  danger: "#b3261e",
  dangerSurface: "#fce8e6",
  success: "#1c7a4a",
  hairline: "#e6e6ea",
  glassTint: "rgba(255,255,255,0.72)",
};

const dark: Theme["color"] = {
  bg: "#0b0b0d",
  surface: "#17171a",
  surfaceAlt: "#202024",
  border: "#2c2c33",
  text: "#f2f2f5",
  textDim: "#a5a5b0",
  textFaint: "#74747f",
  userBubble: "#f2f2f5",
  userBubbleText: "#0b0b0d",
  assistantBubble: "#17171a",
  accent: "#4c94ff",
  accentText: "#06121f",
  warn: "#e8b64c",
  warnSurface: "#33280c",
  danger: "#ff6b6b",
  dangerSurface: "#3a1a1a",
  success: "#4ec98a",
  hairline: "#26262c",
  glassTint: "rgba(22,22,26,0.72)",
};

const base = {
  space: (n: number) => n * 4,
  radius: { sm: 8, md: 12, lg: 20, pill: 999 },
  font: { body: 16, small: 14, tiny: 12, title: 20, mono: MONO },
};

export const lightTheme: Theme = { dark: false, color: light, ...base };
export const darkTheme: Theme = { dark: true, color: dark, ...base };

/** The theme for the current OS appearance. */
export function useTheme(): Theme {
  return useColorScheme() === "dark" ? darkTheme : lightTheme;
}
