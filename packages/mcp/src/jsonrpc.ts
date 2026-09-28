export interface Transport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (error?: Error) => void): void;
  close(): void;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/** Minimal JSON-RPC 2.0 client with request/response correlation and handlers. */
export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown>();
  private readonly notificationHandlers = new Map<string, (params: unknown) => void>();

  constructor(private readonly transport: Transport) {
    transport.onMessage((message) => void this.handle(message as RpcMessage));
    transport.onClose((error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error ?? new Error("transport closed"));
      }
      this.pending.clear();
    });
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport.send({ jsonrpc: "2.0", method, params });
  }

  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  close(): void {
    this.transport.close();
  }

  private async handle(message: RpcMessage): Promise<void> {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id as number);
      if (!pending) return;
      this.pending.delete(message.id as number);
      if (message.error) pending.reject(new Error(message.error.message ?? "rpc error"));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
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
