/**
 * The conversation list — the root of the stack, as in Messages.
 *
 * Large title that collapses on scroll, the system search field in the bar,
 * inset-grouped sections by date (Today, Yesterday, Previous 7 Days, …), pull
 * to refresh. Settings and New Chat are bar buttons, so on iOS 26 they sit in
 * the system's glass capsules.
 *
 * Rename and delete are where iOS users look for them: swipe a row left, or
 * long-press it for the context menu. Delete is always confirmed in a
 * destructive alert — neither gesture is the only step to destroy a
 * conversation.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import Swipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import * as api from "../api";
import type { SearchHit, SessionSummary } from "../api";
import * as haptics from "../haptics";
import { snippetParts } from "../search";
import { useChatStore } from "../navigation";
import type { ScreenProps } from "../navigation";
import { useTheme } from "../theme";
import { formatTokens } from "../tokens";
import { barItems } from "../ui/barItems";
import { Banner, Button, Empty, SECTION_RADIUS } from "../ui/controls";
import Icon from "../ui/Icon";
import Menu from "../ui/Menu";

const DAY = 24 * 60 * 60 * 1000;

/** `Alert.prompt` is iOS-only; elsewhere rename is simply not offered. */
const CAN_RENAME = Platform.OS === "ios";

/** Typing pauses this long before the server is searched. */
const SEARCH_DEBOUNCE_MS = 300;

/** How often statuses are refreshed while a conversation is running or waiting. */
const STATUS_POLL_MS = 4000;

type Row = SessionSummary | SearchHit;
type Section = { title: string; data: Row[] };

