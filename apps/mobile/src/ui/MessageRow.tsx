/**
 * One row of the transcript: a user bubble, or an assistant message with its
 * reasoning, tool cards, and branch controls.
 *
 * The transcript is a `FlatList` because a long thread on a phone is the case
 * that has to stay smooth; everything here is memoised so a streaming delta in
 * the message below does not re-render the ones above.
 *
 * Long-pressing a message opens the system context menu (Copy, Select Text,
 * Share, Edit / Regenerate), the way Messages does. Reasoning and tool output
 * are collapsed by default: they are the parts of a turn that can run to
 * hundreds of lines, and left open they bury the answer.
 */

import { memo, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import type { UiImage, UiMessage, UiTool } from "../chat";
import { toolSummary } from "../chat";
import * as haptics from "../haptics";
import { useTheme } from "../theme";
import { Badge, Button, Mono } from "./controls";
import Icon from "./Icon";
import type { IconName } from "./Icon";
import Markdown from "./Markdown";
import Menu from "./Menu";
import type { MenuItem } from "./Menu";

const TOOL_STATUS = {
  running: { label: "running", tone: "neutral" as const },
  awaiting: { label: "awaiting approval", tone: "warn" as const },
  approved: { label: "approved", tone: "good" as const },
  denied: { label: "denied", tone: "bad" as const },
  done: { label: "done", tone: "good" as const },
  failed: { label: "failed", tone: "bad" as const },
};

/**
 * How often a streaming message re-renders. Markdown is re-parsed in full on
 * every render, so rendering each token makes a long reply stutter; ~12 frames
 * a second still reads as live typing.
 */
const STREAM_RENDER_MS = 80;

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

/** `value`, but updated at most every `ms` while `active`; immediate otherwise. */
function useThrottled<T>(value: T, active: boolean, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (!active) {
      setShown(value);
      return;
    }
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      last.current = Date.now();
      setShown(latest.current);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, active, ms]);

  return active ? shown : value;
}

/** A header that toggles the section under it, with a rotating chevron. */
function Disclosure({
  open,
  onToggle,
  children,
  accessibilityLabel,
}: {
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ expanded: open }}
      onPress={() => {
        haptics.selection();
        onToggle();
      }}
      hitSlop={6}
      style={({ pressed }) => [styles.disclosure, pressed && { opacity: 0.5 }]}
    >
      {children}
      <Icon
        name={open ? "chevron.up" : "chevron.down"}
        size={11}
        weight="semibold"
        color={theme.color.textFaint}
      />
    </Pressable>
  );
}

function Reasoning({ text, thinking }: { text: string; thinking: boolean }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.reasoning, { backgroundColor: theme.color.surfaceAlt }]}>
      <Disclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        accessibilityLabel={open ? "Hide reasoning" : "Show reasoning"}
      >
        {thinking ? <ActivityIndicator size="small" color={theme.color.textFaint} /> : null}
        <Text style={[styles.reasoningLabel, { color: theme.color.textDim }]}>
          {thinking ? "Thinking…" : "Thought process"}
        </Text>
      </Disclosure>
      {open ? <Mono>{text}</Mono> : null}
    </View>
  );
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
  const [open, setOpen] = useState(false);
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
      <Disclosure
        open={open}
        onToggle={() => setOpen((v) => !v)}
        accessibilityLabel={`${tool.name}, ${status.label}. ${open ? "Hide" : "Show"} details`}
      >
        <Icon name="terminal" size={13} weight="semibold" color={theme.color.textDim} />
        <Text style={[styles.toolName, { color: theme.color.text }]} numberOfLines={1}>
          {tool.name}
        </Text>
        {tool.running && !awaiting ? (
          <ActivityIndicator size="small" color={theme.color.textFaint} />
        ) : null}
        <Badge label={status.label} tone={status.tone} />
      </Disclosure>

      {summary ? (
        <Mono numberOfLines={open ? undefined : 1} style={styles.toolSummary}>
          {summary}
        </Mono>
      ) : null}

      {awaiting ? (
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
      ) : null}

      {open && tool.result !== undefined ? (
        <Mono style={tool.isError ? { color: theme.color.danger } : undefined}>{tool.result}</Mono>
      ) : null}
    </View>
  );
}

