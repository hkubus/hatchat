/**
 * One row of the transcript: a user bubble, or an assistant message with its
 * reasoning, tool cards, and branch controls.
 *
 * The transcript is a `FlatList` because a long thread on a phone is the case
 * that has to stay smooth; everything here is memoised so a streaming delta in
 * the message below does not re-render the ones above.
 */

import { memo } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { UiImage, UiMessage, UiTool } from "../chat";
import { toolSummary } from "../chat";
import { useTheme } from "../theme";
import { Badge, Button, Mono } from "./controls";
import Markdown from "./Markdown";

const TOOL_STATUS = {
  running: { label: "running", tone: "neutral" as const },
  awaiting: { label: "awaiting approval", tone: "warn" as const },
  approved: { label: "approved", tone: "good" as const },
  denied: { label: "denied", tone: "bad" as const },
  done: { label: "done", tone: "good" as const },
  failed: { label: "failed", tone: "bad" as const },
};

function statusOf(tool: UiTool): { label: string; tone: "neutral" | "good" | "warn" | "bad" } {
  if (tool.running) {
    return tool.approval === "requested"
      ? TOOL_STATUS.awaiting
      : TOOL_STATUS.running;
  }
  if (tool.isError) return TOOL_STATUS.failed;
  if (tool.approval === "denied") return TOOL_STATUS.denied;
  if (tool.approval === "approved") return TOOL_STATUS.approved;
  return TOOL_STATUS.done;
}

function ToolCard({
  tool,
  onDecide,
  disabled,
}: {
  tool: UiTool;
  onDecide: (callId: string, decision: "approve" | "deny") => void;
  disabled: boolean;
}) {
  const theme = useTheme();
  const status = statusOf(tool);
  const summary = toolSummary(tool);
  const awaiting = tool.running && tool.approval === "requested";

  return (
    <View
      style={[
        styles.tool,
        { backgroundColor: theme.color.surfaceAlt },
        awaiting && { borderColor: theme.color.warn },
      ]}
    >
      <View style={styles.toolHead}>
        <Text style={[styles.toolName, { color: theme.color.text }]} numberOfLines={1}>
          {tool.name}
        </Text>
        <View style={styles.toolStatus}>
          {tool.running && !awaiting ? (
            <ActivityIndicator size="small" color={theme.color.textFaint} />
          ) : null}
          <Badge label={status.label} tone={status.tone} />
        </View>
      </View>

      {summary ? (
        <Mono numberOfLines={3} style={styles.toolSummary}>
          {summary}
        </Mono>
      ) : null}

      {awaiting ? (
        <View style={styles.approval}>
          <Text style={[styles.approvalText, { color: theme.color.textDim }]}>
            This tool wants to run before it continues.
          </Text>
          <View style={styles.approvalButtons}>
            <Button
              label="Deny"
              onPress={() => onDecide(tool.callId, "deny")}
              variant="danger"
              compact
              disabled={disabled}
              style={styles.flex}
            />
            <Button
              label="Approve"
              onPress={() => onDecide(tool.callId, "approve")}
              variant="primary"
              compact
              disabled={disabled}
              style={styles.flex}
            />
          </View>
        </View>
      ) : null}

      {tool.result !== undefined ? (
        tool.isError ? (
          <Mono style={{ color: theme.color.danger }}>{tool.result}</Mono>
        ) : (
          <Mono>{tool.result}</Mono>
        )
      ) : null}
    </View>
  );
}

function Images({ images }: { images: UiImage[] }) {
  const theme = useTheme();
  if (images.length === 0) return null;
  return (
    <View style={styles.images}>
      {images.map((image, index) => (
        <Image
          key={image.attachmentId ?? image.src.slice(0, 32) + index}
          // A stored attachment is fetched by the caller and handed over as a
          // data URL, because `<Image>` cannot carry the bearer token itself.
          source={{ uri: image.src }}
          style={[styles.image, { backgroundColor: theme.color.surfaceAlt }]}
          resizeMode="cover"
        />
      ))}
    </View>
  );
}

export interface MessageRowProps {
  message: UiMessage;
  streaming: boolean;
  onRegenerate: (messageId: string) => void;
  onEdit: (messageId: string) => void;
  /**
   * Called with the sibling id to switch to. The id is resolved by the caller
   * from the row's own branch data, since the row only knows the index.
   */
  onSwitchBranch: (siblingId: string) => void;
  onDecide: (callId: string, decision: "approve" | "deny") => void;
  busy: boolean;
}

