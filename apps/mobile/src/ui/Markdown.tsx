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

import { useMemo, useState } from "react";
import MarkdownDisplay, { MarkdownIt } from "react-native-markdown-display";
import type { ASTNode, RenderRules } from "react-native-markdown-display";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as haptics from "../haptics";
import { useTheme } from "../theme";
import Icon from "./Icon";

/** One shared instance: markdown-it keeps a parser cache that is worth reusing. */
const parser = MarkdownIt({
  // The web app's renderer uses GFM, so single newlines break a line rather
  // than running on as one paragraph.
  breaks: true,
  typographer: false,
  linkify: true,
});

/**
 * A fenced or indented code block: a header with the language and a Copy
 * button, and the code in a horizontal scroller. Wrapping code is worse than
 * scrolling it — a wrapped line of shell reads as two commands.
 */
function CodeBlock({ code, language }: { code: string; language: string }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  return (
    <View style={[styles.code, { backgroundColor: theme.color.surfaceAlt }]}>
      <View style={styles.codeHead}>
        <Text style={[styles.codeLang, { color: theme.color.textDim }]} numberOfLines={1}>
          {language || "code"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy code"
          hitSlop={8}
          onPress={() => {
            void Clipboard.setStringAsync(code).then(() => {
              haptics.success();
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          style={({ pressed }) => [styles.codeCopy, pressed && { opacity: 0.5 }]}
        >
          <Icon
            name={copied ? "checkmark" : "doc.on.doc"}
            size={13}
            weight="medium"
            color={theme.color.textDim}
          />
          <Text style={[styles.codeCopyLabel, { color: theme.color.textDim }]}>
            {copied ? "Copied" : "Copy"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeScroll}>
        <Text
          style={[styles.codeText, { color: theme.color.text, fontFamily: theme.font.mono }]}
          selectable
        >
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

function codeRule(node: ASTNode) {
  // markdown-it keeps the fence's info string (`ts`, `sh title=x`) on the
  // token; the library copies it to the node without typing it.
  const info = String((node as ASTNode & { sourceInfo?: string }).sourceInfo ?? "").trim();
  return <CodeBlock key={node.key} code={node.content.replace(/\n$/, "")} language={info.split(/\s+/)[0] ?? ""} />;
}

const rules: RenderRules = { fence: codeRule, code_block: codeRule };

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
        fontSize: 17,
        lineHeight: 24,
      },
      heading1: { fontSize: 22, fontWeight: "700" as const, marginTop: 14, marginBottom: 6, letterSpacing: -0.4 },
      heading2: { fontSize: 20, fontWeight: "700" as const, marginTop: 12, marginBottom: 4, letterSpacing: -0.3 },
      heading3: { fontSize: 18, fontWeight: "600" as const, marginTop: 10, marginBottom: 4 },
      heading4: { fontSize: 17, fontWeight: "600" as const, marginTop: 8, marginBottom: 4 },
      heading5: { fontSize: 17, fontWeight: "600" as const },
      heading6: { fontSize: 15, fontWeight: "600" as const, color: theme.color.textDim },
      paragraph: { marginTop: 6, marginBottom: 6 },
      link: { color: theme.color.accent },
      blockquote: {
        backgroundColor: theme.color.surfaceAlt,
        borderLeftWidth: 3,
        borderLeftColor: theme.color.separator,
        paddingLeft: 12,
        paddingRight: 12,
        paddingVertical: 4,
        marginTop: 6,
        marginBottom: 6,
        borderRadius: 8,
      },
      code_inline: {
        fontFamily: theme.font.mono,
        fontSize: 15,
        backgroundColor: theme.color.surfaceAlt,
        color: theme.color.text,
        borderRadius: 6,
      },
      bullet_list: { marginTop: 4, marginBottom: 4 },
      ordered_list: { marginTop: 4, marginBottom: 4 },
      list_item: { marginTop: 2, marginBottom: 2 },
      hr: {
        backgroundColor: theme.color.separator,
        height: StyleSheet.hairlineWidth,
        marginTop: 12,
        marginBottom: 12,
      },
      strong: { fontWeight: "700" as const },
      em: { fontStyle: "italic" as const },
      s: { textDecorationLine: "line-through" as const },
      table: { borderWidth: StyleSheet.hairlineWidth, borderColor: theme.color.separator },
      th: {
        backgroundColor: theme.color.surfaceAlt,
        padding: 6,
        fontWeight: "700" as const,
        flex: 1,
      },
      td: {
        padding: 6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderColor: theme.color.separator,
        flex: 1,
      },
    }),
    [theme],
  );

  return (
    <View style={style}>
      <MarkdownDisplay style={markdownStyle} markdownit={parser} rules={rules}>
        {children}
      </MarkdownDisplay>
    </View>
  );
}

const styles = StyleSheet.create({
  code: { borderRadius: 12, marginVertical: 6, overflow: "hidden" },
  codeHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 12,
    paddingRight: 8,
    paddingTop: 6,
  },
  codeLang: { fontSize: 12, fontWeight: "600", flexShrink: 1 },
  codeCopy: { flexDirection: "row", alignItems: "center", gap: 4, padding: 4 },
  codeCopyLabel: { fontSize: 12, fontWeight: "500" },
  codeScroll: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 12 },
  codeText: { fontSize: 13, lineHeight: 19 },
});
