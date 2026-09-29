import { Fragment, useEffect, useRef, useState } from "react";
import { usageTotal } from "@hat/core";
import type { SearchHit, SessionSummary } from "./api";
import { isAbortError, searchMessages } from "./api";
import { EditIcon, GearIcon, HatMark, ImportIcon, PlusIcon, SearchIcon, SignOutIcon, TrashIcon } from "./icons";
import { groupSessions, timeAgo } from "./sessionGroups";
import { formatTokens } from "./tokens";

interface SidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  view: "chat" | "settings";
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onView: (view: "chat" | "settings") => void;
  onLogout?: () => void;
  /** Open a search hit: its conversation, on the branch holding the message. */
  onOpenHit: (hit: SearchHit) => void;
  onImport: (file: File) => void;
}

/** `«hit»` markers from the server's snippet, rendered as <mark>. */
function Snippet({ text }: { text: string }): JSX.Element {
  const pieces = text.split(/«|»/);
  return (
    <>
      {pieces.map((piece, index) =>
        index % 2 === 1 ? <mark key={index}>{piece}</mark> : <Fragment key={index}>{piece}</Fragment>,
      )}
    </>
  );
}

/** Full-text search over message contents, debounced; empty below two characters. */
function useMessageSearch(query: string): { hits: SearchHit[]; searching: boolean } {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      searchMessages(q, controller.signal)
        .then(setHits)
        .catch((e: unknown) => {
          if (!isAbortError(e)) setHits([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return { hits, searching };
}

const STATUS_LABEL = { running: "Working…", waiting: "Needs your input" } as const;

export default function Sidebar({
  sessions,
  activeId,
  view,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onView,
  onLogout,
  onOpenHit,
  onImport,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const { hits, searching } = useMessageSearch(query);
  const importInput = useRef<HTMLInputElement>(null);
  const needle = query.trim().toLowerCase();
  const visible = needle ? sessions.filter((s) => s.title.toLowerCase().includes(needle)) : sessions;
  const { live, groups } = groupSessions(visible);

  function commit(): void {
    const title = draft.trim();
    if (editingId && title) onRename(editingId, title);
    setEditingId(null);
  }

  /**
   * One conversation. Idle ones are a single line (title, age); busy ones get a
   * second line saying what they are waiting on, so they can be spotted from
   * across the list.
   */
  function renderRow(session: SessionSummary): JSX.Element {
    const busy = session.status && session.status !== "idle" ? session.status : null;
    const tokens = formatTokens(usageTotal(session.usage ?? undefined));
    const detail = [
      `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`,
      tokens && `${tokens} tokens`,
    ]
      .filter(Boolean)
      .join(" · ");
    const active = session.id === activeId && view === "chat";
    return (
      <div
        key={session.id}
        className={`session-item ${active ? "active" : ""} ${busy ? `live ${busy}` : ""}`}
      >
        {editingId === session.id ? (
          <input
            className="session-rename"
            autoFocus
            value={draft}
            aria-label="Session title"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditingId(null);
            }}
          />
        ) : confirmingId === session.id ? (
          /* Delete is destructive and irreversible, so it is confirmed in
             place rather than through a blocking native dialog. */
          <div className="session-confirm" role="group" aria-label="Confirm delete">
            <span className="session-confirm-text">Delete?</span>
            <button
              className="danger tiny"
              onClick={() => {
                setConfirmingId(null);
                onDelete(session.id);
              }}
            >
              Delete
            </button>
            <button className="ghost tiny" onClick={() => setConfirmingId(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button
              className="session-open"
              onClick={() => onSelect(session.id)}
              title={`${session.title}\n${detail}`}
            >
              <span className="session-line">
                {busy && <span className={`session-status ${busy}`} aria-hidden="true" />}
                <span className="session-title">{session.title}</span>
                {!busy && <span className="session-time">{timeAgo(session.updatedAt)}</span>}
              </span>
              {busy && <span className="session-state">{STATUS_LABEL[busy]}</span>}
            </button>
            <div className="session-actions">
              <button
                className="icon-btn"
                title="Rename"
                aria-label={`Rename ${session.title}`}
                onClick={() => {
                  setEditingId(session.id);
                  setDraft(session.title);
                }}
              >
                <EditIcon />
              </button>
              <button
                className="icon-btn"
                title="Delete"
                aria-label={`Delete ${session.title}`}
                onClick={() => setConfirmingId(session.id)}
              >
                <TrashIcon />
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-brand">
          <HatMark className="brand-mark" />
          Hat
        </span>
        <button className="new-chat" onClick={onNew} title="New chat" aria-label="New chat">
          <PlusIcon />
        </button>
      </div>

      <div className="session-search">
        <SearchIcon className="session-search-icon" />
        <input
          type="search"
          value={query}
          placeholder="Search"
          aria-label="Search conversations"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
      </div>

      <nav className="session-list">
        {sessions.length === 0 && <div className="session-empty">No conversations yet</div>}
        {needle && visible.length === 0 && hits.length === 0 && !searching && sessions.length > 0 && (
          <div className="session-empty">No matches</div>
        )}
        {needle ? (
          <>
            {visible.length > 0 && <div className="session-group">Titles</div>}
            {visible.map(renderRow)}
          </>
        ) : (
          <>
            {live.length > 0 && (
              <div className="session-live">
                <div className="session-group">Active</div>
                {live.map(renderRow)}
              </div>
            )}
            {groups.map((group) => (
              <Fragment key={group.label}>
                <div className="session-group">{group.label}</div>
                {group.sessions.map(renderRow)}
              </Fragment>
            ))}
          </>
        )}
        {needle && hits.length > 0 && <div className="session-group">Messages</div>}
        {needle &&
          hits.map((hit) => (
            <button
              key={hit.messageId}
              className="search-hit"
              onClick={() => onOpenHit(hit)}
              title={`Open "${hit.sessionTitle}" at this message`}
            >
              <span className="session-title">{hit.sessionTitle}</span>
              <span className="search-snippet">
                <span className="search-role">{hit.role === "user" ? "You" : "Assistant"}:</span>{" "}
                <Snippet text={hit.snippet} />
              </span>
            </button>
          ))}
      </nav>

      <div className="sidebar-foot">
        <button
          className={`side-btn ${view === "settings" ? "active" : ""}`}
          onClick={() => onView(view === "settings" ? "chat" : "settings")}
          aria-label="Settings"
        >
          <GearIcon />
          Settings
        </button>
        <button
          className="icon-btn"
          onClick={() => importInput.current?.click()}
          aria-label="Import a conversation"
          title="Import a conversation exported as JSON"
        >
          <ImportIcon />
        </button>
        <input
          ref={importInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onImport(file);
            e.target.value = "";
          }}
        />
        {onLogout && (
          <button className="icon-btn" onClick={onLogout} aria-label="Sign out" title="Sign out">
            <SignOutIcon />
          </button>
        )}
      </div>
    </aside>
  );
}
