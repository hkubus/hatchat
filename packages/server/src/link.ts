import type { Server } from "node:http";
import type {
  DirEntry,
  ExecEvent,
  ExecRequest,
  FetchRequest,
  FetchResponse,
  HostCapabilities,
  Logger,
  SpawnRequest,
  SpawnedProcess,
  WorkspaceInfo,
} from "@hat/core";
import { AsyncQueue, newId } from "@hat/core";
import type { RunnerChannel } from "@hat/host-remote";
import {
  PROTOCOL_VERSION,
  encodeLinkMessage,
  parseRunnerToServer,
  type RunnerToServer,
  type ServerToRunner,
} from "@hat/runner-protocol";
import { WebSocketServer, type WebSocket } from "ws";

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface LinkTimings {
  /** How long a request may wait for its answer before it fails. */
  rpcTimeoutMs?: number;
  /** How often each runner is pinged; one that misses a ping is dropped. */
  pingIntervalMs?: number;
}

const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;

export interface RunnerRequirements {
  tags?: string[];
  os?: string;
  runtimes?: string[];
}

export interface RunnerCandidate {
  id: string;
  capabilities: HostCapabilities;
  load: number;
}

function matchesRequirements(candidate: RunnerCandidate, requirements: RunnerRequirements): boolean {
  const caps = candidate.capabilities;
  if (requirements.tags?.some((tag) => !caps.tags.includes(tag))) return false;
  if (requirements.os && caps.os !== requirements.os) return false;
  if (requirements.runtimes?.some((runtime) => !caps.runtimes.includes(runtime))) return false;
  return true;
}

/**
 * Pick a runner for a request: filter by requirements, then choose the least
 * busy. With no requirements, all runners are candidates.
 */
export function selectRunner<T extends RunnerCandidate>(
  runners: T[],
  requirements: RunnerRequirements = {},
): T | undefined {
  const hasRequirements =
    (requirements.tags?.length ?? 0) > 0 ||
    requirements.os !== undefined ||
    (requirements.runtimes?.length ?? 0) > 0;

  const candidates = hasRequirements
    ? runners.filter((runner) => matchesRequirements(runner, requirements))
    : [...runners];

  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => a.load - b.load)[0];
}

/** A single connected runner, adapted to the RunnerChannel transport contract. */
export class RunnerConnection implements RunnerChannel {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly jobs = new Map<string, AsyncQueue<ExecEvent>>();
  private readonly procs = new Map<string, AsyncQueue<ExecEvent>>();
  /** Why the link went away; set once by `fail`. */
  private closedReason: string | undefined;

  constructor(
    private readonly ws: WebSocket,
    readonly id: string,
    readonly capabilities: HostCapabilities,
    private readonly log: Logger,
    private readonly rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ) {}

  /** In-flight work on this runner (jobs + long-lived processes). */
  get load(): number {
    return this.jobs.size + this.procs.size;
  }

  /**
   * True once the link is gone. Nothing sent on it would ever be answered, so
   * new requests fail straight away, and whoever still holds this connection
   * (a cached execution host) knows to acquire a runner again.
   */
  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  handleMessage(message: RunnerToServer): void {
    switch (message.t) {
      case "heartbeat":
        return;
      case "workspace.ok":
        this.settle(message.reqId, {
          sessionId: message.sessionId,
          root: message.root,
        } satisfies WorkspaceInfo);
        return;
      case "exec.stdout":
        this.jobs.get(message.jobId)?.push({ type: "stdout", data: message.chunk });
        return;
      case "exec.stderr":
        this.jobs.get(message.jobId)?.push({ type: "stderr", data: message.chunk });
        return;
      case "exec.exit": {
        const queue = this.jobs.get(message.jobId);
        queue?.push({
          type: "exit",
          code: message.code,
          signal: message.signal,
          durationMs: message.durationMs,
        });
        queue?.end();
        this.jobs.delete(message.jobId);
        return;
      }
      case "proc.stdout":
        this.procs.get(message.procId)?.push({ type: "stdout", data: message.chunk });
        return;
      case "proc.stderr":
        this.procs.get(message.procId)?.push({ type: "stderr", data: message.chunk });
        return;
      case "proc.exit": {
        const queue = this.procs.get(message.procId);
        queue?.push({
          type: "exit",
          code: message.code,
          signal: message.signal,
          durationMs: message.durationMs,
        });
        queue?.end();
        this.procs.delete(message.procId);
        return;
      }
      case "fs.read.result":
        this.settle(message.reqId, message.data);
        return;
      case "fs.write.result":
        this.settle(message.reqId, undefined);
        return;
      case "fs.list.result":
        this.settle(message.reqId, message.entries);
        return;
      case "net.fetch.result":
        this.settle(message.reqId, message.response);
        return;
      case "job.error": {
        if (message.jobId) {
          const queue = this.jobs.get(message.jobId);
          queue?.push({ type: "error", error: message.error });
          queue?.end();
          this.jobs.delete(message.jobId);
        }
        if (message.procId) {
          const queue = this.procs.get(message.procId);
          queue?.push({ type: "error", error: message.error });
          queue?.end();
          this.procs.delete(message.procId);
        }
        if (message.reqId) {
          this.reject(message.reqId, new Error(message.error.message));
        }
        return;
      }
    }
  }

