/**
 * Conversation list.
 *
 * Rename and delete are per-row and confirmed in place, rather than behind a
 * long-press context menu: a hidden gesture on a list you tap to navigate is a
 * good way to destroy a conversation by accident.
 */

import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SessionSummary } from "../api";
import { formatTokens } from "../tokens";
import { useTheme } from "../theme";
import type { ChatStore } from "../useChat";
import { Badge, Button, Empty } from "../ui/controls";

function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

export default function SessionsScreen({
  chat,
  onOpenChat,
}: {
  chat: ChatStore;
  onOpenChat: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void chat.refreshSessions().catch(() => undefined);
    // Deliberately boot-only: the screen is mounted once and kept mounted, so
    // refreshing on every render would fight the chat screen's own refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await chat.refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [chat]);

  const open = useCallback(
    async (id: string) => {
      try {
        await chat.openSession(id);
        onOpenChat();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [chat, onOpenChat],
  );

  const commitRename = useCallback(async () => {
    if (!renamingId) return;
    const id = renamingId;
    const title = renameText.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      await chat.renameSession(id, title);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [renamingId, renameText, chat]);

  const confirmDelete = useCallback(async () => {
    if (!confirmingId) return;
    const id = confirmingId;
    setConfirmingId(null);
    try {
      await chat.deleteSession(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [confirmingId, chat]);

  const renderItem = useCallback(
    ({ item }: { item: SessionSummary }) => {
      const active = item.id === chat.sessionId;
      const tokens = item.usage
        ? formatTokens(
            item.usage.totalTokens && item.usage.totalTokens > 0
              ? item.usage.totalTokens
              : (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0),
          )
        : "";

      return (
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.color.surface,
              borderColor: active ? theme.color.accent : theme.color.border,
            },
          ]}
        >
          {renamingId === item.id ? (
            <View style={styles.renameRow}>
              <TextInput
                value={renameText}
                onChangeText={setRenameText}
                autoFocus
                style={[styles.renameInput, { color: theme.color.text, borderColor: theme.color.border }]}
                onSubmitEditing={() => void commitRename()}
              />
              <Button label="Save" compact variant="primary" onPress={() => void commitRename()} />
            </View>
          ) : confirmingId === item.id ? (
            <View style={styles.confirmRow}>
              <Text style={[styles.confirmText, { color: theme.color.text }]} numberOfLines={2}>
                Delete this conversation?
              </Text>
              <View style={styles.confirmButtons}>
                <Button label="Cancel" compact onPress={() => setConfirmingId(null)} />
                <Button
                  label="Delete"
                  compact
                  variant="danger"
                  onPress={() => void confirmDelete()}
                />
              </View>
            </View>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => void open(item.id)}
                style={styles.cardMain}
              >
                <Text
                  style={[styles.title, { color: theme.color.text }]}
                  numberOfLines={2}
                >
                  {item.title}
                </Text>
                <View style={styles.metaRow}>
                  <Text style={[styles.meta, { color: theme.color.textFaint }]}>
                    {item.messageCount} {item.messageCount === 1 ? "message" : "messages"} ·{" "}
                    {relativeTime(item.updatedAt)}
                  </Text>
                  {tokens ? (
                    <Badge label={`${tokens} tokens`} />
                  ) : null}
                </View>
              </Pressable>
              <View style={styles.cardActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Rename ${item.title}`}
                  hitSlop={8}
                  onPress={() => {
                    setRenameText(item.title);
                    setRenamingId(item.id);
                  }}
                >
                  <Text style={[styles.action, { color: theme.color.accent }]}>Rename</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${item.title}`}
                  hitSlop={8}
                  onPress={() => setConfirmingId(item.id)}
                >
                  <Text style={[styles.action, { color: theme.color.danger }]}>Delete</Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      );
    },
    [
      theme,
      chat.sessionId,
      renamingId,
      renameText,
      confirmingId,
      open,
      commitRename,
      confirmDelete,
    ],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.color.bg }]}>
      <FlatList
        data={chat.sessions}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={[styles.heading, { color: theme.color.text }]}>Conversations</Text>
            <Button label="New chat" variant="primary" onPress={() => void chat.newChat()} />
            {error ? (
              <Text style={[styles.error, { color: theme.color.danger }]}>{error}</Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          chat.ready ? (
            <Empty
              title="No conversations yet"
              detail="Send a message to start one."
            />
          ) : (
            <ActivityIndicator color={theme.color.textFaint} />
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { padding: 16, gap: 10 },
  header: { gap: 12, marginBottom: 6, alignItems: "flex-start" },
  heading: { fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  error: { fontSize: 13 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  cardMain: { padding: 14, gap: 6 },
  title: { fontSize: 16, fontWeight: "600" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  meta: { fontSize: 12 },
  cardActions: {
    flexDirection: "row",
    gap: 20,
    paddingHorizontal: 14,
    paddingBottom: 12,
  },
  action: { fontSize: 13, fontWeight: "600" },
  renameRow: { padding: 12, gap: 10 },
  confirmRow: { padding: 12, gap: 10 },
  confirmButtons: { flexDirection: "row", gap: 8 },
  renameInput: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  confirmText: { fontSize: 15, flex: 1 },
});
