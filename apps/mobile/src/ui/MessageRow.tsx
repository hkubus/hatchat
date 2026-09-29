/**
 * One row of the transcript: a user bubble, or an assistant message with its
 * reasoning, tool cards, and branch controls.
 *
 * The transcript is a `FlatList` because a long thread on a phone is the case
 * that has to stay smooth; everything here is memoised so a streaming delta in
 * the message below does not re-render the ones above.
 *
 * Long-pressing a message opens the system context menu (Copy, Select Text,
 * Share, Edit / Regenerate, Fork from Here), the way Messages does. Reasoning and tool output
 * are collapsed by default: they are the parts of a turn that can run to
 * hundreds of lines, and left open they bury the answer. What a tool exists to
 * *show* stays out of the fold: a `todo_write` checklist, a pending `ask_user`
 * question, and the images and files a tool produced.
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
  TextInput,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { fetchAttachmentBase64 } from "../api";
import type { UiFile, UiImage, UiMessage, UiTool } from "@hat/core";
import { formatBytes, joinAnswer, questionOf, todosOf, toolSummary } from "@hat/core";
import * as haptics from "../haptics";
import { useTheme } from "../theme";
import { LOCAL_PREFIX } from "../useChat";
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
  onAnswer,
  disabled,
}: {
  tool: UiTool;
  onDecide: (callId: string, decision: "approve" | "deny") => void;
  onAnswer: (callId: string, answer: string) => void;
  disabled: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const status = statusOf(tool);
  const summary = toolSummary(tool);
  const awaiting = tool.running && tool.approval === "requested";
  const todos = tool.name === "todo_write" ? todosOf(tool.args) : [];
  const question =
    tool.name === "ask_user" && tool.running && !tool.answered && !awaiting
      ? questionOf(tool.args)
      : undefined;

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
        <Icon
          name={todos.length > 0 ? "checklist" : question ? "questionmark.bubble" : "terminal"}
          size={13}
          weight="semibold"
          color={theme.color.textDim}
        />
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

      {todos.length > 0 ? <Todos todos={todos} /> : null}

      {question ? (
        <Question
          key={tool.callId}
          question={question}
          onAnswer={(answer) => onAnswer(tool.callId, answer)}
        />
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

/** `todo_write` as a checklist: done items struck through, the current one bold. */
function Todos({ todos }: { todos: ReturnType<typeof todosOf> }) {
  const theme = useTheme();
  return (
    <View style={styles.todos}>
      {todos.map((todo, index) => {
        const done = todo.status === "completed";
        const active = todo.status === "in_progress";
        return (
          <View key={index} style={styles.todo}>
            <Icon
              name={done ? "checkmark.circle.fill" : active ? "arrow.right.circle.fill" : "circle"}
              size={15}
              color={done ? theme.color.success : active ? theme.color.accent : theme.color.textFaint}
              style={styles.todoMark}
            />
            <Text
              style={[
                styles.todoText,
                { color: done ? theme.color.textFaint : theme.color.text },
                done && styles.todoDone,
                active && styles.todoActive,
              ]}
            >
              {todo.content}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * An `ask_user` prompt. A single-select option answers on tap; multi-select
 * collects choices and sends them with any typed text on Send.
 */
function Question({
  question,
  onAnswer,
}: {
  question: NonNullable<ReturnType<typeof questionOf>>;
  onAnswer: (answer: string) => void;
}) {
  const theme = useTheme();
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const answer = question.multiSelect ? joinAnswer(selected, text) : text.trim();

  const toggle = (option: string) => {
    haptics.selection();
    if (!question.multiSelect) return onAnswer(option);
    setSelected((current) =>
      current.includes(option) ? current.filter((o) => o !== option) : [...current, option],
    );
  };

  return (
    <View style={[styles.question, { borderColor: theme.color.accent }]}>
      <Text style={[styles.questionText, { color: theme.color.text }]}>{question.question}</Text>
      {question.options.length > 0 ? (
        <View style={styles.options}>
          {question.options.map((option) => (
            <Button
              key={option}
              label={question.multiSelect && selected.includes(option) ? `✓ ${option}` : option}
              onPress={() => toggle(option)}
              variant={selected.includes(option) ? "primary" : "secondary"}
              compact
            />
          ))}
        </View>
      ) : null}
      <View style={styles.answerRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={question.options.length > 0 ? "Or type an answer" : "Type an answer"}
          placeholderTextColor={theme.color.textFaint}
          onSubmitEditing={() => answer && onAnswer(answer)}
          returnKeyType="send"
          style={[
            styles.answerInput,
            { color: theme.color.text, backgroundColor: theme.color.surface },
          ]}
        />
        <Button
          label="Send"
          onPress={() => onAnswer(answer)}
          variant="primary"
          compact
          disabled={!answer}
        />
      </View>
    </View>
  );
}

/**
 * Images and files a tool produced. Rendered outside the card so a plot or an
 * artifact is visible without expanding the tool output.
 */
function ToolArtifacts({ tool, onOpenImage }: { tool: UiTool; onOpenImage: (src: string) => void }) {
  const images = tool.images ?? [];
  const files = tool.files ?? [];
  if (images.length === 0 && files.length === 0) return null;
  return (
    <View style={styles.artifacts}>
      {images.map((image, index) => (
        <ArtifactImage
          key={image.attachmentId ?? index}
          src={image.src}
          attachmentId={image.attachmentId}
          onOpen={onOpenImage}
        />
      ))}
      {files.map((file) =>
        file.mime.startsWith("image/") ? (
          <ArtifactImage key={`${file.id}-image`} attachmentId={file.id} onOpen={onOpenImage} />
        ) : null,
      )}
      {files.map((file) => (
        <FileCard key={file.id} file={file} />
      ))}
    </View>
  );
}

/**
 * A full-width tool image; tapping opens the full-screen viewer. An attachment
 * is fetched as a data URL first, since `<Image>` cannot carry the bearer token.
 */
function ArtifactImage({
  src,
  attachmentId,
  onOpen,
}: {
  src?: string;
  attachmentId?: string;
  onOpen: (src: string) => void;
}) {
  const theme = useTheme();
  const [uri, setUri] = useState(src || "");
  const [ratio, setRatio] = useState(4 / 3);

  useEffect(() => {
    if (src || !attachmentId) return;
    let live = true;
    fetchAttachmentBase64(attachmentId)
      .then((data) => live && setUri(data))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [src, attachmentId]);

  useEffect(() => {
    if (!uri) return;
    Image.getSize(uri, (w, h) => h > 0 && setRatio(w / h), () => undefined);
  }, [uri]);

  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel="Open image"
      disabled={!uri}
      onPress={() => onOpen(uri)}
      style={[styles.artifactImage, { aspectRatio: ratio, backgroundColor: theme.color.surfaceAlt }]}
    >
      {uri ? (
        <Image source={{ uri }} style={styles.flex} resizeMode="contain" />
      ) : (
        <ActivityIndicator style={styles.flex} color={theme.color.textFaint} />
      )}
    </Pressable>
  );
}

/**
 * A stored artifact. Tapping downloads it (with the bearer token) and hands the
 * bytes to the share sheet, which covers Save to Files, Quick Look, and other
 * apps without a native file-system dependency.
 */
function FileCard({ file }: { file: UiFile }) {
  const theme = useTheme();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // A document on the optimistic user message is not on the server yet.
  const pending = file.id.startsWith(LOCAL_PREFIX);

  const open = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const url = await fetchAttachmentBase64(file.id);
      await Share.share({ url, title: file.name });
    } catch {
      haptics.error();
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${file.name}`}
      onPress={() => void open()}
      disabled={loading || pending}
      style={({ pressed }) => [
        styles.file,
        { backgroundColor: theme.color.surfaceAlt },
        pressed && { opacity: 0.6 },
      ]}
    >
      <Icon name="doc" size={20} color={theme.color.textDim} />
      <View style={styles.flex}>
        <Text style={[styles.fileName, { color: theme.color.text }]} numberOfLines={1}>
          {file.name}
        </Text>
        <Text
          style={[styles.fileMeta, { color: failed ? theme.color.danger : theme.color.textDim }]}
          numberOfLines={1}
        >
          {failed
            ? "Couldn’t open — tap to retry"
            : [file.size > 0 ? formatBytes(file.size) : "", file.mime].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {loading || pending ? (
        <ActivityIndicator size="small" color={theme.color.textFaint} />
      ) : (
        <Icon name="square.and.arrow.up" size={17} color={theme.color.accent} />
      )}
    </Pressable>
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
  /** Start a new conversation from the path up to this message. */
  onFork: (messageId: string) => void;
  /**
   * Called with the sibling id to switch to. The id is resolved by the caller
   * from the row's own branch data, since the row only knows the index.
   */
  onSwitchBranch: (siblingId: string) => void;
  onDecide: (callId: string, decision: "approve" | "deny") => void;
  onAnswer: (callId: string, answer: string) => void;
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
  onFork,
  onSwitchBranch,
  onDecide,
  onAnswer,
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
      ? isUser
        ? [{ id: "edit", title: "Edit", icon: "pencil" as const, onPress: () => onEdit(message.id) }]
        : [
            {
              id: "regenerate",
              title: "Regenerate",
              icon: "arrow.clockwise" as const,
              onPress: () => onRegenerate(message.id),
            },
            // Offered on replies only: a fork ending on a user message would
            // have no reply to regenerate or continue from.
            {
              id: "fork",
              title: "Fork from Here",
              subtitle: "New conversation up to this reply",
              icon: "arrow.triangle.branch" as const,
              onPress: () => onFork(message.id),
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
        <View key={tool.callId} style={styles.toolGroup}>
          <ToolCard
            tool={tool}
            onDecide={onDecide}
            onAnswer={onAnswer}
            disabled={busy && !tool.running}
          />
          <ToolArtifacts tool={tool} onOpenImage={onOpenImage} />
        </View>
      ))}
    </View>
  );

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      {/* Attached documents sit above the bubble as their own cards, the way
          Messages shows attachments. Tapping one shares the stored file. */}
      {message.files.length > 0 ? (
        <View style={isUser ? styles.userFiles : styles.artifacts}>
          {message.files.map((file) => (
            <FileCard key={file.id} file={file} />
          ))}
        </View>
      ) : null}

      {/* A message of documents alone has nothing to put in a bubble; an
          empty one would be a stray blue dot under the cards. */}
      {isUser && !message.text && message.images.length === 0 ? null : menu.length > 0 ? (
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
  toolGroup: { gap: 8 },
  todos: { gap: 4 },
  todo: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  todoMark: { marginTop: 2 },
  todoText: { fontSize: 15, flex: 1 },
  todoDone: { textDecorationLine: "line-through" },
  todoActive: { fontWeight: "600" },
  question: { gap: 10, borderLeftWidth: 3, paddingLeft: 10, paddingBottom: 4 },
  questionText: { fontSize: 16, fontWeight: "600" },
  options: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  answerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  answerInput: { flex: 1, minHeight: 36, borderRadius: 10, paddingHorizontal: 10, fontSize: 15 },
  artifacts: { gap: 8 },
  userFiles: { gap: 6, width: "80%", maxWidth: 360 },
  artifactImage: { width: "100%", maxHeight: 420, borderRadius: 12, overflow: "hidden" },
  file: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 12, padding: 12 },
  fileName: { fontSize: 15, fontWeight: "600" },
  fileMeta: { fontSize: 13 },
});