  ensureWorkspace(sessionId: string): Promise<WorkspaceInfo> {
    return this.rpc<WorkspaceInfo>((reqId) => ({ t: "workspace.ensure", reqId, sessionId }));
  }

  exec(sessionId: string, req: ExecRequest, signal: AbortSignal): AsyncIterable<ExecEvent> {
    const jobId = newId("job");
    const queue = new AsyncQueue<ExecEvent>();
    // A closed link would swallow the job, and a cancel sent ahead of the start
    // is ignored by the runner, which would then run the command anyway.
    if (this.closedReason !== undefined || signal.aborted) {
      queue.fail(new Error(this.closedReason ?? "cancelled"));
      return queue;
    }
    this.jobs.set(jobId, queue);

    const onAbort = (): void => {
      if (!this.closed) this.send({ t: "exec.cancel", jobId });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    this.send({
      t: "exec.start",
      jobId,
      sessionId,
      command: req.command,
      cwd: req.cwd,
      env: req.env,
      timeoutMs: req.timeoutMs,
      stdin: req.stdin,
    });

    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      this.jobs.delete(jobId);
    };

    return {
      [Symbol.asyncIterator]() {
        const inner = queue[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<ExecEvent>> {
            const result = await inner.next();
            if (result.done) cleanup();
            return result;
          },
          async return(): Promise<IteratorResult<ExecEvent>> {
            cleanup();
            return { done: true, value: undefined as never };
          },
        };
      },
    };
  }

  spawn(request: SpawnRequest): Promise<SpawnedProcess> {
    if (this.closedReason !== undefined) return Promise.reject(new Error(this.closedReason));
    const procId = newId("proc");
    const queue = new AsyncQueue<ExecEvent>();
    this.procs.set(procId, queue);
    this.send({
      t: "proc.start",
      procId,
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      sessionId: request.sessionId,
      shell: request.shell,
    });
    return Promise.resolve({
      id: procId,
      events: queue,
      write: (data: string) => this.send({ t: "proc.stdin", procId, chunk: data }),
      endStdin: () => this.send({ t: "proc.stdin.end", procId }),
      kill: () => this.send({ t: "proc.cancel", procId }),
    });
  }

  fsRead(sessionId: string, path: string): Promise<string> {
    return this.rpc<string>((reqId) => ({ t: "fs.read", reqId, sessionId, path }));
  }

  async fsWrite(sessionId: string, path: string, data: string): Promise<void> {
    await this.rpc<void>((reqId) => ({ t: "fs.write", reqId, sessionId, path, data }));
  }

  fsList(sessionId: string, path: string): Promise<DirEntry[]> {
    return this.rpc<DirEntry[]>((reqId) => ({ t: "fs.list", reqId, sessionId, path }));
  }

  netFetch(
    sessionId: string,
    req: FetchRequest & { url: string },
  ): Promise<FetchResponse> {
    return this.rpc<FetchResponse>((reqId) => ({
      t: "net.fetch",
      reqId,
      sessionId,
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
    }));
  }

  fail(reason: string): void {
    if (this.closed) return;
    this.closedReason = reason;
    for (const queue of this.jobs.values()) queue.fail(new Error(reason));
    this.jobs.clear();
    for (const queue of this.procs.values()) queue.fail(new Error(reason));
    this.procs.clear();
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }

  close(): void {
    this.ws.close();
  }

  private send(message: ServerToRunner): void {
    if (!this.closed) this.ws.send(encodeLinkMessage(message));
  }

  private rpc<T>(build: (reqId: string) => ServerToRunner): Promise<T> {
    if (this.closedReason !== undefined) return Promise.reject(new Error(this.closedReason));
    const reqId = newId("req");
    return new Promise<T>((resolve, reject) => {
      // A runner that is connected but stuck (a file read on a stalled disk)
      // would otherwise leave the tool call, and its turn, waiting forever.
      const timer = setTimeout(() => {
        this.reject(reqId, new Error(`runner ${this.id} did not answer within ${Math.round(this.rpcTimeoutMs / 1000)}s`));
      }, this.rpcTimeoutMs);
      timer.unref?.();
      this.pending.set(reqId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send(build(reqId));
    });
  }

  private settle(reqId: string, value: unknown): void {
    const pending = this.pending.get(reqId);
    if (!pending) return;
    this.pending.delete(reqId);
    pending.resolve(value);
  }

  private reject(reqId: string, error: unknown): void {
    const pending = this.pending.get(reqId);
    if (!pending) return;
    this.pending.delete(reqId);
    pending.reject(error);
  }
}

/** Accepts outbound runner connections and tracks what is connected. */
export class RunnerRegistry {
  private readonly runners = new Map<string, RunnerConnection>();
  private wss?: WebSocketServer;

