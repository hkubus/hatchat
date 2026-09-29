/**
 * Design tokens.
 *
 * iOS-native system palette. Colours are the iOS system colours
 * (systemBackground, systemGroupedBackground, separator, systemBlue, …)
 * resolved once here from the OS appearance, so every screen reads as a
 * first-party iOS app in both light and dark mode.
 *
 * Type scale and radii follow the Human Interface Guidelines: 17pt body,
 * 15pt subhead, 13pt footnote, 10–12pt continuous corners, 44pt minimum
 * touch targets.
 */

import { useColorScheme } from "react-native";

export interface Theme {
  dark: boolean;
  color: {
    /** Detail background — `systemBackground`. White / black. */
    bg: string;
    /** Grouped background — `systemGroupedBackground`. Sidebar, settings. */
    grouped: string;
    /** Cells, cards, sheets — `secondarySystemGroupedBackground`. */
    surface: string;
    /** Fills: text-field + segmented backgrounds — `systemGray5/6`. */
    surfaceAlt: string;
    /** Tracks, pressed states — `systemGray4/5`. */
    fill: string;
    border: string;
    /** `separator`. */
    separator: string;
    /** `label`. */
    text: string;
    /** `secondaryLabel`. */
    textDim: string;
    /** `tertiaryLabel`. */
    textFaint: string;
    /** iMessage blue, both appearances. */
    userBubble: string;
    userBubbleText: string;
    /** Incoming-message grey. */
    assistantBubble: string;
    /** `systemBlue`. */
    accent: string;
    accentText: string;
    /** Approval prompt — `systemOrange`. */
    warn: string;
    warnSurface: string;
    /** `systemRed`. */
    danger: string;
    dangerSurface: string;
    /** `systemGreen`. */
    success: string;
    /** Hairline used to separate chrome from content — `separator`. */
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
  bg: "#ffffff",
  grouped: "#f2f2f7",
  surface: "#ffffff",
  surfaceAlt: "#f2f2f7",
  fill: "#e9e9eb",
  border: "#e5e5ea",
  separator: "#e5e5ea",
  text: "#000000",
  textDim: "#636366",
  textFaint: "#8e8e93",
  userBubble: "#007aff",
  userBubbleText: "#ffffff",
  assistantBubble: "#e9e9eb",
  accent: "#007aff",
  accentText: "#ffffff",
  warn: "#ff9500",
  warnSurface: "#fff4e0",
  danger: "#ff3b30",
  dangerSurface: "#fee9e7",
  success: "#248a3d",
  hairline: "#e5e5ea",
  glassTint: "rgba(255,255,255,0.72)",
};

const dark: Theme["color"] = {
  bg: "#000000",
  grouped: "#000000",
  surface: "#1c1c1e",
  surfaceAlt: "#2c2c2e",
  fill: "#48484a",
  border: "#38383a",
  separator: "#38383a",
  text: "#ffffff",
  textDim: "#98989d",
  textFaint: "#636366",
  userBubble: "#0a84ff",
  userBubbleText: "#ffffff",
  assistantBubble: "#262629",
  accent: "#0a84ff",
  accentText: "#ffffff",
  warn: "#ff9f0a",
  warnSurface: "#33270a",
  danger: "#ff453a",
  dangerSurface: "#3a1a1a",
  success: "#30d158",
  hairline: "#38383a",
  glassTint: "rgba(28,28,30,0.72)",
};

const base = {
  space: (n: number) => n * 4,
  radius: { sm: 10, md: 12, lg: 16, pill: 999 },
  font: { body: 17, small: 15, tiny: 13, title: 22, mono: MONO },
};

export const lightTheme: Theme = { dark: false, color: light, ...base };
export const darkTheme: Theme = { dark: true, color: dark, ...base };

/** The theme for the current OS appearance. */
export function useTheme(): Theme {
  return useColorScheme() === "dark" ? darkTheme : lightTheme;
}