function MessageRowBase({
  message,
  streaming,
  onRegenerate,
  onEdit,
  onSwitchBranch,
  onDecide,
  busy,
}: MessageRowProps) {
  const theme = useTheme();
  const isUser = message.role === "user";
  const branch = message.branch;

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View
        style={[
          styles.bubble,
          isUser
            ? { backgroundColor: theme.color.userBubble }
            : { backgroundColor: "transparent" },
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
        ]}
      >
        {message.images.length > 0 ? <Images images={message.images} /> : null}

        {message.text ? (
          isUser ? (
            <Text style={[styles.userText, { color: theme.color.userBubbleText }]}>
              {message.text}
            </Text>
          ) : (
            <Markdown>{message.text}</Markdown>
          )
        ) : null}

        {/* A turn that has only started streaming shows a caret and nothing
            else; a caret alone reads as "thinking", which is accurate. */}
        {streaming && !message.text ? <StreamingCaret /> : null}

        {message.reasoning ? (
          <View style={[styles.reasoning, { backgroundColor: theme.color.surfaceAlt }]}>
            <Text style={[styles.reasoningLabel, { color: theme.color.textFaint }]}>
              Reasoning
            </Text>
            <Mono>{message.reasoning}</Mono>
          </View>
        ) : null}

        {message.tools.map((tool) => (
          <ToolCard key={tool.callId} tool={tool} onDecide={onDecide} disabled={busy} />
        ))}
      </View>

      <View style={styles.rowActions}>
        {branch && branch.count > 1 ? (
          <View style={styles.branch}>
            <BranchButton
              label="‹"
              disabled={branch.index <= 0}
              onPress={() => onSwitchBranch(branch.ids[branch.index - 1])}
            />
            <Text style={[styles.branchCount, { color: theme.color.textDim }]}>
              {branch.index + 1}/{branch.count}
            </Text>
            <BranchButton
              label="›"
              disabled={branch.index >= branch.count - 1}
              onPress={() => onSwitchBranch(branch.ids[branch.index + 1])}
            />
          </View>
        ) : null}

        {!streaming && !busy ? (
          isUser ? (
            <Pressable accessibilityRole="button" onPress={() => onEdit(message.id)} hitSlop={8}>
              <Text style={[styles.action, { color: theme.color.accent }]}>Edit</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={() => onRegenerate(message.id)}
              hitSlop={8}
            >
              <Text style={[styles.action, { color: theme.color.accent }]}>Regenerate</Text>
            </Pressable>
          )
        ) : null}
      </View>
    </View>
  );
}

function BranchButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => [
        styles.branchButton,
        { backgroundColor: theme.color.surfaceAlt },
        pressed && { opacity: 0.6 },
        disabled && { opacity: 0.3 },
      ]}
    >
      <Text style={{ color: theme.color.text, fontSize: 15, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}

function StreamingCaret() {
  const theme = useTheme();
  return (
    <View style={styles.caretRow}>
      <View style={[styles.caret, { backgroundColor: theme.color.accent }]} />
    </View>
  );
}

export default memo(MessageRowBase);

const styles = StyleSheet.create({
  row: { gap: 4 },
  rowUser: { alignItems: "flex-end" },
  rowAssistant: { alignItems: "flex-start" },
  bubble: {
    gap: 8,
    overflow: "hidden",
  },
  bubbleUser: {
    maxWidth: "78%",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
  },
  bubbleAssistant: { maxWidth: "100%", paddingHorizontal: 2, paddingVertical: 2 },
  userText: { fontSize: 17, lineHeight: 23, letterSpacing: -0.2 },
  rowActions: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 4 },
  action: { fontSize: 14, fontWeight: "500" },
  branch: { flexDirection: "row", alignItems: "center", gap: 6 },
  branchButton: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  branchCount: { fontSize: 13, fontVariant: ["tabular-nums"] },
  caretRow: { height: 20, justifyContent: "center" },
  caret: { width: 8, height: 8, borderRadius: 4 },
  reasoning: { gap: 4, borderRadius: 10, padding: 10 },
  reasoningLabel: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  tool: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: "transparent", padding: 12, gap: 8 },
  toolHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  toolName: { fontSize: 15, fontWeight: "700", flexShrink: 1 },
  toolStatus: { flexDirection: "row", alignItems: "center", gap: 6 },
  toolSummary: { marginTop: -2 },
  approval: { gap: 8 },
  approvalText: { fontSize: 14 },
  approvalButtons: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  image: { width: 96, height: 96, borderRadius: 12 },
});
