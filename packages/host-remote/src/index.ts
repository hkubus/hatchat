import type {
  DirEntry,
  ExecEvent,
  ExecRequest,
  ExecutionHost,
  Fetcher,
  FetchRequest,
  FetchResponse,
  HostCapabilities,
  ScopedFs,
  WorkspaceInfo,
} from "@hat/core";

/**
 * Transport-level view of a connected runner. The server's link implementation
 * provides this; host-remote adapts it to the core ExecutionHost contract so
 * the kernel is unaware of the wire protocol.
 */
export interface RunnerChannel {
  readonly id: string;
  readonly capabilities: HostCapabilities;
  /** True once the link is gone; a replacement connection is a new channel. */
  readonly closed?: boolean;
  ensureWorkspace(sessionId: string): Promise<WorkspaceInfo>;
  exec(sessionId: string, req: ExecRequest, signal: AbortSignal): AsyncIterable<ExecEvent>;
  fsRead(sessionId: string, path: string): Promise<string>;
  fsWrite(sessionId: string, path: string, data: string): Promise<void>;
  fsList(sessionId: string, path: string): Promise<DirEntry[]>;
  netFetch(sessionId: string, req: FetchRequest & { url: string }): Promise<FetchResponse>;
}

export function createRemoteHost(channel: RunnerChannel, sessionId: string): ExecutionHost {
  const fs: ScopedFs = {
    read: (session, path) => channel.fsRead(session, path),
    write: (session, path, data) => channel.fsWrite(session, path, data),
    list: (session, path) => channel.fsList(session, path),
  };

  const net: Fetcher = {
    fetch: (input, init) => channel.netFetch(sessionId, { url: input, ...init }),
  };

  return {
    id: channel.id,
    capabilities: channel.capabilities,
    get closed() {
      return channel.closed ?? false;
    },
    ensureWorkspace: (session) => channel.ensureWorkspace(session),
    exec: (req, signal) => channel.exec(sessionId, req, signal),
    fs,
    net,
  };
}