function Images({ images, onOpen }: { images: UiImage[]; onOpen: (src: string) => void }) {
  const theme = useTheme();
  if (images.length === 0) return null;
  return (
    <View style={styles.images}>
      {images.map((image, index) => (
        <Pressable
          key={image.attachmentId ?? image.src.slice(0, 32) + index}
          accessibilityRole="imagebutton"
          accessibilityLabel="Open image"
          disabled={!image.src}
          onPress={() => onOpen(image.src)}
        >
          <Image
            // A stored attachment is fetched by the caller and handed over as a
            // data URL, because `<Image>` cannot carry the bearer token itself.
            source={{ uri: image.src }}
            style={[styles.image, { backgroundColor: theme.color.surfaceAlt }]}
            resizeMode="cover"
          />
        </Pressable>
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
  /** Opens the text in a sheet where it can be partially selected. */
  onSelectText: (text: string) => void;
  onOpenImage: (src: string) => void;
  busy: boolean;
}

async function copy(text: string): Promise<void> {
  await Clipboard.setStringAsync(text);
  haptics.success();
}

function MessageRowBase({
  message,
  streaming,
  onRegenerate,
  onEdit,
  onSwitchBranch,
  onDecide,
  onSelectText,
  onOpenImage,
  busy,
}: MessageRowProps) {
  const theme = useTheme();
  const isUser = message.role === "user";
  const branch = message.branch;
  const text = useThrottled(message.text, streaming, STREAM_RENDER_MS);
  const reasoning = useThrottled(message.reasoning, streaming, STREAM_RENDER_MS);
  const idle = !streaming && !busy;

  const menu: MenuItem[] = [
    ...(message.text
      ? [
          {
            id: "copy",
            title: "Copy",
            icon: "doc.on.doc" as const,
            onPress: () => void copy(message.text),
          },
          {
            id: "select",
            title: "Select Text",
            icon: "character.cursor.ibeam" as const,
            onPress: () => onSelectText(message.text),
          },
          {
            id: "share",
            title: "Share…",
            icon: "square.and.arrow.up" as const,
            onPress: () => void Share.share({ message: message.text }),
          },
        ]
      : []),
    ...(idle
      ? [
          isUser
            ? { id: "edit", title: "Edit", icon: "pencil" as const, onPress: () => onEdit(message.id) }
            : {
                id: "regenerate",
                title: "Regenerate",
                icon: "arrow.clockwise" as const,
                onPress: () => onRegenerate(message.id),
              },
        ]
      : []),
  ];

  const bubble = (
    <View
      style={[
        styles.bubble,
        isUser
          ? { backgroundColor: theme.color.userBubble }
          : { backgroundColor: theme.color.bg },
        isUser ? styles.bubbleUser : styles.bubbleAssistant,
      ]}
    >
      {message.images.length > 0 ? <Images images={message.images} onOpen={onOpenImage} /> : null}

      {message.reasoning ? <Reasoning text={reasoning} thinking={streaming && !message.text} /> : null}

      {text ? (
        isUser ? (
          <Text style={[styles.userText, { color: theme.color.userBubbleText }]}>{text}</Text>
        ) : (
          <Markdown>{text}</Markdown>
        )
      ) : null}

      {/* A turn that has only started streaming shows a pulse and nothing
          else; it reads as "thinking", which is accurate. */}
      {streaming && !message.text && !message.reasoning ? <StreamingPulse /> : null}

      {message.tools.map((tool) => (
        <ToolCard key={tool.callId} tool={tool} onDecide={onDecide} disabled={busy && !tool.running} />
      ))}
    </View>
  );

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      {menu.length > 0 ? (
        <Menu items={menu} trigger="longPress" style={isUser ? styles.menuUser : styles.menuAssistant}>
          {bubble}
        </Menu>
      ) : (
        bubble
      )}

      <View style={styles.rowActions}>
        {branch && branch.count > 1 ? (
          <View style={styles.branch}>
            <BranchButton
              icon="chevron.left"
              label="Previous version"
              disabled={branch.index <= 0}
              onPress={() => onSwitchBranch(branch.ids[branch.index - 1])}
            />
            <Text style={[styles.branchCount, { color: theme.color.textDim }]}>
              {branch.index + 1}/{branch.count}
            </Text>
            <BranchButton
              icon="chevron.right"
              label="Next version"
              disabled={branch.index >= branch.count - 1}
              onPress={() => onSwitchBranch(branch.ids[branch.index + 1])}
            />
          </View>
        ) : null}

        {idle ? (
          isUser ? (
            <RowAction icon="pencil" label="Edit message" onPress={() => onEdit(message.id)} />
          ) : (
            <>
              {message.text ? (
                <RowAction icon="doc.on.doc" label="Copy response" onPress={() => void copy(message.text)} />
              ) : null}
              <RowAction
                icon="arrow.clockwise"
                label="Regenerate response"
                onPress={() => onRegenerate(message.id)}
              />
            </>
          )
        ) : null}
      </View>
    </View>
  );
}

/** A quiet, icon-only action under a message, as in the system chat apps. */
function RowAction({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.actionButton, pressed && { opacity: 0.4 }]}
    >
      <Icon name={icon} size={15} weight="medium" color={theme.color.textDim} />
    </Pressable>
  );
}

function BranchButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => [
        styles.branchButton,
        pressed && { opacity: 0.4 },
        disabled && { opacity: 0.3 },
      ]}
    >
      <Icon name={icon} size={13} weight="semibold" color={theme.color.textDim} />
    </Pressable>
  );
}

