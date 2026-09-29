/**
 * The conversation: transcript above, composer below.
 *
 * The composer deliberately lives outside the scrolling list. On a phone the
 * keyboard takes most of the screen, and a composer that scrolls away with the
 * transcript is unusable — you would be re-focusing it after every reply.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import { usageTotal } from "@hat/core";
import { capSummary, capTags } from "../capTags";
import { useTheme } from "../theme";
import { formatTokens, usageDetail } from "../tokens";
import type { ChatStore, PendingAttachment } from "../useChat";
import { Badge, Banner, Button, Empty, Segmented } from "../ui/controls";
import MessageRow from "../ui/MessageRow";
import ModelPickerBar from "../ui/ModelPickerBar";

/** How close to the bottom the list has to be to keep following the stream. */
const NEAR_BOTTOM_PX = 96;

export default function ChatScreen({ chat }: { chat: ChatStore }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList>(null);
  const stickToBottom = useRef(true);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [picking, setPicking] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");

  // The streaming message is appended after the stored ones, so the list needs
  // one extra row for it.
  const data = chat.streaming ? [...chat.messages, chat.streaming] : chat.messages;

  const scrollToEnd = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  useEffect(() => {
    // Follow the stream only while the reader is already at the bottom, so
    // scrolling up to re-read something is not fought by every delta.
    if (stickToBottom.current) listRef.current?.scrollToEnd({ animated: false });
  }, [chat.messages, chat.streaming]);

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
      setAttachments((prev) => [
        ...prev,
        ...result.assets.map((asset) => ({
          uri: asset.uri,
          name: asset.fileName ?? `image-${Date.now()}.jpg`,
          type: asset.mimeType ?? "image/jpeg",
          previewUri: asset.uri,
        })),
      ]);
    } finally {
      setPicking(false);
    }
  }, []);

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
        busy={chat.busy}
      />
    ),
    [chat],
  );

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !chat.busy;

  // `chat.sessionUsage` already folds in the turn in flight, so this is the
  // whole branch's cost with no extra bookkeeping here.
  const sessionTokens = formatTokens(usageTotal(chat.sessionUsage));

  return (
    <View style={[styles.root, { backgroundColor: theme.color.bg }]}>
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
            { paddingBottom: insets.bottom + 12 },
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

        {editingId ? (
          <View
            style={[
              styles.editBar,
              { backgroundColor: theme.color.surface, borderColor: theme.color.border },
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
              backgroundColor: theme.color.surface,
              borderTopColor: theme.color.hairline,
              paddingBottom: Math.max(insets.bottom, 8),
            },
          ]}
        >
          <View style={styles.inputRow}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Message"
              placeholderTextColor={theme.color.textFaint}
              multiline
              style={[styles.input, { color: theme.color.text }]}
              onSubmitEditing={() => void submit()}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Attach an image"
              onPress={() => void pickImages()}
              disabled={picking}
              style={({ pressed }) => [styles.iconButton, pressed && { opacity: 0.6 }]}
            >
              {picking ? (
                <ActivityIndicator size="small" color={theme.color.textDim} />
              ) : (
                <Text style={[styles.icon, { color: theme.color.textDim }]}>＋</Text>
              )}
            </Pressable>
            {chat.busy ? (
              <Button label="Stop" variant="danger" compact onPress={chat.stop} />
            ) : (
              <Button
                label="Send"
                variant="primary"
                compact
                onPress={() => void submit()}
                disabled={!canSend}
              />
            )}
          </View>

          <View style={styles.bar}>
            <ModelPickerBar
              models={chat.models}
              value={chat.model}
              onChange={chat.setModel}
            />
            {chat.selectedModel?.capabilities.reasoningEffort ? (
              <Segmented
                value={chat.reasoningEffort}
                onChange={chat.setEffort}
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
              options={[
                { value: "ask", label: "ask" },
                { value: "auto", label: "auto" },
                { value: "allowlist", label: "allowlist" },
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
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  list: { padding: 12, gap: 14 },
  listEmpty: { flexGrow: 1, justifyContent: "center" },
  footer: { gap: 8, paddingTop: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
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
  editLabel: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6 },
  editInput: { minHeight: 72, fontSize: 16, textAlignVertical: "top" },
  editActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 10,
    gap: 8,
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: { flex: 1, minHeight: 40, maxHeight: 140, fontSize: 16, paddingTop: 10, paddingBottom: 10 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  icon: { fontSize: 24 },
  bar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  caps: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  tokens: { fontSize: 12, fontVariant: ["tabular-nums"] },
});
