// Shared by the server and the isolated plugin process. The plugin side loads
// this with Node's native type stripping, so it must stay erasable TypeScript:
// no enums, namespaces or constructor parameter properties.
import { AsyncQueue, normalizeError } from "@hat/core";

/**
 * Wire messages of the plugin IPC channel. The channel is symmetric: either
 * end can issue requests, stream events back for a request (`evt`), cancel a
 * request it issued, or send fire-and-forget notifications (`note`).
 */
export type RpcMessage =
  | { k: "req"; id: number; method: string; params: unknown }
  | { k: "evt"; id: number; data: unknown }
  | { k: "res"; id: number; ok: true; value: unknown }
  | { k: "res"; id: number; ok: false; error: { message: string; code?: string } }
  | { k: "cancel"; id: number }
  | { k: "note"; method: string; params: unknown };

export interface RpcHandlerContext {
  /** Aborted when the caller cancels the request or the channel closes. */
  signal: AbortSignal;
  /** Stream an event back to the caller before the final result. */
  emit(data: unknown): void;
}

// Params cross a process boundary, so handlers must validate them.
export type RpcHandler = (params: any, ctx: RpcHandlerContext) => unknown;
export type RpcNoteHandler = (params: any) => void;

export interface RpcRequestOptions {
  signal?: AbortSignal;
  onEvent?(data: unknown): void;
}

/** A request failure reported by the other end (or by a closed channel). */
export class RpcError extends Error {
  readonly code: string;

  constructor(message: string, code = "rpc_error") {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  onEvent?(data: unknown): void;
}

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly running = new Map<number, AbortController>();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly noteHandlers = new Map<string, RpcNoteHandler>();
  private closed: Error | undefined;
  private readonly send: (message: RpcMessage) => void;

  constructor(send: (message: RpcMessage) => void) {
    this.send = send;
  }

  handle(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  on(method: string, handler: RpcNoteHandler): void {
    this.noteHandlers.set(method, handler);
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.trySend({ k: "note", method, params });
  }

  request<T = unknown>(method: string, params: unknown, options: RpcRequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const { signal, onEvent } = options;
    if (signal?.aborted) return Promise.reject(new RpcError("aborted", "aborted"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        this.trySend({ k: "cancel", id });
        reject(new RpcError("aborted", "aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const settle = (): void => signal?.removeEventListener("abort", onAbort);
      this.pending.set(id, {
        resolve: (value) => {
          settle();
          resolve(value as T);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
        onEvent,
      });
      const failure = this.trySend({ k: "req", id, method, params });
      if (failure) {
        this.pending.delete(id);
        settle();
        reject(failure);
      }
    });
  }

  /**
   * A request whose `evt` messages are consumed as an async iterable. Leaving
   * the loop early (or aborting `signal`) cancels the request on the other end.
   */
  async *stream<T>(method: string, params: unknown, signal?: AbortSignal): AsyncGenerator<T> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const queue = new AsyncQueue<T>();
    this.request(method, params, {
      signal: controller.signal,
      onEvent: (data) => queue.push(data as T),
    }).then(
      () => queue.end(),
      (error) => queue.fail(error),
    );
    try {
      yield* queue;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }

  /** Dispatch one inbound message. Malformed messages are dropped. */
  receive(raw: unknown): void {
    if (this.closed || !raw || typeof raw !== "object") return;
    const message = raw as RpcMessage;
    switch (message.k) {
      case "req":
        void this.serve(message.id, message.method, message.params);
        return;
      case "evt":
        this.pending.get(message.id)?.onEvent?.(message.data);
        return;
      case "res": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.ok) {
          pending.resolve(message.value);
        } else {
          const error = message.error ?? { message: "request failed" };
          pending.reject(new RpcError(String(error.message), error.code));
        }
        return;
      }
      case "cancel":
        this.running.get(message.id)?.abort();
        return;
      case "note":
        this.noteHandlers.get(message.method)?.(message.params);
        return;
    }
  }

  /** Fail every outstanding request and abort every running handler. */
  close(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }

  private async serve(id: number, method: string, params: unknown): Promise<void> {
    if (typeof id !== "number" || this.running.has(id)) return;
    const handler = this.handlers.get(method);
    if (!handler) {
      this.trySend({ k: "res", id, ok: false, error: { message: `unknown method: ${method}` } });
      return;
    }
    const controller = new AbortController();
    this.running.set(id, controller);
    const ctx: RpcHandlerContext = {
      signal: controller.signal,
      emit: (data) => {
        if (!controller.signal.aborted) this.trySend({ k: "evt", id, data });
      },
    };
    let reply: RpcMessage;
    try {
      reply = { k: "res", id, ok: true, value: await handler(params, ctx) };
    } catch (error) {
      reply = { k: "res", id, ok: false, error: wireError(error) };
    }
    if (!this.running.delete(id)) return;
    if (controller.signal.aborted) return;
    const failure = this.trySend(reply);
    if (failure && reply.ok) {
      // e.g. a result that can't be serialized.
      this.trySend({ k: "res", id, ok: false, error: wireError(failure) });
    }
  }

  private trySend(message: RpcMessage): Error | undefined {
    try {
      this.send(message);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}

function wireError(error: unknown): { message: string; code?: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    message: normalizeError(error).message,
    code: typeof code === "string" ? code : undefined,
  };
}
