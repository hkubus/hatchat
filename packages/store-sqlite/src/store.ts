import type {
  ApprovalMode,
  ChatMessage,
  MessageMeta,
  Part,
  ReasoningEffort,
  Role,
  SecretStore,
  Usage,
} from "@hat/core";
import { addUsage, newId } from "@hat/core";
import type { ArtifactStore } from "@hat/artifacts";
import { decryptSecret, encryptSecret } from "@hat/crypto";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { imageSize } from "./image.js";
import { SCHEMA } from "./schema.js";

export type TitleSource = "derived" | "model" | "user";

export interface SessionRecord {
  id: string;
  title: string;
  /**
   * Who owns the title. `derived` is the truncated first user message and is
   * safe to overwrite; `user` and `model` are final.
   */
  titleSource: TitleSource;
  model: string;
  activeLeafId: string | null;
  approvalMode: ApprovalMode;
  allowedTools: string[];
  reasoningEffort: ReasoningEffort;
  /** Per-conversation instructions appended to the system prompt; "" for none. */
  instructions: string;
  /** Sampling temperature; null leaves the provider default. */
  temperature: number | null;
  /** Reply-token cap per model call; null leaves the provider default. */
  maxTokens: number | null;
  createdAt: number;
  updatedAt: number;
}

/** The settings a conversation carries, as exported, forked and imported. */
export type SessionSettings = Pick<
  SessionRecord,
  "model" | "approvalMode" | "allowedTools" | "reasoningEffort" | "instructions" | "temperature" | "maxTokens"
>;

/** A portable copy of one conversation: the whole message tree, not just the active branch. */
export interface SessionExport {
  format: "hat.session";
  version: 1;
  exportedAt: number;
  session: SessionSettings & { title: string; createdAt: number };
  activeLeafId: string | null;
  /** Parents always precede their children. */
  messages: Array<{
    id: string;
    parentId: string | null;
    role: Role;
    parts: Part[];
    meta?: MessageMeta;
    createdAt: number;
  }>;
}

export interface AttachmentRecord {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  /** Original file name, for documents. */
  name?: string;
  /** Whether extracted text is stored for the model (see `getAttachmentText`). */
  hasText?: boolean;
  createdAt: number;
}

export interface MemoryRecord {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export interface SearchHit {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  role: "user" | "assistant";
  /** Matching excerpt with hits wrapped in « ». */
  snippet: string;
  createdAt: number;
}

export interface ScheduleRecord {
  id: string;
  title: string;
  prompt: string;
  /** 5-field cron expression, or null for a one-shot at `runAt`. */
  cron: string | null;
  /** IANA zone the cron fields are read in. */
  timezone: string;
  runAt: number | null;
  /** Continue this conversation on each run; null starts a fresh one each time. */
  sessionId: string | null;
  model: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastSessionId: string | null;
  lastError: string | null;
  enabled: boolean;
  createdAt: number;
}

export interface PathNode {
  message: ChatMessage;
  parentId: string | null;
  siblingIndex: number;
  siblingCount: number;
  siblingIds: string[];
}

interface MessageRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  role: string;
  parts: string;
  meta: string | null;
  created_at: number;
}

interface SessionRow {
  id: string;
  title: string;
  title_source: string;
  model: string;
  active_leaf_id: string | null;
  approval_mode: string;
  allowed_tools: string;
  reasoning_effort: string;
  instructions: string | null;
  temperature: number | null;
  max_tokens: number | null;
  created_at: number;
  updated_at: number;
}

/** Attachment columns minus the (possibly large) extracted text. */
/** How long an upload is kept for a draft that may still send it. */
export const ATTACHMENT_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;

const ATTACHMENT_COLUMNS =
  "id, sha256, mime, size, width, height, name, (text IS NOT NULL) AS has_text, created_at";

interface AttachmentRow {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  name: string | null;
  has_text: number;
  created_at: number;
}

/**
 * SQLite-backed sessions, a branching message tree, and encrypted secrets.
 * Uses the built-in `node:sqlite` driver (no native build step).
 */
