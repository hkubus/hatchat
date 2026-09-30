import type { SpawnedProcess } from "@hat/core";
import { SseFrameParser } from "@hat/core";
import type { Transport } from "./jsonrpc.js";

/** Newline-delimited JSON-RPC over a spawned process's stdio. */
export class StdioTransport implements Transport {
  private buffer = "";
  private messageHandler: (message: unknown) => void = () => {};
  private closeHandler: (error?: Error) => void = () => {};

  constructor(private readonly process: SpawnedProcess) {
    void this.read();
  }

  send(message: unknown): void {
    this.process.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.process.endStdin();
    this.process.kill();
  }

  private async read(): Promise<void> {
    try {
      for await (const event of this.process.events) {
        if (event.type === "stdout") {
          this.buffer += event.data;
          let index = this.buffer.indexOf("\n");
          while (index !== -1) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (line) {
              try {
                this.messageHandler(JSON.parse(line));
              } catch {
                /* ignore non-JSON output */
              }
            }
            index = this.buffer.indexOf("\n");
          }
        } else if (event.type === "exit") {
          this.closeHandler(new Error(`MCP process exited (code ${event.code ?? event.signal})`));
          return;
        } else if (event.type === "error") {
          this.closeHandler(new Error(event.error.message));
          return;
        }
      }
    } catch (error) {
      this.closeHandler(error as Error);
    }
  }
}

/** MCP Streamable HTTP transport (JSON or SSE responses). */
export class HttpTransport implements Transport {
  private messageHandler: (message: unknown) => void = () => {};
  private closeHandler: (error?: Error) => void = () => {};
  private sessionId?: string;
  private closed = false;
  private readonly inflight = new Set<AbortController>();

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  send(message: unknown): void {
    void this.post(message);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.inflight) controller.abort();
    // Ends the session on the server, as the spec asks. Best effort.
    if (this.sessionId) {
      void fetch(this.url, { method: "DELETE", headers: this.headers() }).catch(() => undefined);
    }
    this.closeHandler(new Error("MCP connection closed"));
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  /**
   * POST one message. For a request, whatever happens ends in an answer for
   * its id: the server's, or an error standing in for it when the server
   * refused it (401, a 404 for a session it forgot), failed, or closed the
   * stream without answering. Otherwise the request would wait forever.
   */
  private async post(message: unknown): Promise<void> {
    if (this.closed) return;
    const { id, method } = message as { id?: unknown; method?: unknown };
    const isRequest = id !== undefined && method !== undefined;
    let answered = false;
    const deliver = (reply: unknown): void => {
      if ((reply as { id?: unknown } | null)?.id === id) answered = true;
      this.messageHandler(reply);
    };
    const fail = (reason: string): void => {
      if (isRequest && !answered) deliver({ jsonrpc: "2.0", id, error: { code: -32000, message: reason } });
    };
    const controller = new AbortController();
    this.inflight.add(controller);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;

      if (!isRequest) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok) {
        // A 404 means the server no longer knows this session (it restarted).
        if (response.status === 404) this.sessionId = undefined;
        const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
        fail(`MCP server answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
        return;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && response.body) {
        const parser = new SseFrameParser();
        const decoder = new TextDecoder();
        const take = (payloads: string[]): void => {
          for (const payload of payloads) {
            try {
              deliver(JSON.parse(payload));
            } catch {
              /* ignore */
            }
          }
        };
        const reader = response.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          take(parser.push(decoder.decode(value, { stream: true })));
        }
        take(parser.flush());
      } else {
        const data: unknown = await response.json().catch(() => undefined);
        for (const reply of Array.isArray(data) ? data : data === undefined ? [] : [data]) deliver(reply);
      }
      fail("MCP server closed the response without answering");
    } catch (error) {
      if (!this.closed) fail(error instanceof Error ? error.message : String(error));
    } finally {
      this.inflight.delete(controller);
    }
  }
}
