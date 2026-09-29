/**
 * The conversation: transcript under the navigation bar, floating composer at
 * the bottom.
 *
 * The chrome follows iOS 26 Messages. The bar is the system bar; its title
 * shows the model and opens the model sheet, and the conversation options
 * (reasoning effort, tool approval, usage) are a native pull-down menu on a bar
 * button. The composer is a Liquid Glass group — an attach button and the input
 * capsule — floating over the transcript, which scrolls underneath it.
 *
 * The keyboard is driven by `react-native-keyboard-controller`, not
 * `KeyboardAvoidingView`: the composer is pinned to the keyboard frame by frame
 * (including while the transcript is dragged down to dismiss it, as in
 * Messages), and the transcript's inset grows with it so the newest message
 * stays in view.
 *
 * Insets are owned explicitly rather than left to iOS's automatic adjustment:
 * the header height on top, the composer plus keyboard as a real bottom
 * `contentInset`. That is what lets the *native* `scrollToEnd` land exactly on
 * the last message. FlatList's own `scrollToEnd` computes the offset in JS from
 * cell frames and ignores insets, so it would stop with the newest message
 * behind the composer.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollViewProps,
} from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { KeyboardChatScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import type { ApprovalMode, ReasoningEffort } from "@hat/core";
import { usageTotal } from "@hat/core";
import { isAcceptedImageType } from "../api";
import { capSummary } from "../capTags";
import type { UiMessage, UiTool } from "@hat/core";
import { toolSummary } from "@hat/core";
import { Glass, GlassGroup } from "../Glass";
import * as haptics from "../haptics";
import { useChatStore } from "../navigation";
import type { ScreenProps } from "../navigation";
import { useTheme } from "../theme";
import { formatTokens, usageDetail } from "../tokens";
import type { PendingAttachment } from "../useChat";
import { barItems } from "../ui/barItems";
import { Banner, Button, Empty, Mono } from "../ui/controls";
import Icon from "../ui/Icon";
import Menu from "../ui/Menu";
import MessageRow from "../ui/MessageRow";
import { ImageViewer, SelectTextSheet } from "../ui/Sheets";

/** How close to the bottom the list has to be to keep following the stream. */
const NEAR_BOTTOM_PX = 96;

/** Gap between the composer and the keyboard when it is up. */
const KEYBOARD_GAP = 8;

const EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const POLICIES: { value: ApprovalMode; label: string; description: string }[] = [
  { value: "ask", label: "Ask", description: "Pause for approval" },
  { value: "auto", label: "Auto", description: "Run every tool" },
  { value: "allowlist", label: "Allowlist", description: "Ask unless allowlisted" },
  { value: "deny", label: "Deny", description: "Block all tools" },
];

type ScrollRef = { scrollToEnd?: (options: { animated: boolean }) => void };

/** The first tool call in the turn that is waiting on the user. */
function pendingApproval(messages: UiMessage[]): UiTool | undefined {
  for (const message of messages) {
    for (const tool of message.tools) {
      if (tool.running && tool.approval === "requested") return tool;
    }
  }
  return undefined;
}