export class Store implements SecretStore {
  private readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly masterKey: Buffer,
    private readonly artifacts?: ArtifactStore,
  ) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    // WAL lets readers proceed during writes (turn streaming + polling);
    // busy_timeout avoids SQLITE_BUSY on concurrent turns.
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;`);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations for databases created before a column existed. */
  private migrate(): void {
    const columns = [
      "approval_mode TEXT NOT NULL DEFAULT 'auto'",
      "allowed_tools TEXT NOT NULL DEFAULT '[]'",
      "reasoning_effort TEXT NOT NULL DEFAULT 'low'",
      "title_source TEXT NOT NULL DEFAULT 'derived'",
      "instructions TEXT NOT NULL DEFAULT ''",
      "temperature REAL",
      "max_tokens INTEGER",
    ];
    for (const column of columns) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column}`);
      } catch {
        /* column already exists */
      }
    }
    // Documents the user attaches keep their original name and extracted text.
    // `last_put_at`: the last time these bytes were uploaded, a dedupe hit included.
    for (const column of ["name TEXT", "text TEXT", "last_put_at INTEGER"]) {
      try {
        this.db.exec(`ALTER TABLE attachments ADD COLUMN ${column}`);
      } catch {
        /* column already exists */
      }
    }
    // Auto-route was removed; drop the legacy column where SQLite supports it.
    // Wrapped because older SQLite builds lack DROP COLUMN, and an untouched
    // column is harmless either way.
    try {
      this.db.exec("ALTER TABLE sessions DROP COLUMN auto_route");
    } catch {
      /* already dropped, or unsupported */
    }
    // One-time realignment: sessions created before the defaults were corrected
    // were written as 'ask'/'off' by the column default even though the app
    // reported and intended 'auto'/'low'. Only the exact legacy defaults are
    // flipped; deny/allowlist and medium/high choices are preserved.
    const { user_version: schemaVersion } = this.db
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    if (schemaVersion < 1) {
      this.db.exec("UPDATE sessions SET approval_mode = 'auto' WHERE approval_mode = 'ask'");
      this.db.exec("UPDATE sessions SET reasoning_effort = 'low' WHERE reasoning_effort = 'off'");
      this.db.exec("PRAGMA user_version = 1");
    }
    // Chat search index arrived with version 2; backfill existing messages.
    if (schemaVersion < 2) {
      const rows = this.db
        .prepare(`SELECT id, session_id, role, parts FROM messages WHERE role IN ('user', 'assistant')`)
        .all() as Array<{ id: string; session_id: string; role: string; parts: string }>;
      const insert = this.db.prepare(
        `INSERT INTO messages_fts (text, message_id, session_id, role) VALUES (?, ?, ?, ?)`,
      );
      this.db.exec("BEGIN");
      for (const row of rows) {
        const text = searchableText(JSON.parse(row.parts) as Part[]);
        if (text) insert.run(text, row.id, row.session_id, row.role);
      }
      this.db.exec("PRAGMA user_version = 2");
      this.db.exec("COMMIT");
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- sessions -----------------------------------------------------------

  createSession(model: string, title = "New chat"): SessionRecord {
    const now = Date.now();
    const id = newId("sess");
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, title_source, model, active_leaf_id, approval_mode, reasoning_effort, created_at, updated_at)
         VALUES (?, ?, 'derived', ?, NULL, 'auto', 'low', ?, ?)`,
      )
      .run(id, title, model, now, now);
    return {
      id,
      title,
      titleSource: "derived",
      model,
      activeLeafId: null,
      approvalMode: "auto",
      allowedTools: [],
      reasoningEffort: "low",
      instructions: "",
      temperature: null,
      maxTokens: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(id) as unknown as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  listSessions(): SessionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC`)
      .all() as unknown as SessionRow[];
    return rows.map(toSession);
  }

  setSessionModel(sessionId: string, model: string): void {
    this.db
      .prepare(`UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?`)
      .run(model, Date.now(), sessionId);
  }

  /** A manual rename: always wins, and counts as activity. */
  setSessionTitle(sessionId: string, title: string): void {
    this.db
      .prepare(
        `UPDATE sessions SET title = ?, title_source = 'user', updated_at = ? WHERE id = ?`,
      )
      .run(title, Date.now(), sessionId);
  }

  /**
   * Apply a model-written title, but only while the title is still the derived
   * placeholder — a rename that landed while the model was thinking wins.
   *
   * Deliberately leaves `updated_at` alone: the turn that triggered this has
   * already bumped it, and reordering the sidebar mid-conversation is just
   * noise.
   *
   * @returns whether the title was written.
   */
  setGeneratedTitle(sessionId: string, title: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE sessions SET title = ?, title_source = 'model'
         WHERE id = ? AND title_source = 'derived'`,
      )
      .run(title, sessionId);
    return result.changes > 0;
  }

  /** The attachments this session's messages refer to: images, documents, artifacts. */
  attachmentIdsOf(sessionId: string): string[] {
    const rows = this.db
      .prepare(`SELECT parts FROM messages WHERE session_id = ?`)
      .all(sessionId) as Array<{ parts: string }>;
    const ids = new Set<string>();
    const collect = (part: Part): void => {
      if (part.type === "image" && part.source.kind === "attachment") ids.add(part.source.id);
      else if (part.type === "file") ids.add(part.id);
      else if (part.type === "tool_result") part.content.forEach(collect);
    };
    for (const row of rows) {
      for (const part of JSON.parse(row.parts) as Part[]) collect(part);
    }
    return [...ids];
  }

  /**
   * Delete the attachments among `ids` that no message refers to any more,
   * row (with its extracted text) and bytes. The same bytes uploaded twice are
   * one attachment, so one another conversation still uses stays.
   *
   * An upload is not a message yet: another conversation may hold the same
   * bytes in its composer, unsent. So an attachment uploaded (or re-uploaded,
   * which dedupes to the same id) at or after `olderThan` — by default a day
   * ago — stays too.
   */
  async pruneAttachments(
    ids: readonly string[],
    { olderThan = Date.now() - ATTACHMENT_UPLOAD_GRACE_MS }: { olderThan?: number } = {},
  ): Promise<string[]> {
    const removed: string[] = [];
    for (const id of ids) {
      const used = this.db.prepare(`SELECT 1 FROM messages WHERE instr(parts, ?) > 0 LIMIT 1`).get(id);
      if (used) continue;
      const row = this.db
        .prepare(`SELECT sha256, COALESCE(last_put_at, created_at) AS put_at FROM attachments WHERE id = ?`)
        .get(id) as { sha256: string; put_at: number } | undefined;
      if (!row || row.put_at >= olderThan) continue;
      this.db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id);
      await this.artifacts?.delete(row.sha256);
      removed.push(id);
    }
    return removed;
  }

  deleteSession(sessionId: string): boolean {
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
    this.db.prepare(`DELETE FROM messages_fts WHERE session_id = ?`).run(sessionId);
    const result = this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    return result.changes > 0;
  }

  setSessionPolicy(
    sessionId: string,
    patch: { approvalMode?: ApprovalMode; allowedTools?: string[] },
  ): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    this.db
      .prepare(
        `UPDATE sessions SET approval_mode = ?, allowed_tools = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.approvalMode ?? session.approvalMode,
        JSON.stringify(patch.allowedTools ?? session.allowedTools),
        Date.now(),
        sessionId,
      );
  }

  /**
   * Update the per-conversation model settings. `undefined` leaves a field
   * alone; `null` (or "" for instructions) clears it back to the default.
   */
  setSessionSettings(
    sessionId: string,
    patch: { instructions?: string; temperature?: number | null; maxTokens?: number | null },
  ): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    this.db
      .prepare(
        `UPDATE sessions SET instructions = ?, temperature = ?, max_tokens = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.instructions ?? session.instructions,
        patch.temperature === undefined ? session.temperature : patch.temperature,
        patch.maxTokens === undefined ? session.maxTokens : patch.maxTokens,
        Date.now(),
        sessionId,
      );
  }

  /** Copy every setting that shapes the model's behaviour onto another session. */
  private applySettings(sessionId: string, settings: SessionSettings): void {
    this.db
      .prepare(
        `UPDATE sessions SET model = ?, approval_mode = ?, allowed_tools = ?, reasoning_effort = ?,
                instructions = ?, temperature = ?, max_tokens = ?
          WHERE id = ?`,
      )
      .run(
        settings.model,
        settings.approvalMode,
        JSON.stringify(settings.allowedTools),
        settings.reasoningEffort,
        settings.instructions,
        settings.temperature,
        settings.maxTokens,
        sessionId,
      );
  }

  /**
   * Start a new conversation from the root→`messageId` path of another one,
   * with the same settings. Only that path is copied, not sibling branches;
   * messages get fresh ids so the two conversations never share a node.
   */
  forkSession(sessionId: string, messageId: string): SessionRecord | undefined {
    const source = this.getSession(sessionId);
    const target = this.getMessage(messageId);
    if (!source || !target || this.sessionOf(messageId) !== sessionId) return undefined;
    const chain: ChatMessage[] = [];
    const seen = new Set<string>();
    let cursor: string | null = messageId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const message = this.getMessage(cursor);
      if (!message) break;
      chain.unshift(message);
      cursor = this.getParentId(cursor);
    }
    const fork = this.createSession(source.model, `${source.title} (fork)`.slice(0, 200));
    this.applySettings(fork.id, source);
    let parent: string | null = null;
    for (const message of chain) {
      const copy: ChatMessage = { ...message, id: newId("msg") };
      this.appendMessage(fork.id, copy, parent);
      parent = copy.id;
    }
    this.db
      .prepare(`UPDATE sessions SET title = ?, title_source = 'user' WHERE id = ?`)
      .run(`${source.title} (fork)`.slice(0, 200), fork.id);
    return this.getSession(fork.id);
  }

  /** The whole conversation tree plus its settings, in a portable form. */
  exportSession(sessionId: string): SessionExport | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC`)
      .all(sessionId) as unknown as MessageRow[];
    return {
      format: "hat.session",
      version: 1,
      exportedAt: Date.now(),
      session: {
        title: session.title,
        createdAt: session.createdAt,
        model: session.model,
        approvalMode: session.approvalMode,
        allowedTools: session.allowedTools,
        reasoningEffort: session.reasoningEffort,
        instructions: session.instructions,
        temperature: session.temperature,
        maxTokens: session.maxTokens,
      },
      activeLeafId: session.activeLeafId,
      messages: rows.map((row) => {
        const message = toMessage(row);
        return {
          id: message.id,
          parentId: row.parent_id,
          role: message.role,
          parts: message.parts,
          ...(message.meta ? { meta: message.meta } : {}),
          createdAt: message.createdAt,
        };
      }),
    };
  }

  /**
   * Recreate an exported conversation as a new session. Message ids are
   * remapped (an import never collides with, or aliases, existing history);
   * `mapPart` lets the caller rewrite attachment references it re-uploaded.
   * Messages whose parent is missing are dropped rather than orphaned.
   */
  importSession(data: SessionExport, mapPart: (part: Part) => Part = (part) => part): SessionRecord {
    const settings = data.session;
    const session = this.createSession(settings.model || "fake/fake-agent", "New chat");
    this.applySettings(session.id, {
      model: settings.model || session.model,
      approvalMode: settings.approvalMode ?? session.approvalMode,
      allowedTools: Array.isArray(settings.allowedTools) ? settings.allowedTools : [],
      reasoningEffort: settings.reasoningEffort ?? session.reasoningEffort,
      instructions: typeof settings.instructions === "string" ? settings.instructions : "",
      temperature: typeof settings.temperature === "number" ? settings.temperature : null,
      maxTokens: typeof settings.maxTokens === "number" ? settings.maxTokens : null,
    });
    const ids = new Map<string, string>();
    for (const message of data.messages) {
      const parent = message.parentId === null ? null : ids.get(message.parentId);
      if (parent === undefined) continue;
      const id = newId("msg");
      ids.set(message.id, id);
      this.appendMessage(
        session.id,
        {
          id,
          role: message.role,
          parts: message.parts.map((part) => mapPart(structuredClone(part))),
          createdAt: message.createdAt,
          ...(message.meta ? { meta: message.meta } : {}),
        },
        parent,
      );
    }
    const leaf = data.activeLeafId ? ids.get(data.activeLeafId) : undefined;
    this.db
      .prepare(`UPDATE sessions SET title = ?, title_source = 'user', active_leaf_id = COALESCE(?, active_leaf_id) WHERE id = ?`)
      .run((settings.title || "Imported chat").slice(0, 200), leaf ?? null, session.id);
    return this.getSession(session.id)!;
  }

  private sessionOf(messageId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT session_id FROM messages WHERE id = ?`)
      .get(messageId) as { session_id: string } | undefined;
    return row?.session_id;
  }

  setSessionReasoningEffort(sessionId: string, effort: ReasoningEffort): void {
    this.db
      .prepare(`UPDATE sessions SET reasoning_effort = ?, updated_at = ? WHERE id = ?`)
      .run(effort, Date.now(), sessionId);
  }

  // ---- message tree -------------------------------------------------------

  getMessage(id: string): ChatMessage | undefined {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE id = ?`)
      .get(id) as unknown as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  getParentId(messageId: string): string | null {
    const row = this.db
      .prepare(`SELECT parent_id FROM messages WHERE id = ?`)
      .get(messageId) as { parent_id: string | null } | undefined;
    return row?.parent_id ?? null;
  }

  /**
   * Append a message as a child of `parentId` (defaults to the session's active
   * leaf). The active leaf moves to it only while it still points at that
   * parent: a turn writing its own branch must not drag the conversation back
   * to it after the user switched to another one. Atomic: the insert + leaf
   * move commit together so a crash can't orphan a message.
   */
  appendMessage(sessionId: string, message: ChatMessage, parentId?: string | null): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const parent = parentId === undefined ? session.activeLeafId : parentId;
    const now = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO messages (id, session_id, parent_id, role, parts, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const touch = this.db.prepare(
      `UPDATE sessions
          SET active_leaf_id = CASE WHEN active_leaf_id IS ? THEN ? ELSE active_leaf_id END,
              updated_at = ?, title = ?
        WHERE id = ?`,
    );
    const title = deriveTitle(session, message);
    // node:sqlite is sync; a simple exec transaction is enough.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      insert.run(
        message.id,
        sessionId,
        parent,
        message.role,
        JSON.stringify(message.parts),
        message.meta ? JSON.stringify(message.meta) : null,
        message.createdAt || now,
      );
      touch.run(parent, message.id, now, title, sessionId);
      // The synthetic "Continue" nudge is hidden in every client, so it must
      // not turn up as a search hit either.
      const searchable =
        (message.role === "user" || message.role === "assistant") && !message.meta?.synthetic
          ? searchableText(message.parts)
          : "";
      if (searchable) {
        this.db
          .prepare(`INSERT INTO messages_fts (text, message_id, session_id, role) VALUES (?, ?, ?, ?)`)
          .run(searchable, message.id, sessionId, message.role);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  }

  /** The active root→leaf conversation path — single query, no N+1. */
  getPath(sessionId: string): PathNode[] {
    const session = this.getSession(sessionId);
    if (!session?.activeLeafId) return [];

    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC`)
      .all(sessionId) as unknown as MessageRow[];
    if (rows.length === 0) return [];
    const byId = new Map<string, MessageRow>();
    const childrenByParent = new Map<string | null, MessageRow[]>();
    for (const row of rows) {
      byId.set(row.id, row);
      const key = row.parent_id ?? null;
      const list = childrenByParent.get(key);
      if (list) list.push(row);
      else childrenByParent.set(key, [row]);
    }
    const chain: MessageRow[] = [];
    const seen = new Set<string>();
    let cursor: string | null = session.activeLeafId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const row = byId.get(cursor);
      if (!row) break;
      chain.unshift(row);
      cursor = row.parent_id ?? null;
    }

    return chain.map((row) => {
      const message = toMessage(row);
      const parentId = row.parent_id ?? null;
      const siblings = childrenByParent.get(parentId) ?? [];
      const index = siblings.findIndex((s) => s.id === message.id);
      return {
        message,
        parentId,
        siblingIndex: index,
        siblingCount: siblings.length,
        siblingIds: siblings.map((s) => s.id),
      };
    });
  }

  setActiveLeaf(sessionId: string, messageId: string | null): void {
    this.db
      .prepare(`UPDATE sessions SET active_leaf_id = ?, updated_at = ? WHERE id = ?`)
      .run(messageId, Date.now(), sessionId);
  }

  /** Point the active leaf at the deepest descendant of `messageId`. */
  selectBranch(sessionId: string, messageId: string): void {
    this.setActiveLeaf(sessionId, this.deepestDescendant(sessionId, messageId));
  }

  private deepestDescendant(sessionId: string, messageId: string): string {
    let current = messageId;
    for (;;) {
      const kids = this.children(sessionId, current);
      if (kids.length === 0) return current;
      current = kids[kids.length - 1].id;
    }
  }

  /** Messages a client shows as rows: user and assistant, minus synthetic nudges. */
  countVisibleMessages(sessionId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages
          WHERE session_id = ? AND role IN ('user', 'assistant')
            AND (meta IS NULL OR json_extract(meta, '$.synthetic') IS NULL)`,
      )
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Whether `messageId` is a message of `sessionId` (not merely some message). */
  hasMessage(sessionId: string, messageId: string): boolean {
    return this.sessionOf(messageId) === sessionId;
  }

  countMessages(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`)
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Token totals for every session's active branch, summed from the usage
   * recorded on each message's metadata. A single recursive query walks each
   * session's leaf back to its root, so this stays cheap for the session list.
   * Messages on inactive branches are excluded, matching what the chat shows.
   */
  usageBySession(): Map<string, Usage> {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(id, session_id, depth) AS (
           SELECT active_leaf_id, id, 0 FROM sessions WHERE active_leaf_id IS NOT NULL
           UNION ALL
           SELECT m.parent_id, c.session_id, c.depth + 1
           FROM chain c
           JOIN messages m ON m.id = c.id
           WHERE m.parent_id IS NOT NULL AND c.depth < 1000
         )
         SELECT c.session_id AS session_id, m.meta AS meta
         FROM chain c
         JOIN messages m ON m.id = c.id
         WHERE m.meta IS NOT NULL`,
      )
      .all() as unknown as Array<{ session_id: string; meta: string }>;

    const totals = new Map<string, Usage>();
    for (const row of rows) {
      const usage = parseMeta(row.meta)?.usage;
      if (!usage) continue;
      totals.set(row.session_id, addUsage(totals.get(row.session_id), usage));
    }
    return totals;
  }

  children(sessionId: string, parentId: string | null): ChatMessage[] {
    const rows =
      parentId === null
        ? (this.db
            .prepare(
              `SELECT * FROM messages WHERE session_id = ? AND parent_id IS NULL ORDER BY rowid ASC`,
            )
            .all(sessionId) as unknown as MessageRow[])
        : (this.db
            .prepare(
              `SELECT * FROM messages WHERE session_id = ? AND parent_id = ? ORDER BY rowid ASC`,
            )
            .all(sessionId, parentId) as unknown as MessageRow[]);
    return rows.map(toMessage);
  }

  // ---- secrets ------------------------------------------------------------

  setSecret(name: string, value: string): void {
    const record = encryptSecret(value, this.masterKey);
    this.db
      .prepare(
        `INSERT INTO secrets (name, ciphertext, iv, tag, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`,
      )
      .run(name, record.ciphertext, record.iv, record.tag, Date.now());
  }

  async getSecret(name: string): Promise<string | undefined> {
    return (await this.getStored(name)) ?? process.env[name];
  }

  /** SecretStore contract: DB first, then process env. */
  async get(name: string): Promise<string | undefined> {
    return this.getSecret(name);
  }

  /** SecretStore contract: the DB only, never the process env. */
  async getStored(name: string): Promise<string | undefined> {
    return this.readSecret(name);
  }

  hasSecret(name: string): boolean {
    return this.readSecret(name) !== undefined || Boolean(process.env[name]);
  }

  /**
   * Saved secrets the current master key can't decrypt: they were saved under
   * another one (`HAT_MASTER_KEY` changed, or the key file was lost and a new
   * one generated). They read as unset until they are saved again.
   */
  unreadableSecrets(): string[] {
    const rows = this.db.prepare(`SELECT name FROM secrets ORDER BY name ASC`).all() as Array<{ name: string }>;
    return rows.map((row) => row.name).filter((name) => this.readSecret(name) === undefined);
  }

  /**
   * A saved secret, decrypted. One the master key can't decrypt reads as
   * unset, so whatever needs it asks for it again, rather than the error
   * stopping every plugin from loading and the server from starting.
   */
  private readSecret(name: string): string | undefined {
    const row = this.db
      .prepare(`SELECT ciphertext, iv, tag FROM secrets WHERE name = ?`)
      .get(name) as { ciphertext: string; iv: string; tag: string } | undefined;
    if (!row) return undefined;
    try {
      return decryptSecret(row, this.masterKey);
    } catch {
      return undefined;
    }
  }

  listSecretNames(): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM secrets ORDER BY name ASC`)
      .all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  deleteSecret(name: string): boolean {
    const result = this.db.prepare(`DELETE FROM secrets WHERE name = ?`).run(name);
    return result.changes > 0;
  }

  // ---- attachments --------------------------------------------------------

  /**
   * Store a blob, deduplicated by content. `name` and `text` describe a
   * document: its file name, and the text the model reads in its place.
   */
  async putAttachment(
    data: Buffer,
    mime: string,
    document?: { name?: string; text?: string },
  ): Promise<AttachmentRecord> {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const existing = this.getAttachmentByHash(sha256);
    if (existing) {
      // Someone holds this id again, maybe in a draft no message shows yet.
      this.db.prepare(`UPDATE attachments SET last_put_at = ? WHERE id = ?`).run(Date.now(), existing.id);
      // The same bytes uploaded before as something else (or before text
      // extraction existed) pick up the text now.
      if (document?.text !== undefined && !existing.hasText) {
        this.db
          .prepare(`UPDATE attachments SET text = ?, name = COALESCE(name, ?) WHERE id = ?`)
          .run(document.text, document.name ?? null, existing.id);
        return this.getAttachment(existing.id)!;
      }
      return existing;
    }

    const id = newId("att");
    const now = Date.now();
    const size = data.length;
    const dimensions = imageSize(data);
    if (this.artifacts) {
      await this.artifacts.put(sha256, data, mime);
    }
    this.db
      .prepare(
        `INSERT INTO attachments (id, sha256, mime, size, width, height, name, text, created_at, last_put_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sha256,
        mime,
        size,
        dimensions?.width ?? null,
        dimensions?.height ?? null,
        document?.name ?? null,
        document?.text ?? null,
        now,
        now,
      );

    return this.getAttachment(id)!;
  }

  /** The extracted text of a document attachment, if one was stored. */
  getAttachmentText(id: string): string | undefined {
    const row = this.db.prepare(`SELECT text FROM attachments WHERE id = ?`).get(id) as
      | { text: string | null }
      | undefined;
    return row?.text ?? undefined;
  }

  getAttachment(id: string): AttachmentRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?`)
      .get(id) as unknown as AttachmentRow | undefined;
    return row ? toAttachment(row) : undefined;
  }

  getAttachmentByHash(sha256: string): AttachmentRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM attachments WHERE sha256 = ?`)
      .get(sha256) as unknown as AttachmentRow | undefined;
    return row ? toAttachment(row) : undefined;
  }

  async readAttachment(id: string): Promise<Buffer | undefined> {
    const record = this.getAttachment(id);
    if (!record || !this.artifacts) return undefined;
    return this.artifacts.get(record.sha256);
  }

  /** A store-provided URL (e.g. presigned S3 GET), if the backend offers one. */
  async attachmentUrl(id: string): Promise<string | undefined> {
    const record = this.getAttachment(id);
    if (!record || !this.artifacts) return undefined;
    return this.artifacts.url(record.sha256);
  }

  // ---- memories -----------------------------------------------------------

  listMemories(): MemoryRecord[] {
    const rows = this.db
      .prepare(`SELECT id, text, created_at, updated_at FROM memories ORDER BY created_at ASC`)
      .all() as Array<{ id: string; text: string; created_at: number; updated_at: number }>;
    return rows.map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  addMemory(text: string): MemoryRecord {
    const now = Date.now();
    const id = `mem_${newId().slice(0, 8)}`;
    this.db
      .prepare(`INSERT INTO memories (id, text, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(id, text, now, now);
    return { id, text, createdAt: now, updatedAt: now };
  }

  updateMemory(id: string, text: string): boolean {
    return this.db.prepare(`UPDATE memories SET text = ?, updated_at = ? WHERE id = ?`).run(text, Date.now(), id).changes > 0;
  }

  deleteMemory(id: string): boolean {
    return this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id).changes > 0;
  }

  // ---- chat search --------------------------------------------------------

  /**
   * Full-text search over user and assistant messages, best matches first.
   * The query is treated as plain words (each quoted), so user punctuation
   * can't produce an FTS syntax error.
   */
  searchMessages(query: string, options: { limit?: number; excludeSessionId?: string } = {}): SearchHit[] {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length === 0) return [];
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT f.message_id, f.session_id, f.role,
                snippet(messages_fts, 0, '«', '»', '…', 24) AS snippet,
                s.title, m.created_at
           FROM messages_fts f
           JOIN sessions s ON s.id = f.session_id
           JOIN messages m ON m.id = f.message_id
          WHERE messages_fts MATCH ? AND f.session_id != ?
          ORDER BY bm25(messages_fts)
          LIMIT ?`,
      )
      .all(match, options.excludeSessionId ?? "", options.limit ?? 10) as Array<{
      message_id: string;
      session_id: string;
      role: string;
      snippet: string;
      title: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      messageId: row.message_id,
      sessionId: row.session_id,
      sessionTitle: row.title,
      role: row.role as "user" | "assistant",
      snippet: row.snippet,
      createdAt: row.created_at,
    }));
  }

  // ---- schedules ----------------------------------------------------------

  createSchedule(input: Omit<ScheduleRecord, "id" | "createdAt" | "lastRunAt" | "lastSessionId" | "lastError" | "enabled">): ScheduleRecord {
    const record: ScheduleRecord = {
      ...input,
      id: `sch_${newId().slice(0, 8)}`,
      lastRunAt: null,
      lastSessionId: null,
      lastError: null,
      enabled: true,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO schedules (id, title, prompt, cron, timezone, run_at, session_id, model, next_run_at, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        record.id,
        record.title,
        record.prompt,
        record.cron,
        record.timezone,
        record.runAt,
        record.sessionId,
        record.model,
        record.nextRunAt,
        record.createdAt,
      );
    return record;
  }

  listSchedules(): ScheduleRecord[] {
    const rows = this.db.prepare(`SELECT * FROM schedules ORDER BY created_at ASC`).all() as unknown as ScheduleRow[];
    return rows.map(toSchedule);
  }

  getSchedule(id: string): ScheduleRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as unknown as ScheduleRow | undefined;
    return row ? toSchedule(row) : undefined;
  }

  dueSchedules(now: number): ScheduleRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?`)
      .all(now) as unknown as ScheduleRow[];
    return rows.map(toSchedule);
  }

  /** Record a run and move the schedule to its next time (null disables one-shots). */
  markScheduleRun(id: string, run: { at: number; sessionId: string | null; error: string | null; nextRunAt: number | null }): void {
    this.db
      .prepare(
        `UPDATE schedules SET last_run_at = ?, last_session_id = ?, last_error = ?, next_run_at = ?,
                enabled = CASE WHEN ? IS NULL THEN 0 ELSE enabled END
          WHERE id = ?`,
      )
      .run(run.at, run.sessionId, run.error, run.nextRunAt, run.nextRunAt, id);
  }

  setScheduleEnabled(id: string, enabled: boolean, nextRunAt: number | null): boolean {
    return this.db
      .prepare(`UPDATE schedules SET enabled = ?, next_run_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, nextRunAt, id).changes > 0;
  }

  deleteSchedule(id: string): boolean {
    return this.db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id).changes > 0;
  }

  // ---- plugin state -------------------------------------------------------

  getPluginState(id: string): { enabled: boolean; config: unknown } | undefined {
    const row = this.db
      .prepare(`SELECT enabled, config FROM plugins WHERE id = ?`)
      .get(id) as { enabled: number; config: string | null } | undefined;
    if (!row) return undefined;
    return {
      enabled: row.enabled === 1,
      config: row.config ? JSON.parse(row.config) : {},
    };
  }

  setPluginState(id: string, state: { enabled: boolean; config: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, enabled, config, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at`,
      )
      .run(id, state.enabled ? 1 : 0, JSON.stringify(state.config ?? {}), Date.now());
  }
}

interface ScheduleRow {
  id: string;
  title: string;
  prompt: string;
  cron: string | null;
  timezone: string;
  run_at: number | null;
  session_id: string | null;
  model: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_session_id: string | null;
  last_error: string | null;
  enabled: number;
  created_at: number;
}

function toSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    cron: row.cron,
    timezone: row.timezone,
    runAt: row.run_at,
    sessionId: row.session_id,
    model: row.model,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastSessionId: row.last_session_id,
    lastError: row.last_error,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

/** The text of a message worth indexing for search (prose only, no tool noise). */
function searchableText(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    activeLeafId: row.active_leaf_id,
    approvalMode: (row.approval_mode as ApprovalMode) ?? "auto",
    allowedTools: row.allowed_tools ? (JSON.parse(row.allowed_tools) as string[]) : [],
    reasoningEffort: (row.reasoning_effort as ReasoningEffort) ?? "low",
    titleSource: (row.title_source as TitleSource) ?? "derived",
    instructions: row.instructions ?? "",
    temperature: row.temperature ?? null,
    maxTokens: row.max_tokens ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttachment(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    sha256: row.sha256,
    mime: row.mime,
    size: row.size,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    ...(row.name ? { name: row.name } : {}),
    ...(row.has_text ? { hasText: true } : {}),
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role as Role,
    parts: JSON.parse(row.parts) as Part[],
    createdAt: row.created_at,
    meta: parseMeta(row.meta),
  };
}

/** Message metadata is optional and was written by older versions; never throw. */
function parseMeta(raw: string | null): MessageMeta | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as MessageMeta;
  } catch {
    return undefined;
  }
}

function deriveTitle(session: SessionRecord, message: ChatMessage): string {
  if (session.title !== "New chat" || message.role !== "user") return session.title;
  const first = message.parts.find((p) => p.type === "text");
  if (first && first.type === "text") return first.text.slice(0, 48) || "New chat";
  return session.title;
}
