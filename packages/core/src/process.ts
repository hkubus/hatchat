import type { ExecEvent } from "./execution.js";

export interface SpawnRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Run inside this session's workspace (cwd relative to it) instead of the shared process dir. */
  sessionId?: string;
  /** Treat `command` as a shell command line (sandboxed like exec when the runner uses containers). */
  shell?: boolean;
}

export interface SpawnedProcess {
  readonly id: string;
  readonly events: AsyncIterable<ExecEvent>;
  write(data: string): void;
  endStdin(): void;
  kill(): void;
}

/**
 * A host that can run long-lived, interactive processes (used for stdio MCP
 * servers). Distinct from `ExecutionHost.exec`, which is session-scoped.
 */
export interface ProcessHost {
  spawn(request: SpawnRequest): Promise<SpawnedProcess>;
}
