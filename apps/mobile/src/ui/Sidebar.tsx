/**
 * iOS sidebar: the conversation list.
 *
 * On iPad / wide windows this sits beside the detail in a split view; on
 * iPhone it slides over as a drawer. Either way it is the same inset-grouped
 * language as iOS Mail and Settings: grey ground, search field, filled New
 * Chat button, plain rows with the active one tinted, Settings in the footer.
 *
 * Rename and delete stay per-row and confirmed in place — a hidden gesture on
 * a list you tap to navigate is a good way to destroy a conversation.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { SessionSummary } from "../api";
import { useTheme } from "../theme";
import { formatTokens } from "../tokens";
import type { ChatStore } from "../useChat";
import { Button } from "./controls";

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

export default function Sidebar({
  chat,
  onSelect,
  onNewChat,
  onOpenSettings,
  settingsActive,
}: {
  chat: ChatStore;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  settingsActive: boolean;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void chat.refreshSessions().catch(() => undefined);
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
      setError(null);
      try {
        await chat.openSession(id);
        onSelect(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [chat, onSelect],
  );

  const create = useCallback(async () => {
    setError(null);
    try {
      await chat.newChat();
      onNewChat();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [chat, onNewChat]);

  const commitRename = useCallback(async () => {
    if (!renamingId) return;
    const id = renamingId;
    const title = renameText.trim();
    setRenamingId(null);
    setMenuId(null);
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
    setMenuId(null);
    try {
      await chat.deleteSession(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [confirmingId, chat]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return chat.sessions;
    return chat.sessions.filter((s) => s.title.toLowerCase().includes(needle));
  }, [chat.sessions, query]);

  const renderItem = useCallback(
    ({ item }: { item: SessionSummary }) => {
      const active = item.id === chat.sessionId && !settingsActive;
      const tokens = item.usage
        ? formatTokens(
            item.usage.totalTokens && item.usage.totalTokens > 0
              ? item.usage.totalTokens
              : (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0),
          )
        : "";
      const menuOpen = menuId === item.id;

      return (
        <View
          style={[
            styles.row,
            active && { backgroundColor: `${theme.color.accent}1a` },
            menuOpen && !active && { backgroundColor: theme.color.surface },
          ]}
        >
          <View style={styles.rowTop}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.title}
              onPress={() => void open(item.id)}
              style={styles.rowMain}
            >
              <Text
                style={[
                  styles.rowTitle,
                  { color: theme.color.text },
                  active && { color: theme.color.text },
                ]}
                numberOfLines={1}
              >
                {item.title}
              </Text>
              <Text style={[styles.rowMeta, { color: theme.color.textDim }]} numberOfLines={1}>
                {item.messageCount} {item.messageCount === 1 ? "message" : "messages"} ·{" "}
                {relativeTime(item.updatedAt)}
                {tokens ? ` · ${tokens}` : ""}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`More actions for ${item.title}`}
              hitSlop={10}
              onPress={() => {
                setConfirmingId(null);
                setRenamingId(null);
                setMenuId(menuOpen ? null : item.id);
              }}
              style={styles.more}
            >
              <Text style={[styles.moreGlyph, { color: theme.color.textFaint }]}>…</Text>
            </Pressable>
          </View>

          {renamingId === item.id ? (
            <View style={styles.inlineEdit}>
              <TextInput
                value={renameText}
                onChangeText={setRenameText}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => void commitRename()}
                style={[
                  styles.renameInput,
                  {
                    color: theme.color.text,
                    backgroundColor: theme.color.surfaceAlt,
                  },
                ]}
              />
              <View style={styles.inlineActions}>
                <Pressable
                  onPress={() => {
                    setRenamingId(null);
                    setMenuId(null);
                  }}
                  hitSlop={8}
                >
                  <Text style={[styles.inlineAction, { color: theme.color.textDim }]}>Cancel</Text>
                </Pressable>
                <Pressable onPress={() => void commitRename()} hitSlop={8}>
                  <Text style={[styles.inlineAction, styles.inlineActionBold, { color: theme.color.accent }]}>
                    Save
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : confirmingId === item.id ? (
            <View style={styles.inlineEdit}>
              <Text style={[styles.confirmText, { color: theme.color.text }]}>
                Delete this conversation?
              </Text>
              <View style={styles.inlineActions}>
                <Pressable onPress={() => setConfirmingId(null)} hitSlop={8}>
                  <Text style={[styles.inlineAction, { color: theme.color.textDim }]}>Cancel</Text>
                </Pressable>
                <Pressable onPress={() => void confirmDelete()} hitSlop={8}>
                  <Text style={[styles.inlineAction, styles.inlineActionBold, { color: theme.color.danger }]}>
                    Delete
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : menuOpen ? (
            <View style={styles.inlineActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Rename ${item.title}`}
                hitSlop={8}
                onPress={() => {
                  setRenameText(item.title);
                  setRenamingId(item.id);
                  setConfirmingId(null);
                }}
              >
                <Text style={[styles.inlineAction, { color: theme.color.accent }]}>Rename</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete ${item.title}`}
                hitSlop={8}
                onPress={() => {
                  setConfirmingId(item.id);
                  setRenamingId(null);
                }}
              >
                <Text style={[styles.inlineAction, { color: theme.color.danger }]}>Delete</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      );
    },
    [
      theme,
      chat.sessionId,
      settingsActive,
      menuId,
      renamingId,
      renameText,
      confirmingId,
      open,
      commitRename,
      confirmDelete,
    ],
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.color.grouped }]}>
      <View style={styles.header}>
        <Text style={[styles.heading, { color: theme.color.text }]}>Chats</Text>
        <View style={[styles.search, { backgroundColor: theme.color.surfaceAlt }]}>
          <Text style={[styles.searchGlyph, { color: theme.color.textFaint }]}>⌕</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search"
            placeholderTextColor={theme.color.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            style={[styles.searchInput, { color: theme.color.text }]}
          />
        </View>
        <Button label="＋  New Chat" variant="primary" onPress={() => void create()} />
        {error ? (
          <Text style={[styles.error, { color: theme.color.danger }]}>{error}</Text>
        ) : null}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.color.textFaint }]}>
            {query ? `No chats match “${query}”.` : "No conversations yet."}
          </Text>
        }
        keyboardShouldPersistTaps="handled"
      />

      <View style={[styles.footer, { borderTopColor: theme.color.hairline }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open Settings"
          onPress={onOpenSettings}
          style={({ pressed }) => [
            styles.settingsRow,
            settingsActive && { backgroundColor: `${theme.color.accent}1a` },
            pressed && { opacity: 0.6 },
          ]}
        >
          <View style={[styles.gear, { backgroundColor: theme.color.surfaceAlt }]}>
            <Text style={[styles.gearGlyph, { color: theme.color.textDim }]}>⚙︎</Text>
          </View>
          <Text style={[styles.settingsLabel, { color: theme.color.text }]}>Settings</Text>
          <Text style={[styles.disclosure, { color: theme.color.textFaint }]}>›</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  heading: { fontSize: 28, fontWeight: "800", letterSpacing: -0.6 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 10,
    paddingHorizontal: 10,
    minHeight: 36,
  },
  searchGlyph: { fontSize: 16 },
  searchInput: { flex: 1, fontSize: 17, paddingVertical: 7 },
  error: { fontSize: 13 },
  list: { paddingHorizontal: 12, paddingBottom: 16, gap: 2 },
  row: { borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10 },
  rowTop: { flexDirection: "row", alignItems: "center" },
  rowMain: { flex: 1, gap: 1, paddingVertical: 4 },
  rowTitle: { fontSize: 16, fontWeight: "600", letterSpacing: -0.2 },
  rowMeta: { fontSize: 13 },
  more: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  moreGlyph: { fontSize: 20, fontWeight: "700", lineHeight: 20 },
  inlineActions: { flexDirection: "row", gap: 20, paddingVertical: 6, paddingLeft: 2 },
  inlineAction: { fontSize: 14, fontWeight: "500" },
  inlineActionBold: { fontWeight: "600" },
  inlineEdit: { gap: 8, paddingVertical: 6 },
  renameInput: { minHeight: 36, borderRadius: 8, paddingHorizontal: 10, fontSize: 16 },
  confirmText: { fontSize: 14 },
  empty: { fontSize: 15, textAlign: "center", paddingVertical: 32 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 12 },
  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    minHeight: 48,
  },
  gear: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  gearGlyph: { fontSize: 17 },
  settingsLabel: { flex: 1, fontSize: 16, fontWeight: "500" },
  disclosure: { fontSize: 20, fontWeight: "400" },
});