function isHit(row: Row): row is SearchHit {
  return "messageId" in row;
}

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/** The date format Messages and Mail use in their lists. */
function listTime(epochMs: number): string {
  const then = new Date(epochMs);
  const today = startOfToday();
  if (epochMs >= today) {
    return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (epochMs >= today - DAY) return "Yesterday";
  if (epochMs >= today - 6 * DAY) {
    return then.toLocaleDateString(undefined, { weekday: "long" });
  }
  return then.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

/** Section title for a conversation's last activity. */
function bucket(epochMs: number): string {
  const today = startOfToday();
  if (epochMs >= today) return "Today";
  if (epochMs >= today - DAY) return "Yesterday";
  if (epochMs >= today - 7 * DAY) return "Previous 7 Days";
  if (epochMs >= today - 30 * DAY) return "Previous 30 Days";
  return new Date(epochMs).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function sessionTokens(item: SessionSummary): string {
  if (!item.usage) return "";
  const total =
    item.usage.totalTokens && item.usage.totalTokens > 0
      ? item.usage.totalTokens
      : (item.usage.inputTokens ?? 0) + (item.usage.outputTokens ?? 0);
  return formatTokens(total);
}

export default function SessionsScreen({ navigation }: ScreenProps<"Chats">) {
  const theme = useTheme();
  const chat = useChatStore();
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only one row stays swiped open at a time, as in Mail.
  const openRow = useRef<SwipeableMethods | null>(null);
  const rowMethods = useRef(new Map<string, SwipeableMethods>()).current;

  const fail = useCallback((e: unknown) => {
    haptics.error();
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  // Refetched whenever the list comes back into view, so statuses and titles
  // are current after a conversation was used.
  const { refreshSessions } = chat;
  useFocusEffect(
    useCallback(() => {
      void refreshSessions().catch(() => undefined);
    }, [refreshSessions]),
  );

  // Statuses only change on the server, so while something is running or
  // waiting on the user, poll — only while this screen is in view.
  const anyActive = chat.sessions.some((s) => s.status === "running" || s.status === "waiting");
  useFocusEffect(
    useCallback(() => {
      if (!anyActive) return;
      const timer = setInterval(() => void refreshSessions().catch(() => undefined), STATUS_POLL_MS);
      return () => clearInterval(timer);
    }, [anyActive, refreshSessions]),
  );

  // Message search: the title filter below is instant and local; the server's
  // full-text search runs once typing pauses. A newer query aborts the older
  // request, so a slow response can never overwrite a newer one.
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const trimmedQuery = query.trim();
  useEffect(() => {
    if (!trimmedQuery) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.searchMessages(trimmedQuery, controller.signal).then(
        (result) => {
          setHits(result);
          setSearching(false);
        },
        (e: unknown) => {
          if (api.isAbortError(e)) return;
          // Search is an extra; a server without it still filters titles.
          setHits([]);
          setSearching(false);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedQuery]);

  const create = useCallback(async () => {
    setError(null);
    haptics.tap();
    try {
      await chat.newChat();
      navigation.navigate("Chat");
    } catch (e) {
      fail(e);
    }
  }, [chat, navigation, fail]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: "Search",
        autoCapitalize: "none",
        onChangeText: (event) => setQuery(event.nativeEvent.text),
        onCancelButtonPress: () => setQuery(""),
      },
      ...barItems("left", [
        {
          kind: "button",
          label: "Settings",
          icon: "gearshape",
          onPress: () => navigation.navigate("Settings"),
        },
      ]),
      ...barItems("right", [
        { kind: "button", label: "New Chat", icon: "square.and.pencil", onPress: () => void create() },
      ]),
    });
  }, [navigation, create]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await chat.refreshSessions();
    } catch (e) {
      fail(e);
    } finally {
      setRefreshing(false);
    }
  }, [chat, fail]);

  const open = useCallback(
    async (id: string) => {
      openRow.current?.close();
      setError(null);
      setOpening(id);
      try {
        await chat.openSession(id);
        navigation.navigate("Chat");
      } catch (e) {
        fail(e);
      } finally {
        setOpening(null);
      }
    },
    [chat, navigation, fail],
  );

  /** Open the conversation a search hit is in, on the branch that holds it. */
  const openHit = useCallback(
    async (hit: SearchHit) => {
      setError(null);
      setOpening(hit.messageId);
      try {
        await chat.openMessage(hit.sessionId, hit.messageId);
        navigation.navigate("Chat");
      } catch (e) {
        fail(e);
      } finally {
        setOpening(null);
      }
    },
    [chat, navigation, fail],
  );

  const confirmDelete = useCallback(
    (item: SessionSummary) => {
      haptics.warning();
      Alert.alert("Delete Conversation?", `“${item.title}” will be deleted. This can’t be undone.`, [
        { text: "Cancel", style: "cancel", onPress: () => openRow.current?.close() },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => void chat.deleteSession(item.id).catch(fail),
        },
      ]);
    },
    [chat, fail],
  );

  const rename = useCallback(
    (item: SessionSummary) => {
      Alert.prompt(
        "Rename Conversation",
        undefined,
        [
          { text: "Cancel", style: "cancel", onPress: () => openRow.current?.close() },
          {
            text: "Save",
            isPreferred: true,
            onPress: (value?: string) => {
              openRow.current?.close();
              const title = value?.trim();
              if (title) void chat.renameSession(item.id, title).catch(fail);
            },
          },
        ],
        "plain-text",
        item.title,
      );
    },
    [chat, fail],
  );

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle) {
      // Searching reads like Messages: matching conversations, then matching
      // messages from inside them.
      const matches = chat.sessions
        .filter((s) => s.title.toLowerCase().includes(needle))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const found: Section[] = [];
      if (matches.length > 0) found.push({ title: "Conversations", data: matches });
      if (hits.length > 0) found.push({ title: "Messages", data: hits });
      return found;
    }
    const sorted = [...chat.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    const grouped: Section[] = [];
    for (const session of sorted) {
      const title = bucket(session.updatedAt);
      const last = grouped[grouped.length - 1];
      if (last && last.title === title) last.data.push(session);
      else grouped.push({ title, data: [session] });
    }
    return grouped;
  }, [chat.sessions, query, hits]);

  const renderHit = useCallback(
    (hit: SearchHit, first: boolean, last: boolean) => (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${hit.role === "user" ? "Your message" : "Reply"} in ${hit.sessionTitle}: ${snippetParts(hit.snippet)
          .map((part) => part.text)
          .join("")}`}
        accessibilityHint="Opens the conversation at this message."
        onPress={() => void openHit(hit)}
        style={({ pressed }) => [
          styles.row,
          { backgroundColor: pressed ? theme.color.fill : theme.color.surface },
          first && { borderTopLeftRadius: SECTION_RADIUS, borderTopRightRadius: SECTION_RADIUS },
          last && { borderBottomLeftRadius: SECTION_RADIUS, borderBottomRightRadius: SECTION_RADIUS },
        ]}
      >
        <View style={styles.rowBody}>
          <View style={styles.rowLine}>
            <Text style={[styles.rowTitle, { color: theme.color.text }]} numberOfLines={1}>
              {hit.sessionTitle}
            </Text>
            <Text style={[styles.rowTime, { color: theme.color.textDim }]}>{listTime(hit.createdAt)}</Text>
            {opening === hit.messageId ? (
              <ActivityIndicator size="small" color={theme.color.textFaint} />
            ) : (
              <Icon name="chevron.right" size={13} weight="semibold" color={theme.color.textFaint} />
            )}
          </View>
          <Text style={[styles.snippet, { color: theme.color.textDim }]} numberOfLines={2}>
            {hit.role === "user" ? <Text style={styles.snippetRole}>You: </Text> : null}
            {snippetParts(hit.snippet).map((part, i) =>
              part.hit ? (
                <Text key={i} style={[styles.snippetHit, { color: theme.color.text }]}>
                  {part.text}
                </Text>
              ) : (
                part.text
              ),
            )}
          </Text>
        </View>
        {!last ? <View style={[styles.separator, { backgroundColor: theme.color.separator }]} /> : null}
      </Pressable>
    ),
    [theme, opening, openHit],
  );

  const renderItem = useCallback(
    ({ item: row, index, section }: { item: Row; index: number; section: Section }) => {
      const first = index === 0;
      const last = index === section.data.length - 1;
      if (isHit(row)) return renderHit(row, first, last);
      const item = row;
      const tokens = sessionTokens(item);
      const status = item.status === "running" || item.status === "waiting" ? item.status : null;
      const corners = [
        first && { borderTopLeftRadius: SECTION_RADIUS, borderTopRightRadius: SECTION_RADIUS },
        last && { borderBottomLeftRadius: SECTION_RADIUS, borderBottomRightRadius: SECTION_RADIUS },
      ];

      return (
        <Swipeable
          friction={2}
          rightThreshold={40}
          overshootRight={false}
          containerStyle={[styles.swipe, corners]}
          onSwipeableWillOpen={() => {
            haptics.selection();
            const methods = rowMethods.get(item.id);
            if (openRow.current && openRow.current !== methods) openRow.current.close();
            openRow.current = methods ?? null;
          }}
          renderRightActions={(_progress, _translation, methods) => {
            // Captured per row (this renders for every row, open or not), and
            // only promoted to `openRow` when this row actually opens.
            rowMethods.set(item.id, methods);
            return (
              <View style={styles.actions}>
                {CAN_RENAME ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Rename ${item.title}`}
                    onPress={() => rename(item)}
                    style={[styles.action, { backgroundColor: theme.color.textFaint }]}
                  >
                    <Icon name="pencil" size={18} color="#ffffff" />
                    <Text style={styles.actionLabel}>Rename</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${item.title}`}
                  onPress={() => confirmDelete(item)}
                  style={[styles.action, { backgroundColor: theme.color.danger }]}
                >
                  <Icon name="trash" size={18} color="#ffffff" />
                  <Text style={styles.actionLabel}>Delete</Text>
                </Pressable>
              </View>
            );
          }}
        >
          <Menu
            trigger="longPress"
            title={item.title}
            items={[
              ...(CAN_RENAME
                ? [{ id: "rename", title: "Rename", icon: "pencil" as const, onPress: () => rename(item) }]
                : []),
              {
                id: "delete",
                title: "Delete",
                icon: "trash",
                destructive: true,
                onPress: () => confirmDelete(item),
              },
            ]}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                status === "waiting"
                  ? `${item.title}. Needs you`
                  : status === "running"
                    ? `${item.title}. Responding`
                    : item.title
              }
              accessibilityHint="Opens the conversation. Swipe left or long press for more actions."
              accessibilityActions={[
                ...(CAN_RENAME ? [{ name: "rename", label: "Rename" }] : []),
                { name: "delete", label: "Delete" },
              ]}
              onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === "rename") rename(item);
                if (event.nativeEvent.actionName === "delete") confirmDelete(item);
              }}
              onPress={() => void open(item.id)}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.color.fill : theme.color.surface },
              ]}
            >
              <View style={styles.rowBody}>
                <View style={styles.rowLine}>
                  {/* Waiting gets a symbol, not just a colour, so it reads as
                      "needs you" rather than a busier kind of running. Running
                      is grey: red is the tint and also means "error". */}
                  {status === "waiting" ? (
                    <Icon name="exclamationmark.circle.fill" size={15} color={theme.color.warn} />
                  ) : status === "running" ? (
                    <View style={[styles.runningDot, { backgroundColor: theme.color.textDim }]} />
                  ) : null}
                  <Text style={[styles.rowTitle, { color: theme.color.text }]} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text style={[styles.rowTime, { color: theme.color.textDim }]}>
                    {listTime(item.updatedAt)}
                  </Text>
                  {opening === item.id ? (
                    <ActivityIndicator size="small" color={theme.color.textFaint} />
                  ) : (
                    <Icon name="chevron.right" size={13} weight="semibold" color={theme.color.textFaint} />
                  )}
                </View>
                <Text style={[styles.rowMeta, { color: theme.color.textDim }]} numberOfLines={1}>
                  {status === "waiting" ? (
                    <Text style={[styles.rowStatus, { color: theme.color.warn }]}>Needs you · </Text>
                  ) : status === "running" ? (
                    <Text style={[styles.rowStatus, { color: theme.color.text }]}>Responding · </Text>
                  ) : null}
                  {item.messageCount} {item.messageCount === 1 ? "message" : "messages"}
                  {tokens ? ` · ${tokens} tokens` : ""}
                </Text>
              </View>
              {!last ? (
                <View style={[styles.separator, { backgroundColor: theme.color.separator }]} />
              ) : null}
            </Pressable>
          </Menu>
        </Swipeable>
      );
    },
    [theme, opening, open, rename, confirmDelete, rowMethods, renderHit],
  );

  return (
    <SectionList
      style={{ backgroundColor: theme.color.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      sections={sections}
      keyExtractor={(item) => (isHit(item) ? `hit:${item.messageId}` : item.id)}
      renderItem={renderItem}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <Text style={[styles.sectionTitle, { color: theme.color.textDim }]}>{section.title}</Text>
      )}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      onScrollBeginDrag={() => openRow.current?.close()}
      ListHeaderComponent={
        error ? (
          <View style={styles.banner}>
            <Banner tone="error" title="Something went wrong" detail={error} onDismiss={() => setError(null)} />
          </View>
        ) : null
      }
      ListEmptyComponent={
        trimmedQuery ? (
          searching ? (
            <ActivityIndicator style={styles.loading} color={theme.color.textFaint} />
          ) : (
            <Empty title="No Results" detail={`No conversations or messages match “${trimmedQuery}”.`} />
          )
        ) : chat.ready ? (
          <View style={styles.empty}>
            <Empty
              title="No Conversations"
              detail="Conversations you start on this server show up here."
            />
            <Button label="Start a Chat" variant="primary" onPress={() => void create()} />
          </View>
        ) : (
          <ActivityIndicator style={styles.loading} color={theme.color.textFaint} />
        )
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  banner: { paddingTop: 8 },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.4,
    paddingHorizontal: 4,
    paddingTop: 22,
    paddingBottom: 8,
  },
  swipe: { overflow: "hidden" },
  actions: { flexDirection: "row" },
  action: { width: 78, alignItems: "center", justifyContent: "center", gap: 4 },
  actionLabel: { color: "#ffffff", fontSize: 13, fontWeight: "500" },
  row: { paddingLeft: 16 },
  rowBody: { paddingVertical: 11, paddingRight: 14, gap: 2 },
  rowLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowTitle: { flex: 1, fontSize: 17, fontWeight: "600", letterSpacing: -0.4 },
  rowTime: { fontSize: 15 },
  rowMeta: { fontSize: 15 },
  rowStatus: { fontWeight: "600" },
  runningDot: { width: 9, height: 9, borderRadius: 4.5 },
  snippet: { fontSize: 15, lineHeight: 20 },
  snippetRole: { fontWeight: "500" },
  snippetHit: { fontWeight: "600" },
  separator: { height: StyleSheet.hairlineWidth },
  empty: { alignItems: "center", gap: 8 },
  loading: { paddingVertical: 48 },
});
