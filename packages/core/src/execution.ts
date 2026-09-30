import type { NormalizedError } from "./errors.js";

export interface HostCapabilities {
  os: string;
  arch: string;
  runtimes: string[];
  tags: string[];
  /** Effective isolation tier for shell commands; absent on older runners. */
  sandbox?: "host" | "container";
}

export interface ExecRequest {
  command: string;
  /** Path relative to the session workspace root; defaults to the root. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export type ExecEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number | null; signal: string | null; durationMs: number }
  | { type: "error"; error: NormalizedError };

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "other";
  size?: number;
}

export interface ScopedFs {
  read(sessionId: string, path: string): Promise<string>;
  write(sessionId: string, path: string, data: string): Promise<void>;
  list(sessionId: string, path: string): Promise<DirEntry[]>;
}

export interface FetchRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface Fetcher {
  fetch(input: string, init?: FetchRequest): Promise<FetchResponse>;
}

export interface WorkspaceInfo {
  sessionId: string;
  /** Absolute path of the workspace root on the execution host. */
  root: string;
}

/**
 * The execution seam. Implemented by every execution host (local process,
 * remote runner, ...). The chat server never executes anything itself: it
 * always resolves an ExecutionHost and calls into it.
 */
export interface ExecutionHost {
  readonly id: string;
  readonly capabilities: HostCapabilities;
  /**
   * True once the host can no longer run anything (its runner disconnected).
   * Anything that keeps a host around must resolve a fresh one instead.
   */
  readonly closed?: boolean;
  ensureWorkspace(sessionId: string): Promise<WorkspaceInfo>;
  exec(req: ExecRequest, signal: AbortSignal): AsyncIterable<ExecEvent>;
  readonly fs: ScopedFs;
  readonly net: Fetcher;
}
