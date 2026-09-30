import type { ProcessHost, SpawnRequest } from "@hat/core";
import { z } from "zod";
import { JsonRpcClient } from "./jsonrpc.js";
import { HttpTransport, StdioTransport } from "./transports.js";

/** Behaviour hints a server may attach to a tool. Untrusted, like all hints. */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: McpToolAnnotations;
}

// A malformed optional field is dropped rather than failing the whole
// tools/list: a hint that is not exactly a boolean is treated as absent.
const hint = z.boolean().optional().catch(undefined);

const annotationsSchema = z.object({
  title: z.string().optional().catch(undefined),
  readOnlyHint: hint,
  destructiveHint: hint,
  idempotentHint: hint,
  openWorldHint: hint,
});

const toolSchema = z.object({
  name: z.string(),
  description: z.string().optional().catch(undefined),
  inputSchema: z.unknown().optional(),
  annotations: annotationsSchema.optional().catch(undefined),
});

/** Parses one `tools/list` entry; undefined when it has no usable name. */
export function parseMcpTool(raw: unknown): McpTool | undefined {
  const parsed = toolSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
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

const MAX_TOOL_PAGES = 50;
const TOOL_CALL_TIMEOUT_MS = 10 * 60_000;

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

  /** Every page of the tool list: a server may split it, with `nextCursor`. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    // A cap, so a server handing back the same cursor can't spin forever.
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.rpc.request<{ tools?: unknown; nextCursor?: unknown }>(
        "tools/list",
        cursor ? { cursor } : {},
      );
      if (Array.isArray(result?.tools)) tools.push(...result.tools.flatMap((raw) => parseMcpTool(raw) ?? []));
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /**
   * Call a tool. Some do real work (a scan, a build) and take minutes, so the
   * limit is generous; stopping the turn ends the call at once, and tells the
   * server to stop too.
   */
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpToolResult> {
    return this.rpc.request<McpToolResult>(
      "tools/call",
      { name, arguments: args ?? {} },
      { signal, timeoutMs: TOOL_CALL_TIMEOUT_MS },
    );
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
  try {
    await client.initialize();
  } catch (error) {
    // A server that never finished starting would otherwise be left running.
    client.close();
    process.kill();
    throw error;
  }
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
  try {
    await client.initialize();
  } catch (error) {
    client.close();
    throw error;
  }
  return { client, close: () => client.close() };
}