export default function ChatScreen({ navigation }: ScreenProps<"Chat">) {
  const theme = useTheme();
  const chat = useChatStore();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const listRef = useRef<FlatList<UiMessage>>(null);
  const stickToBottom = useRef(true);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  // Home-indicator clearance while the keyboard is down; with it up the
  // composer sits `KEYBOARD_GAP` above it instead, as in Messages.
  const bottomClearance = Math.max(insets.bottom, KEYBOARD_GAP);
  const keyboardOffset = bottomClearance - KEYBOARD_GAP;
  // The transcript's bottom inset beyond the keyboard: the composer's height.
  const composerInset = useSharedValue(72);
  // The bar is transparent on iOS and the list scrolls under it; elsewhere the
  // bar takes its own space in the layout.
  const topInset = Platform.OS === "ios" ? headerHeight : 0;

  // In-flight messages sit after the stored ones. There is more than one when
  // the turn called tools: the model emits a separate assistant message per
  // iteration, and each holds the tool calls made in it.
  const data = useMemo(
    () => [...chat.messages, ...chat.inFlight],
    [chat.messages, chat.inFlight],
  );

  const scrollToEnd = useCallback((animated: boolean) => {
    const native = listRef.current?.getNativeScrollRef() as ScrollRef | null | undefined;
    if (native?.scrollToEnd) native.scrollToEnd({ animated });
    else listRef.current?.scrollToEnd({ animated });
  }, []);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, contentInset, layoutMeasurement } = event.nativeEvent;
    const distance =
      contentSize.height + (contentInset?.bottom ?? 0) - (contentOffset.y + layoutMeasurement.height);
    // Follow the stream only while the reader is already at the bottom, so
    // scrolling up to re-read something is not fought by every delta.
    stickToBottom.current = distance < NEAR_BOTTOM_PX;
    setAwayFromBottom(distance > NEAR_BOTTOM_PX * 3);
  }, []);

  // --- feedback for things that happen without a tap ----------------------
  const approval = pendingApproval(chat.inFlight);
  const approvalId = approval?.callId;
  useEffect(() => {
    if (approvalId) haptics.warning();
  }, [approvalId]);

  // An `ask_user` question blocks the turn just as an approval does.
  const questionId = chat.inFlight
    .flatMap((m) => m.tools)
    .find((t) => t.name === "ask_user" && t.running && !t.answered)?.callId;
  useEffect(() => {
    if (questionId) haptics.warning();
  }, [questionId]);

  const wasBusy = useRef(chat.busy);
  useEffect(() => {
    if (wasBusy.current && !chat.busy && !chat.error) haptics.success();
    wasBusy.current = chat.busy;
  }, [chat.busy, chat.error]);

  useEffect(() => {
    if (chat.error) haptics.error();
  }, [chat.error]);

  // --- attachments ---------------------------------------------------------
  const addAssets = useCallback(
    (assets: ImagePicker.ImagePickerAsset[]) => {
      // The picker is asked for the compatible (JPEG) representation, so HEIC
      // should not arrive — but the server only parses PNG/JPEG/GIF/WebP, and
      // saying so before the upload beats a 415 after composing a message.
      const rejected = assets.filter((a) => !isAcceptedImageType(a.mimeType));
      const usable = assets.filter((a) => isAcceptedImageType(a.mimeType));

      if (rejected.length > 0) {
        chat.reportError(
          rejected.length === assets.length
            ? `The server only accepts PNG, JPEG, GIF, and WebP. ${rejected.length === 1 ? "That image is" : "Those images are"} a format it cannot read.`
            : `Skipped ${rejected.length} image${rejected.length === 1 ? "" : "s"} in an unsupported format. The server accepts PNG, JPEG, GIF, and WebP.`,
        );
      }

      if (usable.length > 0) {
        haptics.tap();
        setAttachments((prev) => [
          ...prev,
          ...usable.map((asset) => ({
            uri: asset.uri,
            name: asset.fileName ?? `image-${Date.now()}.jpg`,
            type: asset.mimeType ?? "image/jpeg",
            previewUri: asset.uri,
          })),
        ]);
      }
    },
    [chat.reportError],
  );

  const pickImages = useCallback(async () => {
    setPicking(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      // A refusal is not an error worth a red banner; the sheet simply returns
      // nothing and the user can retry from Settings.
      if (!permission.granted) return;

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        quality: 0.9,
        // iOS transcodes HEIC camera-roll photos to JPEG on export, which is
        // what the server can read.
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      if (!result.canceled) addAssets(result.assets);
    } finally {
      setPicking(false);
    }
  }, [addAssets]);

  const takePhoto = useCallback(async () => {
    setPicking(true);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) return;
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 });
      if (!result.canceled) addAssets(result.assets);
    } finally {
      setPicking(false);
    }
  }, [addAssets]);

  // --- sending -------------------------------------------------------------
  const submit = useCallback(async () => {
    const body = text.trim();
    if ((!body && attachments.length === 0) || chat.busy) return;
    haptics.tap();
    setText("");
    const pending = attachments;
    setAttachments([]);
    stickToBottom.current = true;
    scrollToEnd(true);
    await chat.send(body, pending);
  }, [text, attachments, chat, scrollToEnd]);

  const submitEdit = useCallback(async () => {
    if (!editingId) return;
    const id = editingId;
    const body = editingText;
    setEditingId(null);
    setEditingText("");
    haptics.tap();
    await chat.editMessage(id, body);
  }, [editingId, editingText, chat]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditingText("");
  }, []);

  // --- navigation bar ------------------------------------------------------
  // `chat.sessionUsage` already folds in the turn in flight, so this is the
  // whole branch's cost with no extra bookkeeping here.
  const sessionTokens = formatTokens(usageTotal(chat.sessionUsage));

  const sessionTitle =
    chat.sessions.find((s) => s.id === chat.sessionId)?.title ??
    chat.session?.title ??
    "New Chat";
  const modelLabel = chat.selectedModel?.label ?? chat.model;
  const supportsEffort = Boolean(chat.selectedModel?.capabilities.reasoningEffort);
  const capabilities = chat.selectedModel ? capSummary(chat.selectedModel) : "";

  // The bar is rebuilt from these fields only. Depending on the whole store
  // would rebuild the native menu on every streamed token.
  const { reasoningEffort, policyMode, setEffort, setPolicyMode, newChat, sessionUsage } = chat;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${sessionTitle}. Model: ${modelLabel}. Change model`}
          onPress={() => navigation.navigate("Model")}
          hitSlop={8}
          style={({ pressed }) => [styles.title, pressed && { opacity: 0.5 }]}
        >
          <Text
            style={[styles.titleText, { color: theme.color.text }]}
            numberOfLines={1}
            maxFontSizeMultiplier={1.3}
          >
            {sessionTitle}
          </Text>
          <View style={styles.subtitleRow}>
            <Text
              style={[styles.subtitleText, { color: theme.color.textDim }]}
              numberOfLines={1}
              maxFontSizeMultiplier={1.3}
            >
              {modelLabel}
            </Text>
            <Icon name="chevron.down" size={9} weight="bold" color={theme.color.textDim} />
          </View>
        </Pressable>
      ),
      ...barItems("right", [
        {
          kind: "menu",
          label: "Conversation Options",
          icon: "ellipsis",
          fallbackPress: () => navigation.navigate("Settings"),
          menu: {
            items: [
              ...(supportsEffort
                ? [
                    {
                      type: "submenu" as const,
                      label: "Reasoning",
                      icon: { type: "sfSymbol" as const, name: "brain" as const },
                      items: EFFORTS.map((effort) => ({
                        type: "action" as const,
                        label: effort.label,
                        state: reasoningEffort === effort.value ? ("on" as const) : ("off" as const),
                        onPress: () => {
                          haptics.selection();
                          setEffort(effort.value);
                        },
                      })),
                    },
                  ]
                : []),
              {
                type: "submenu",
                label: "Tool Approval",
                icon: { type: "sfSymbol", name: "hand.raised" },
                items: POLICIES.map((policy) => ({
                  type: "action" as const,
                  label: policy.label,
                  description: policy.description,
                  state: policyMode === policy.value ? ("on" as const) : ("off" as const),
                  onPress: () => {
                    haptics.selection();
                    setPolicyMode(policy.value);
                  },
                })),
              },
              {
                type: "action",
                label: "Change Model…",
                description: capabilities || undefined,
                icon: { type: "sfSymbol", name: "cpu" },
                onPress: () => navigation.navigate("Model"),
              },
              {
                type: "submenu",
                label: "Usage",
                inline: true,
                items: [
                  {
                    type: "action",
                    label: sessionTokens ? `${sessionTokens} tokens` : "No usage yet",
                    description: sessionTokens ? usageDetail(sessionUsage) : undefined,
                    icon: { type: "sfSymbol", name: "chart.bar" },
                    disabled: true,
                    onPress: () => undefined,
                  },
                ],
              },
            ],
          },
        },
        {
          kind: "button",
          label: "New Chat",
          icon: "square.and.pencil",
          onPress: () => {
            haptics.tap();
            void newChat().catch(() => undefined);
          },
        },
      ]),
    });
  }, [
    navigation,
    theme,
    reasoningEffort,
    policyMode,
    setEffort,
    setPolicyMode,
    newChat,
    sessionUsage,
    sessionTitle,
    modelLabel,
    supportsEffort,
    capabilities,
    sessionTokens,
  ]);

  // --- transcript ----------------------------------------------------------
  // Row callbacks are stable across renders so `memo(MessageRow)` holds: a
  // streamed token re-renders only the message it lands in. The latest store
  // is read through a ref instead of being captured.
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const onEdit = useCallback((messageId: string) => {
    setEditingId(messageId);
    setEditingText(chatRef.current.messages.find((m) => m.id === messageId)?.text ?? "");
  }, []);
  const onRegenerate = useCallback((messageId: string) => {
    haptics.tap();
    void chatRef.current.regenerate(messageId);
  }, []);
  const onSwitchBranch = useCallback((siblingId: string) => {
    haptics.selection();
    void chatRef.current.switchBranch(siblingId);
  }, []);
  const onDecide = useCallback((callId: string, decision: "approve" | "deny") => {
    if (decision === "approve") haptics.success();
    else haptics.warning();
    void chatRef.current.decide(callId, decision);
  }, []);
  const onAnswer = useCallback((callId: string, answer: string) => {
    haptics.tap();
    void chatRef.current.answer(callId, answer);
  }, []);

  const renderItem = useCallback(
    ({ item }: { item: UiMessage }) => (
      <MessageRow
        message={item}
        streaming={item.streaming === true}
        onRegenerate={onRegenerate}
        onEdit={onEdit}
        onSwitchBranch={onSwitchBranch}
        onDecide={onDecide}
        onAnswer={onAnswer}
        onSelectText={setSelecting}
        onOpenImage={setViewing}
        busy={chat.busy}
      />
    ),
    [chat.busy, onRegenerate, onEdit, onSwitchBranch, onDecide, onAnswer],
  );

  const renderScrollComponent = useCallback(
    (props: ScrollViewProps) => (
      <KeyboardChatScrollView
        {...props}
        offset={keyboardOffset}
        extraContentPadding={composerInset}
        // Lift the transcript with the keyboard only when the reader is at the
        // newest message; someone re-reading older ones keeps their place.
        keyboardLiftBehavior="whenAtEnd"
      />
    ),
    [keyboardOffset, composerInset],
  );

  const onComposerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      composerInset.value = Math.round(event.nativeEvent.layout.height) + 8;
    },
    [composerInset],
  );

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !chat.busy;

  return (
    <View style={[styles.root, { backgroundColor: theme.color.bg }]}>
      <FlatList
        ref={listRef}
        style={StyleSheet.absoluteFill}
        renderScrollComponent={renderScrollComponent}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustsScrollIndicatorInsets={false}
        scrollIndicatorInsets={{ top: topInset }}
        data={data}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        onScroll={onScroll}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => {
          // Instant while streaming — an animated scroll per delta judders.
          if (stickToBottom.current) scrollToEnd(!chat.busy);
        }}
        contentContainerStyle={[
          styles.list,
          { paddingTop: topInset + 12 },
          data.length === 0 && styles.listEmpty,
        ]}
        ListEmptyComponent={
          chat.ready ? (
            <Empty
              title="Start a Conversation"
              detail="Ask something, or attach an image for a vision-capable model."
            />
          ) : (
            <ActivityIndicator color={theme.color.textFaint} />
          )
        }
        ListFooterComponent={
          <View style={styles.footer}>
            {chat.error ? (
              <Banner tone="error" title="Something went wrong" detail={chat.error} onDismiss={chat.clearError} />
            ) : null}
            {chat.warnings.map((warning, i) => (
              <Banner key={i} tone="warn" title="Heads up" detail={warning} />
            ))}
          </View>
        }
      />

      {/* Floating chrome, pinned to the keyboard. `box-none` so the transcript
          under the gaps between the glass shapes still scrolls and takes taps. */}
      <KeyboardStickyView
        offset={{ closed: 0, opened: keyboardOffset }}
        pointerEvents="box-none"
        style={styles.composerDock}
      >
        <View
          pointerEvents="box-none"
          style={[styles.composer, { paddingBottom: bottomClearance }]}
          onLayout={onComposerLayout}
        >
          {awayFromBottom && !editingId && !approval ? (
            <Glass interactive style={styles.jump}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Scroll to latest message"
                onPress={() => {
                  haptics.tap();
                  stickToBottom.current = true;
                  scrollToEnd(true);
                }}
                style={styles.fill}
              >
                <Icon name="arrow.down" size={17} weight="semibold" color={theme.color.text} />
              </Pressable>
            </Glass>
          ) : null}

          {approval ? (
            <Glass style={styles.panel}>
              <View style={styles.panelHead}>
                <Icon name="exclamationmark.shield.fill" size={15} color={theme.color.warn} />
                <Text style={[styles.panelTitle, { color: theme.color.text }]} numberOfLines={1}>
                  {approval.name} wants to run
                </Text>
              </View>
              {toolSummary(approval) ? (
                <Mono numberOfLines={3}>{toolSummary(approval)}</Mono>
              ) : null}
              <View style={styles.panelActions}>
                <Button
                  label="Deny"
                  compact
                  variant="danger"
                  style={styles.flex}
                  onPress={() => onDecide(approval.callId, "deny")}
                />
                <Button
                  label="Approve"
                  compact
                  variant="primary"
                  style={styles.flex}
                  onPress={() => onDecide(approval.callId, "approve")}
                />
              </View>
            </Glass>
          ) : null}

          {editingId ? (
            <Glass style={styles.panel}>
              <View style={styles.panelHead}>
                <Icon name="pencil" size={13} weight="semibold" color={theme.color.accent} />
                <Text style={[styles.editLabel, { color: theme.color.accent }]}>Editing Message</Text>
              </View>
              <TextInput
                value={editingText}
                onChangeText={setEditingText}
                multiline
                autoFocus
                style={[styles.editInput, { color: theme.color.text }]}
              />
              <View style={styles.editActions}>
                <Button label="Cancel" compact onPress={cancelEdit} />
                <Button
                  label="Save & Resend"
                  compact
                  variant="primary"
                  onPress={submitEdit}
                  disabled={!editingText.trim() || chat.busy}
                />
              </View>
            </Glass>
          ) : null}

          {attachments.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.tray}
              keyboardShouldPersistTaps="handled"
            >
              {attachments.map((attachment) => (
                <View key={attachment.uri} style={styles.thumbWrap}>
                  <Image
                    source={{ uri: attachment.previewUri }}
                    style={[styles.thumb, { backgroundColor: theme.color.surfaceAlt }]}
                    accessibilityLabel={attachment.name}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${attachment.name}`}
                    hitSlop={10}
                    onPress={() => {
                      haptics.selection();
                      setAttachments((prev) => prev.filter((a) => a.uri !== attachment.uri));
                    }}
                    style={styles.thumbRemove}
                  >
                    <Glass tint="rgba(0,0,0,0.45)" style={styles.thumbRemoveGlass}>
                      <Icon name="xmark" size={10} weight="bold" color="#ffffff" />
                    </Glass>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}

          {editingId ? null : (
            <GlassGroup spacing={10} style={styles.inputRow}>
              <Glass interactive style={styles.attach}>
                <Menu
                  accessibilityLabel="Attach"
                  fallback={() => void pickImages()}
                  style={styles.fill}
                  items={[
                    {
                      id: "camera",
                      title: "Camera",
                      icon: "camera",
                      onPress: () => void takePhoto(),
                    },
                    {
                      id: "library",
                      title: "Photo Library",
                      icon: "photo.on.rectangle",
                      onPress: () => void pickImages(),
                    },
                  ]}
                >
                  <View
                    style={styles.fill}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel="Attach a photo"
                  >
                    {picking ? (
                      <ActivityIndicator size="small" color={theme.color.textDim} />
                    ) : (
                      <Icon name="plus" size={20} weight="medium" color={theme.color.text} />
                    )}
                  </View>
                </Menu>
              </Glass>

              <Glass style={styles.field}>
                <TextInput
                  value={text}
                  onChangeText={setText}
                  placeholder={chat.busy ? "Responding…" : "Message"}
                  placeholderTextColor={theme.color.textFaint}
                  multiline
                  style={[styles.input, { color: theme.color.text }]}
                  returnKeyType="send"
                  submitBehavior="submit"
                  onSubmitEditing={() => void submit()}
                />
                {chat.busy ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Stop generating"
                    onPress={() => {
                      haptics.tap();
                      chat.stop();
                    }}
                    hitSlop={8}
                    style={[styles.send, { backgroundColor: theme.color.text }]}
                  >
                    <Icon name="stop.fill" size={12} color={theme.color.bg} />
                  </Pressable>
                ) : canSend ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Send message"
                    onPress={() => void submit()}
                    hitSlop={8}
                    style={({ pressed }) => [
                      styles.send,
                      { backgroundColor: theme.color.accent },
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Icon name="arrow.up" size={16} weight="bold" color={theme.color.accentText} />
                  </Pressable>
                ) : null}
              </Glass>
            </GlassGroup>
          )}
        </View>
      </KeyboardStickyView>

      <ImageViewer src={viewing} onClose={() => setViewing(null)} />
      <SelectTextSheet text={selecting} onClose={() => setSelecting(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  fill: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  list: { paddingHorizontal: 16, gap: 14 },
  listEmpty: { flexGrow: 1, justifyContent: "center" },
  footer: { gap: 8, paddingTop: 8 },

  title: { alignItems: "center", maxWidth: 240 },
  titleText: { fontSize: 17, fontWeight: "600", letterSpacing: -0.4 },
  subtitleRow: { flexDirection: "row", alignItems: "center", gap: 3 },
  subtitleText: { fontSize: 12, fontWeight: "500", flexShrink: 1 },

  composerDock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  composer: { paddingHorizontal: 12, paddingTop: 8, gap: 8 },
  jump: {
    alignSelf: "center",
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  panel: { borderRadius: 24, padding: 14, gap: 8 },
  panelHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  panelTitle: { flex: 1, fontSize: 15, fontWeight: "600" },
  panelActions: { flexDirection: "row", gap: 8 },
  editLabel: { fontSize: 13, fontWeight: "600" },
  editInput: { minHeight: 60, maxHeight: 160, fontSize: 17, textAlignVertical: "top" },
  editActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  tray: { gap: 8, paddingTop: 6, paddingRight: 6 },
  thumbWrap: { width: 64, height: 64 },
  thumb: { width: 64, height: 64, borderRadius: 14 },
  thumbRemove: { position: "absolute", top: -6, right: -6 },
  thumbRemoveGlass: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  attach: { width: 44, height: 44, borderRadius: 22 },
  field: {
    flex: 1,
    minHeight: 44,
    borderRadius: 22,
    flexDirection: "row",
    alignItems: "flex-end",
    paddingLeft: 16,
    paddingRight: 6,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    fontSize: 17,
    paddingTop: 11,
    paddingBottom: 11,
  },
  send: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginBottom: 6,
    marginLeft: 6,
    alignItems: "center",
    justifyContent: "center",
  },
});