  constructor(
    private readonly log: Logger,
    private readonly enrollToken: string,
    /**
     * Called after a runner joins or leaves. Plugins that spawn processes
     * through the runner (MCP stdio servers) have to be reactivated, because
     * they are wired at activation time and would otherwise stay failed until
     * the next restart.
     */
    private readonly onAvailabilityChange?: (available: boolean) => void,
    private readonly timings: LinkTimings = {},
  ) {}

  attach(server: Server): void {
    const wss = new WebSocketServer({ server, path: "/link" });
    this.wss = wss;
    wss.on("connection", (ws) => this.onConnection(ws));
    this.log.info("runner link listening on /link");
  }

  list(): RunnerConnection[] {
    return [...this.runners.values()];
  }

  /** The live connection of a runner, if it is connected. */
  get(id: string): RunnerConnection | undefined {
    return this.runners.get(id);
  }

  /** Total in-flight jobs + processes across all runners. */
  loadOf(id: string): number {
    return this.runners.get(id)?.load ?? 0;
  }

  acquire(requirements: RunnerRequirements = {}): RunnerConnection | undefined {
    const candidates: RunnerCandidate[] = this.list().map((runner) => ({
      id: runner.id,
      capabilities: runner.capabilities,
      load: runner.load,
    }));
    const selected = selectRunner(candidates, requirements);
    return selected ? this.runners.get(selected.id) : undefined;
  }

  close(): void {
    for (const runner of this.runners.values()) runner.close();
    this.wss?.close();
  }

  private onConnection(ws: WebSocket): void {
    let connection: RunnerConnection | undefined;
    let established = false;

    const handshake = setTimeout(() => {
      if (!established) ws.close(4001, "handshake timeout");
    }, 5000);

    ws.on("message", (data) => {
      let message: RunnerToServer;
      try {
        message = parseRunnerToServer(data.toString());
      } catch (error) {
        this.log.warn("dropping malformed runner message", String(error));
        return;
      }

      if (!established) {
        if (message.t !== "hello") {
          ws.close(4002, "expected hello");
          return;
        }
        if (message.v !== PROTOCOL_VERSION) {
          ws.close(4003, `protocol version mismatch (server v${PROTOCOL_VERSION})`);
          return;
        }
        // Strict equality (normalized): empty configured token only matches
        // an empty hello, so tests with "" still pass but any mismatch rejects.
        // Production must set a random HAT_ENROLL_TOKEN (warned in config).
        if ((message.enrollToken ?? "") !== this.enrollToken) {
          ws.close(4004, "invalid enroll token");
          this.log.warn("runner rejected: invalid enroll token", message.runnerId);
          return;
        }

        established = true;
        clearTimeout(handshake);

        const id = message.runnerId;
        // A reconnect under the same id supersedes the old socket. Fail it
        // explicitly: its close handler is a no-op now that the map points at
        // the replacement, and its pending RPCs would otherwise hang.
        const previous = this.runners.get(id);
        // Sampled before the entry is dropped: a same-id reconnect must not
        // look like the fleet emptying out and refilling.
        const wasEmpty = this.runners.size === 0;
        this.runners.delete(id);
        previous?.close();
        previous?.fail("superseded by a newer connection");

        connection = new RunnerConnection(ws, id, message.caps, this.log, this.timings.rpcTimeoutMs);
        this.runners.set(id, connection);
        ws.send(encodeLinkMessage({ t: "hello.ok", runnerId: id }));
        this.log.info(`runner connected: ${id} (${message.caps.os}/${message.caps.arch}) tags=${message.caps.tags.join(",")}`);
        if (wasEmpty) this.onAvailabilityChange?.(true);

        // A runner that vanished without closing its socket (power loss, a
        // network partition) would keep its requests waiting until TCP gives
        // up, which can take hours. The runner's socket answers pings on its
        // own; one that misses a ping is dropped, and its requests fail.
        let answered = true;
        ws.on("pong", () => {
          answered = true;
        });
        const ping = setInterval(() => {
          if (!answered) {
            this.log.warn(`runner ${id} stopped answering; dropping it`);
            ws.terminate();
            return;
          }
          answered = false;
          ws.ping();
        }, this.timings.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS);
        ping.unref?.();

        ws.on("close", () => {
          clearInterval(ping);
          if (this.runners.get(id) !== connection) return;
          this.runners.delete(id);
          connection?.fail("link closed");
          this.log.info(`runner disconnected: ${id}`);
          if (this.runners.size === 0) this.onAvailabilityChange?.(false);
        });
        return;
      }

      connection?.handleMessage(message);
    });

    ws.on("error", (error) => {
      this.log.warn("runner link error", String(error));
    });

    ws.on("close", () => {
      clearTimeout(handshake);
    });
  }
}