function StreamingPulse() {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <View style={styles.pulseRow} accessibilityLabel="Waiting for a response">
      <Animated.View style={[styles.pulse, { backgroundColor: theme.color.textFaint, opacity }]} />
    </View>
  );
}

export default memo(MessageRowBase);

const styles = StyleSheet.create({
  row: { gap: 4 },
  rowUser: { alignItems: "flex-end" },
  rowAssistant: { alignItems: "flex-start" },
  menuUser: { maxWidth: "80%" },
  menuAssistant: { maxWidth: "100%" },
  bubble: {
    gap: 8,
    overflow: "hidden",
  },
  bubbleUser: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    borderCurve: "continuous",
  },
  bubbleAssistant: { paddingHorizontal: 2, paddingVertical: 2, borderRadius: 12 },
  userText: { fontSize: 17, lineHeight: 23, letterSpacing: -0.2 },
  rowActions: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 2 },
  actionButton: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  branch: { flexDirection: "row", alignItems: "center", gap: 6 },
  branchButton: { width: 24, height: 28, alignItems: "center", justifyContent: "center" },
  branchCount: { fontSize: 13, fontVariant: ["tabular-nums"] },
  pulseRow: { height: 22, justifyContent: "center" },
  pulse: { width: 10, height: 10, borderRadius: 5 },
  disclosure: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 28 },
  reasoning: { gap: 6, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6 },
  reasoningLabel: { flex: 1, fontSize: 13, fontWeight: "600" },
  tool: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  toolName: { fontSize: 15, fontWeight: "600", flex: 1 },
  toolSummary: { marginTop: -2 },
  approvalButtons: { flexDirection: "row", gap: 8, paddingBottom: 4 },
  flex: { flex: 1 },
  images: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  image: { width: 120, height: 120, borderRadius: 14 },
});
