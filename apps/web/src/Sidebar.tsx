import { useState } from "react";
import type { SessionSummary } from "./api";

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
}

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
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  function commit(): void {
    const title = draft.trim();
    if (editingId && title) onRename(editingId, title);
    setEditingId(null);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-brand">hat</span>
        <button className="new-chat" onClick={onNew}>
          New chat
        </button>
      </div>

      <nav className="session-list">
        {sessions.length === 0 && <div className="session-empty">No conversations yet</div>}
        {sessions.map((session) => (
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
                  <span className="session-title">{session.title}</span>
                  <span className="session-meta">
                    {session.messageCount} · {timeAgo(session.updatedAt)}
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
                      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
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
