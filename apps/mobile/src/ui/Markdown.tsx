/**
 * Markdown rendering for assistant messages.
 *
 * The web app uses `react-markdown` + `rehype-highlight`, both of which build a
 * DOM tree. There is no DOM here, so the pipeline is `markdown-it` (via
 * `react-native-markdown-display`) rendering to native views.
 *
 * Two notes on how this drives the library:
 *
 *   - Styles go in the `style` prop, which the package merges over its own
 *     defaults. Its `rules` prop takes render *functions*, not styles, so
 *     passing a theme there would be silently ignored.
 *   - The parser instance is built once at module scope and passed in. Left to
 *     its default, the library constructs a new `markdown-it` on every render,
 *     which throws away its inline-parse cache on each streamed delta.
 *
 * Syntax highlighting is deliberately left out: `highlight.js` is ~1 MB of
 * language grammars, and a chat transcript on a phone does not justify it in
 * the app bundle. Fenced blocks get a monospace surface instead. If highlighting
 * is wanted later, the right place is a lazily-required per-language grammar,
 * not the default bundle.
 */

import { useMemo } from "react";
import MarkdownDisplay, { MarkdownIt } from "react-native-markdown-display";
import { StyleSheet, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { useTheme } from "../theme";

/** One shared instance: markdown-it keeps a parser cache that is worth reusing. */
const parser = MarkdownIt({
  // The web app's renderer uses GFM, so single newlines break a line rather
  // than running on as one paragraph.
  breaks: true,
  typographer: false,
  linkify: true,
});

export interface MarkdownProps {
  children: string;
  style?: StyleProp<ViewStyle>;
}

export default function Markdown({ children, style }: MarkdownProps) {
  const theme = useTheme();

  const markdownStyle = useMemo(
    () => ({
      body: {
        color: theme.color.text,
        fontSize: theme.font.body,
        lineHeight: theme.font.body * 1.45,
      },
      heading1: { fontSize: 22, fontWeight: "700" as const, marginTop: 14, marginBottom: 6 },
      heading2: { fontSize: 19, fontWeight: "700" as const, marginTop: 12, marginBottom: 4 },
      heading3: { fontSize: 17, fontWeight: "700" as const, marginTop: 10, marginBottom: 4 },
      heading4: { fontSize: 16, fontWeight: "700" as const, marginTop: 8, marginBottom: 4 },
      heading5: { fontSize: 16, fontWeight: "600" as const },
      heading6: { fontSize: 16, fontWeight: "600" as const, color: theme.color.textDim },
      paragraph: { marginTop: 6, marginBottom: 6 },
      link: { color: theme.color.accent, textDecorationLine: "underline" as const },
      blockquote: {
        backgroundColor: theme.color.surfaceAlt,
        borderLeftWidth: 3,
        borderLeftColor: theme.color.border,
        paddingLeft: 12,
        paddingRight: 12,
        paddingVertical: 4,
        marginTop: 6,
        marginBottom: 6,
      },
      code_inline: {
        fontFamily: theme.font.mono,
        fontSize: 14,
        backgroundColor: theme.color.surfaceAlt,
        color: theme.color.text,
      },
      code_block: {
        fontFamily: theme.font.mono,
        fontSize: 13,
        lineHeight: 19,
        backgroundColor: theme.color.surfaceAlt,
        color: theme.color.text,
        borderRadius: 10,
        padding: 12,
        marginTop: 6,
        marginBottom: 6,
      },
      fence: {
        fontFamily: theme.font.mono,
        fontSize: 13,
        lineHeight: 19,
        backgroundColor: theme.color.surfaceAlt,
        color: theme.color.text,
        borderRadius: 10,
        padding: 12,
        marginTop: 6,
        marginBottom: 6,
      },
      bullet_list: { marginTop: 4, marginBottom: 4 },
      ordered_list: { marginTop: 4, marginBottom: 4 },
      list_item: { marginTop: 2, marginBottom: 2 },
      hr: {
        backgroundColor: theme.color.border,
        height: StyleSheet.hairlineWidth,
        marginTop: 12,
        marginBottom: 12,
      },
      strong: { fontWeight: "700" as const },
      em: { fontStyle: "italic" as const },
      s: { textDecorationLine: "line-through" as const },
      table: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.border },
      th: {
        backgroundColor: theme.color.surfaceAlt,
        padding: 6,
        fontWeight: "700" as const,
        flex: 1,
      },
      td: {
        padding: 6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.color.border,
        flex: 1,
      },
    }),
    [theme],
  );

  return (
    <View style={style}>
      <MarkdownDisplay style={markdownStyle} markdownit={parser}>
        {children}
      </MarkdownDisplay>
    </View>
  );
}
