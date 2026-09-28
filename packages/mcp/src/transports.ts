import type { SpawnedProcess } from "@hat/core";
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
    /* stateless */
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

  private async post(message: unknown): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(message),
      });
      const sessionId = response.headers.get("mcp-session-id");
      if (sessionId) this.sessionId = sessionId;

      if ((message as { id?: unknown }).id === undefined) return;

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data) continue;
              try {
                this.messageHandler(JSON.parse(data));
              } catch {
                /* ignore */
              }
            }
            index = buffer.indexOf("\n\n");
          }
        }
      } else {
        const data = await response.json().catch(() => undefined);
        if (data) this.messageHandler(data);
      }
    } catch (error) {
      this.closeHandler(error as Error);
    }
  }
}
