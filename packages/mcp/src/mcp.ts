import type { ProcessHost, SpawnRequest } from "@hat/core";
import { JsonRpcClient } from "./jsonrpc.js";
import { HttpTransport, StdioTransport } from "./transports.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: unknown;
  [key: string]: unknown;
}

export interface McpToolResult {
  content?: McpContent[];
  isError?: boolean;
}

export interface McpConnection {
  client: McpClient;
  close: () => void;
}

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export class McpClient {
  constructor(readonly rpc: JsonRpcClient) {}

  async initialize(clientName = "hat", version = "0.1.0"): Promise<void> {
    await this.rpc.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version },
    });
    this.rpc.notify("notifications/initialized");
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.rpc.request<{ tools?: McpTool[] }>("tools/list", {});
    return result.tools ?? [];
  }

  callTool(name: string, args: unknown): Promise<McpToolResult> {
    return this.rpc.request<McpToolResult>("tools/call", { name, arguments: args ?? {} });
  }

  onToolsChanged(handler: () => void): void {
    this.rpc.onNotification("notifications/tools/list_changed", handler);
  }

  close(): void {
    this.rpc.close();
  }
}

export async function connectStdio(
  processHost: ProcessHost,
  request: SpawnRequest,
): Promise<McpConnection> {
  const process = await processHost.spawn(request);
  const client = new McpClient(new JsonRpcClient(new StdioTransport(process)));
  await client.initialize();
  return {
    client,
    close: () => {
      client.close();
      process.kill();
    },
  };
}

export async function connectHttp(url: string, token?: string): Promise<McpConnection> {
  const client = new McpClient(new JsonRpcClient(new HttpTransport(url, token)));
  await client.initialize();
  return { client, close: () => client.close() };
}
