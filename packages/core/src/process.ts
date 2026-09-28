import type { ExecEvent } from "./execution.js";

export interface SpawnRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
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
