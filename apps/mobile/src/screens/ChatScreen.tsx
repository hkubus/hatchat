/**
 * The conversation: iOS navigation bar on top, transcript in the middle,
 * Messages-style composer at the bottom.
 *
 * The composer lives outside the scrolling list. On a phone the keyboard takes
 * most of the screen, and a composer that scrolls away with the transcript is
 * unusable — you would be re-focusing it after every reply.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import { usageTotal } from "@hat/core";
import { isAcceptedImageType } from "../api";
import { capSummary, capTags } from "../capTags";
import { Glass } from "../Glass";
import { useTheme } from "../theme";
import { formatTokens, usageDetail } from "../tokens";
import type { ChatStore, PendingAttachment } from "../useChat";
import { Badge, Banner, Button, Empty, Segmented } from "../ui/controls";
import MessageRow from "../ui/MessageRow";
import ModelPickerBar from "../ui/ModelPickerBar";
import NavBar, { NavButton } from "../ui/NavBar";

/** How close to the bottom the list has to be to keep following the stream. */
const NEAR_BOTTOM_PX = 96;

export default function ChatScreen({
  chat,
  showMenuButton,
  onMenu,
  onNewChat,
}: {
  chat: ChatStore;
  showMenuButton: boolean;
  onMenu: () => void;
  onNewChat: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList>(null);
  const stickToBottom = useRef(true);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [modelOpen, setModelOpen] = useState(false);

  // In-flight messages sit after the stored ones. There is more than one when
  // the turn called tools: the model emits a separate assistant message per
  // iteration, and each holds the tool calls made in it.
  const data = useMemo(
    () => [...chat.messages, ...chat.inFlight],
    [chat.messages, chat.inFlight],
  );

  const scrollToEnd = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  useEffect(() => {
    // Follow the stream only while the reader is already at the bottom, so
    // scrolling up to re-read something is not fought by every delta.
    if (stickToBottom.current) listRef.current?.scrollToEnd({ animated: false });
  }, [chat.messages, chat.inFlight]);

  const onScroll = useCallback((event: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    stickToBottom.current =
      contentSize.height - (contentOffset.y + layoutMeasurement.height) < NEAR_BOTTOM_PX;
  }, []);

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
      });
      if (result.canceled) return;

      // Most camera-roll photos on iOS come back as HEIC, which the server
      // rejects: it reads dimensions from the file header and only parses
      // PNG/JPEG/GIF/WebP. Saying so here, before the upload, is far kinder than
      // a 415 after the user has composed a message.
      const rejected = result.assets.filter((a) => !isAcceptedImageType(a.mimeType));
      const usable = result.assets.filter((a) => isAcceptedImageType(a.mimeType));

      if (rejected.length > 0) {
        chat.reportError(
          rejected.length === result.assets.length
            ? `The server only accepts PNG, JPEG, GIF, and WebP. ${rejected.length === 1 ? "That image is" : "Those images are"} a format it cannot read — re-share as JPEG from the Photos app.`
            : `Skipped ${rejected.length} image${rejected.length === 1 ? "" : "s"} in an unsupported format. The server accepts PNG, JPEG, GIF, and WebP.`,
        );
      }

      if (usable.length > 0) {
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
    } finally {
      setPicking(false);
    }
  }, [chat.reportError]);

  const submit = useCallback(async () => {
    const body = text.trim();
    if ((!body && attachments.length === 0) || chat.busy) return;
    setText("");
    const pending = attachments;
    setAttachments([]);
    stickToBottom.current = true;
    scrollToEnd();
    await chat.send(body, pending);
  }, [text, attachments, chat]);

  const submitEdit = useCallback(async () => {
    if (!editingId) return;
    const id = editingId;
    const body = editingText;
    setEditingId(null);
    setEditingText("");
    await chat.editMessage(id, body);
  }, [editingId, editingText, chat]);

  const newChat = useCallback(() => {
    void chat.newChat().catch(() => undefined);
    onNewChat();
  }, [chat, onNewChat]);

  const capabilitiesLabel = chat.selectedModel ? capSummary(chat.selectedModel) : undefined;

  // Capability chips for the selected model, shown in the composer the way the
  // web app does. They are the quickest way to see why a model is refusing to
  // call a tool or read an image.
  const capabilityTags = chat.selectedModel
    ? capTags(chat.selectedModel.capabilities, chat.selectedModel.contextWindow)
    : [];

  const renderItem = useCallback(
    ({ item }: { item: (typeof data)[number] }) => (
      <MessageRow
        message={item}
        streaming={item.streaming === true}
        onRegenerate={chat.regenerate}
        onEdit={(messageId) => {
          setEditingId(messageId);
          setEditingText(chat.messages.find((m) => m.id === messageId)?.text ?? "");
        }}
        onSwitchBranch={(siblingId) => void chat.switchBranch(siblingId)}
        onDecide={chat.decide}
        onAnswer={chat.answer}
        busy={chat.busy}
      />
    ),
    [chat],
  );

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !chat.busy;

  // `chat.sessionUsage` already folds in the turn in flight, so this is the
  // whole branch's cost with no extra bookkeeping here.
  const sessionTokens = formatTokens(usageTotal(chat.sessionUsage));

  const sessionTitle =
    chat.sessions.find((s) => s.id === chat.sessionId)?.title ??
    chat.session?.title ??
    "New Chat";
  const modelLabel = chat.selectedModel?.label ?? chat.model;

  return (
    <View style={[styles.root, { backgroundColor: theme.color.bg }]}>
      <NavBar
        title={sessionTitle}
        subtitle={modelLabel}
        onTitlePress={() => setModelOpen(true)}
        leading={
          showMenuButton ? (
            <NavButton label="☰" accessibilityLabel="Open chats" onPress={onMenu} />
          ) : undefined
        }
        trailing={<NavButton label="✎" accessibilityLabel="New chat" onPress={newChat} />}
      />

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={data}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          onScroll={onScroll}
          scrollEventThrottle={64}
          onContentSizeChange={() => {
            if (stickToBottom.current) scrollToEnd();
          }}
          contentContainerStyle={[
            styles.list,
            data.length === 0 && styles.listEmpty,
            { paddingBottom: 12 },
          ]}
          ListEmptyComponent={
            chat.ready ? (
              <Empty
                title="Start a conversation"
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

        {/* Bottom chrome — Messages-style toolbar. The glass sits behind the
            controls (which stay solid) so the transcript blurs through the
            gaps, including over the home-indicator area. */}
        <Glass intensity={70} style={[styles.chrome, { borderTopColor: theme.color.hairline }]}>
        {editingId ? (
          <View
            style={[
              styles.editBar,
              { backgroundColor: theme.color.surface, borderColor: theme.color.hairline },
            ]}
          >
            <Text style={[styles.editLabel, { color: theme.color.textDim }]}>Editing message</Text>
            <TextInput
              value={editingText}
              onChangeText={setEditingText}
              multiline
              style={[styles.editInput, { color: theme.color.text }]}
            />
            <View style={styles.editActions}>
              <Button
                label="Cancel"
                compact
                onPress={() => {
                  setEditingId(null);
                  setEditingText("");
                }}
              />
              <Button
                label="Save & resend"
                compact
                variant="primary"
                onPress={submitEdit}
                disabled={!editingText.trim() || chat.busy}
              />
            </View>
          </View>
        ) : null}

        {attachments.length > 0 ? (
          <View style={styles.chips}>
            {attachments.map((attachment) => (
              <Pressable
                key={attachment.uri}
                accessibilityRole="button"
                accessibilityLabel="Remove attachment"
                onPress={() =>
                  setAttachments((prev) => prev.filter((a) => a.uri !== attachment.uri))
                }
                style={[styles.chip, { backgroundColor: theme.color.surfaceAlt }]}
              >
                <Text style={[styles.chipText, { color: theme.color.text }]} numberOfLines={1}>
                  {attachment.name}
                </Text>
                <Text style={[styles.chipX, { color: theme.color.textDim }]}>✕</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View
          style={[
            styles.composer,
            {
              paddingBottom: Math.max(insets.bottom, 8),
            },
          ]}
        >
          <View style={styles.inputRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Attach an image"
              onPress={() => void pickImages()}
              disabled={picking}
              hitSlop={8}
              style={({ pressed }) => [styles.attachHit, pressed && { opacity: 0.5 }]}
            >
              {picking ? (
                <ActivityIndicator size="small" color={theme.color.textDim} />
              ) : (
                <View style={[styles.attachCircle, { backgroundColor: theme.color.surfaceAlt }]}>
                  <Text style={[styles.attachGlyph, { color: theme.color.textDim }]}>＋</Text>
                </View>
              )}
            </Pressable>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Message"
              placeholderTextColor={theme.color.textFaint}
              multiline
              style={[styles.input, { color: theme.color.text, backgroundColor: theme.color.surfaceAlt }]}
              returnKeyType="send"
              onSubmitEditing={() => void submit()}
            />
            {chat.busy ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Stop generating"
                onPress={chat.stop}
                hitSlop={8}
                style={styles.sendHit}
              >
                <View style={[styles.sendCircle, { backgroundColor: theme.color.danger }]}>
                  <Text style={styles.stopGlyph}>■</Text>
                </View>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send message"
                onPress={() => void submit()}
                disabled={!canSend}
                hitSlop={8}
                style={styles.sendHit}
              >
                <View
                  style={[
                    styles.sendCircle,
                    { backgroundColor: canSend ? theme.color.accent : theme.color.surfaceAlt },
                  ]}
                >
                  <Text
                    style={[
                      styles.sendGlyph,
                      { color: canSend ? "#ffffff" : theme.color.textFaint },
                    ]}
                  >
                    ↑
                  </Text>
                </View>
              </Pressable>
            )}
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.toolbar}
            keyboardShouldPersistTaps="handled"
          >
            {chat.selectedModel?.capabilities.reasoningEffort ? (
              <Segmented
                value={chat.reasoningEffort}
                onChange={chat.setEffort}
                style={styles.toolbarSegment}
                options={[
                  { value: "off", label: "off" },
                  { value: "low", label: "low" },
                  { value: "medium", label: "med" },
                  { value: "high", label: "high" },
                ]}
              />
            ) : null}
            <Segmented
              value={chat.policyMode}
              onChange={chat.setPolicyMode}
              style={styles.toolbarSegmentWide}
              options={[
                { value: "ask", label: "ask" },
                { value: "auto", label: "auto" },
                { value: "allowlist", label: "allow" },
                { value: "deny", label: "deny" },
              ]}
            />
            {capabilityTags.length > 0 ? (
              <View
                style={styles.caps}
                accessibilityLabel={`Model capabilities: ${capabilitiesLabel}`}
              >
                {capabilityTags.map((tag) => (
                  <Badge key={tag.key} label={tag.label} title={tag.title} />
                ))}
              </View>
            ) : null}
            {sessionTokens ? (
              <Text style={[styles.tokens, { color: theme.color.textFaint }]}>
                {sessionTokens} · {usageDetail(chat.sessionUsage)}
              </Text>
            ) : null}
          </ScrollView>
        </View>
        </Glass>
      </KeyboardAvoidingView>

      <ModelPickerBar
        models={chat.models}
        value={chat.model}
        onChange={chat.setModel}
        open={modelOpen}
        onOpenChange={setModelOpen}
        showTrigger={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  list: { paddingHorizontal: 16, paddingTop: 12, gap: 14 },
  listEmpty: { flexGrow: 1, justifyContent: "center" },
  footer: { gap: 8, paddingTop: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: 220,
  },
  chipText: { fontSize: 13, flexShrink: 1 },
  chipX: { fontSize: 12 },
  editBar: { gap: 8, padding: 12, borderTopWidth: StyleSheet.hairlineWidth },
  editLabel: { fontSize: 13, fontWeight: "600" },
  editInput: { minHeight: 72, fontSize: 17, textAlignVertical: "top" },
  editActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  chrome: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  composer: {
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 8,
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  attachHit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  attachCircle: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  attachGlyph: { fontSize: 20, lineHeight: 22 },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 130,
    fontSize: 17,
    borderRadius: 19,
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 9,
  },
  sendHit: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  sendCircle: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  sendGlyph: { fontSize: 17, fontWeight: "700", lineHeight: 20 },
  stopGlyph: { fontSize: 12, fontWeight: "700", color: "#ffffff", lineHeight: 16 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 4 },
  toolbarSegment: { width: 190 },
  toolbarSegmentWide: { width: 250 },
  caps: { flexDirection: "row", alignItems: "center", gap: 6 },
  tokens: { fontSize: 12, fontVariant: ["tabular-nums"] },
});
