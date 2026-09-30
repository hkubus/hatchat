export interface Transport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface RequestOptions {
  /** Fail the request when no answer arrives within this long; 0 waits forever. */
  timeoutMs?: number;
  /** Abandon the request, telling the server so (`notifications/cancelled`). */
  signal?: AbortSignal;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/** How long a request waits for its answer unless told otherwise. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Minimal JSON-RPC 2.0 client with request/response correlation and handlers. */
export class JsonRpcClient {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();

  constructor(
    private readonly transport: Transport,
    private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    transport.onMessage((message) => void this.handle(message as RpcMessage));
    transport.onClose((error) => {
      this.closed = true;
      this.failAll(error ?? new Error("transport closed"));
    });
  }

  /**
   * Send a request and wait for its answer. Every request ends: with the
   * answer, an error, the timeout, the caller's signal, or the connection
   * closing. A server that never answers must not hold a tool call, and the
   * turn it belongs to, forever.
   */
  request<T>(method: string, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("MCP connection closed"));
    if (options.signal?.aborted) return Promise.reject(new Error("cancelled"));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      // Given up on here, so the server is told to stop working on it.
      const abandon = (error: Error): void => {
        settle();
        this.notify("notifications/cancelled", { requestId: id, reason: error.message });
        reject(error);
      };
      const onAbort = (): void => abandon(new Error("cancelled"));
      this.pending.set(id, {
        resolve: (value) => {
          settle();
          resolve(value as T);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          abandon(new Error(`MCP server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        timer.unref?.();
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.transport.send({ jsonrpc: "2.0", method, params });
  }

  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("MCP connection closed"));
    this.transport.close();
  }

  private failAll(error: Error): void {
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.pending.clear();
  }

  private async handle(message: RpcMessage): Promise<void> {
    if (message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number);
      if (message.error) pending.reject(new Error(message.error.message ?? "rpc error"));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.id !== null && message.method) {
      const handler = this.requestHandlers.get(message.method);
      if (!handler) {
        this.transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `method not found: ${message.method}` },
        });
        return;
      }
      try {
        const result = await handler(message.params);
        this.transport.send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
      } catch (error) {
        this.transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    if (message.method) {
      this.notificationHandlers.get(message.method)?.(message.params);
    }
  }
}
