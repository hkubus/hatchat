/**
 * SF Symbols.
 *
 * Unicode glyphs (☰, ✎, ⚙︎) are the quickest way to make an iOS app look like
 * it is not one: wrong weight, wrong optical size, wrong baseline. `SymbolView`
 * renders the real symbol, matched to the text weight next to it.
 *
 * Off iOS (web preview, Android) the symbol is unavailable, so each name used
 * here carries a plain-text stand-in.
 */

import { SymbolView } from "expo-symbols";
import type { SymbolViewProps, SymbolWeight } from "expo-symbols";
import { Text } from "react-native";
import type { ColorValue, StyleProp, ViewStyle } from "react-native";

/** Any SF Symbol name. Typed, so a misspelt symbol fails the typecheck. */
export type IconName = Extract<SymbolViewProps["name"], string>;

/** Stand-ins for the web preview and Android; anything missing shows a dot. */
const FALLBACK: Partial<Record<IconName, string>> = {
  "arrow.up": "↑",
  "arrow.down": "↓",
  "arrow.clockwise": "↻",
  "chevron.left": "‹",
  "chevron.right": "›",
  "chevron.down": "⌄",
  checkmark: "✓",
  ellipsis: "…",
  "ellipsis.circle": "…",
  "exclamationmark.triangle.fill": "⚠︎",
  gearshape: "⚙︎",
  pencil: "✎",
  photo: "▣",
  "slider.horizontal.3": "☰",
  "square.and.pencil": "✎",
  trash: "🗑",
  plus: "＋",
  "stop.fill": "■",
  xmark: "✕",
  "xmark.circle.fill": "✕",
  "bubble.left.and.bubble.right": "💬",
  "server.rack": "▤",
  "doc.on.doc": "⧉",
  "square.and.arrow.up": "⇪",
  camera: "◉",
  "photo.on.rectangle": "▣",
  "chevron.up": "⌃",
  "chevron.up.chevron.down": "↕",
  "key.fill": "⚿",
  "puzzlepiece.extension.fill": "⧉",
  brain: "✺",
  "hand.raised.fill": "✋",
  checklist: "☑",
  network: "⌘",
  sparkles: "✦",
  terminal: "›_",
  "exclamationmark.shield.fill": "⚠︎",
  "character.cursor.ibeam": "I",
};

export default function Icon({
  name,
  size = 17,
  color,
  weight = "regular",
  style,
}: {
  name: IconName;
  size?: number;
  color: ColorValue;
  weight?: SymbolWeight;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      weight={weight}
      style={[{ width: size, height: size }, style]}
      fallback={
        <Text style={{ color, fontSize: size, lineHeight: size + 2, textAlign: "center" }}>
          {FALLBACK[name] ?? "•"}
        </Text>
      }
    />
  );
}
