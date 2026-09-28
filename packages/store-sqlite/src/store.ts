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

export interface SessionRecord {
  id: string;
  title: string;
  model: string;
  activeLeafId: string | null;
  approvalMode: ApprovalMode;
  allowedTools: string[];
  reasoningEffort: ReasoningEffort;
  createdAt: number;
  updatedAt: number;
}

export interface AttachmentRecord {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
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
  model: string;
  active_leaf_id: string | null;
  approval_mode: string;
  allowed_tools: string;
  reasoning_effort: string;
  created_at: number;
  updated_at: number;
}

interface AttachmentRow {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
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
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations for databases created before a column existed. */
  private migrate(): void {
    const columns = [
      "approval_mode TEXT NOT NULL DEFAULT 'ask'",
      "allowed_tools TEXT NOT NULL DEFAULT '[]'",
      "reasoning_effort TEXT NOT NULL DEFAULT 'off'",
    ];
    for (const column of columns) {
      try {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column}`);
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
        `INSERT INTO sessions (id, title, model, active_leaf_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, title, model, now, now);
    return {
      id,
      title,
      model,
      activeLeafId: null,
      approvalMode: "ask",
      allowedTools: [],
      reasoningEffort: "off",
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

  setSessionTitle(sessionId: string, title: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, Date.now(), sessionId);
  }

  deleteSession(sessionId: string): boolean {
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
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
   * leaf) and move the active leaf to it.
   */
  appendMessage(sessionId: string, message: ChatMessage, parentId?: string | null): void {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const parent = parentId === undefined ? session.activeLeafId : parentId;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, parent_id, role, parts, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        sessionId,
        parent,
        message.role,
        JSON.stringify(message.parts),
        message.meta ? JSON.stringify(message.meta) : null,
        message.createdAt || now,
      );

    const title = deriveTitle(session, message);
    this.db
      .prepare(`UPDATE sessions SET active_leaf_id = ?, updated_at = ?, title = ? WHERE id = ?`)
      .run(message.id, now, title, sessionId);
  }

  /** The active root→leaf conversation path. */
  getPath(sessionId: string): PathNode[] {
    const session = this.getSession(sessionId);
    if (!session?.activeLeafId) return [];

    const chain: ChatMessage[] = [];
    const seen = new Set<string>();
    let cursor: string | null = session.activeLeafId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const message = this.getMessage(cursor);
      if (!message) break;
      chain.unshift(message);
      cursor = this.getParentId(cursor);
    }

    return chain.map((message) => {
      const parentId = this.getParentId(message.id);
      const siblings = this.children(sessionId, parentId);
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
    const row = this.db
      .prepare(`SELECT ciphertext, iv, tag FROM secrets WHERE name = ?`)
      .get(name) as { ciphertext: string; iv: string; tag: string } | undefined;
    if (row) {
      return decryptSecret(row, this.masterKey);
    }
    return process.env[name];
  }

  /** SecretStore contract: DB first, then process env. */
  async get(name: string): Promise<string | undefined> {
    return this.getSecret(name);
  }

  hasSecret(name: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS present FROM secrets WHERE name = ?`)
      .get(name) as { present: number } | undefined;
    return Boolean(row) || Boolean(process.env[name]);
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

  async putAttachment(data: Buffer, mime: string): Promise<AttachmentRecord> {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const existing = this.getAttachmentByHash(sha256);
    if (existing) return existing;

    const id = newId("att");
    const size = data.length;
    const dimensions = imageSize(data);
    if (this.artifacts) {
      await this.artifacts.put(sha256, data, mime);
    }
    this.db
      .prepare(
        `INSERT INTO attachments (id, sha256, mime, size, width, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sha256, mime, size, dimensions?.width ?? null, dimensions?.height ?? null, Date.now());

    return {
      id,
      sha256,
      mime,
      size,
      width: dimensions?.width,
      height: dimensions?.height,
      createdAt: Date.now(),
    };
  }

  getAttachment(id: string): AttachmentRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM attachments WHERE id = ?`)
      .get(id) as unknown as AttachmentRow | undefined;
    return row ? toAttachment(row) : undefined;
  }

  getAttachmentByHash(sha256: string): AttachmentRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM attachments WHERE sha256 = ?`)
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

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    activeLeafId: row.active_leaf_id,
    approvalMode: (row.approval_mode as ApprovalMode) ?? "ask",
    allowedTools: row.allowed_tools ? (JSON.parse(row.allowed_tools) as string[]) : [],
    reasoningEffort: (row.reasoning_effort as ReasoningEffort) ?? "off",
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
