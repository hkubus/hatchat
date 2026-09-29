import { Fragment, useEffect, useRef, useState } from "react";
import { usageTotal } from "@hat/core";
import type { SearchHit, SessionSummary } from "./api";
import { isAbortError, searchMessages } from "./api";
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

const STATUS_LABEL = { running: "Working…", waiting: "Needs you" } as const;

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

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

  function commit(): void {
    const title = draft.trim();
    if (editingId && title) onRename(editingId, title);
    setEditingId(null);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-brand">Hat</span>
        <button
          className="new-chat"
          onClick={onNew}
          title="New chat"
          aria-label="New chat"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <div className="session-search">
        <input
          type="search"
          value={query}
          placeholder="Search chats"
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
        {needle && visible.length > 0 && <div className="session-group">Titles</div>}
        {visible.map((session) => {
          const tokens = formatTokens(usageTotal(session.usage ?? undefined));
          return (
            <div
              key={session.id}
              className={`session-item ${session.id === activeId && view === "chat" ? "active" : ""}`}
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
                    title={session.title}
                  >
                    <span className="session-title">
                      {session.status && session.status !== "idle" && (
                        <span
                          className={`session-status ${session.status}`}
                          title={STATUS_LABEL[session.status]}
                          aria-label={STATUS_LABEL[session.status]}
                        />
                      )}
                      {session.title}
                    </span>
                    <span className="session-meta">
                      {session.messageCount} · {timeAgo(session.updatedAt)}
                      {tokens && <> · {tokens} tokens</>}
                    </span>
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
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 20h9M16.5 3.5a2.1 2.0 0 1 1 3 3L7 19l-4 1 1-4Z" />
                      </svg>
                    </button>
                    <button
                      className="icon-btn"
                      title="Delete"
                      aria-label={`Delete ${session.title}`}
                      onClick={() => setConfirmingId(session.id)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                      </svg>
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })}
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 6h16M4 12h16M4 18h16" />
            <circle cx="9" cy="6" r="2" fill="var(--bg-sidebar)" />
            <circle cx="15" cy="12" r="2" fill="var(--bg-sidebar)" />
            <circle cx="8" cy="18" r="2" fill="var(--bg-sidebar)" />
          </svg>
          Settings
        </button>
        <button
          className="side-btn"
          onClick={() => importInput.current?.click()}
          aria-label="Import a conversation"
          title="Import a conversation exported as JSON"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
          </svg>
          Import
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
          <button className="side-btn" onClick={onLogout} aria-label="Sign out">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Sign out
          </button>
        )}
      </div>
    </aside>
  );
}
