import type { ExecutionHost } from "./execution.js";
import type { ProcessHost } from "./process.js";

export interface ApprovalRequest {
  callId: string;
  tool: string;
  args: unknown;
  summary: string;
  sessionId: string;
}

export type ApprovalDecision = "approve" | "approve_always" | "deny";

export interface ApprovalBroker {
  request(req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
}

export interface AuditEntry {
  at: number;
  sessionId: string;
  tool: string;
  args: unknown;
  callId?: string;
  decision?: ApprovalDecision;
  ok?: boolean;
  detail?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): void | Promise<void>;
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

/** Everything a tool is allowed to touch. Secrets/approval never leave the server. */
export interface ToolContext {
  sessionId: string;
  host: ExecutionHost;
  secrets: SecretStore;
  approval: ApprovalBroker;
  audit: AuditLog;
  logger: Logger;
  signal: AbortSignal;
}
