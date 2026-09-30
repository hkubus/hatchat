import type { Part, Plugin, ProcessHost, Tool } from "@hat/core";
import { z } from "zod";
import { connectHttp, connectStdio, type McpClient, type McpConnection, type McpTool } from "./mcp.js";

export const mcpServerSchema = z.object({
  name: z.string().min(1, "each MCP server needs a name"),
  transport: z.enum(["stdio", "http"]).optional().default("stdio"),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  url: z.string().optional(),
  token: z.string().optional(),
  trustReadOnlyHint: z.boolean().optional(),
});

export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const mcpConfigSchema = z.object({
  serversJson: z
    .string()
    .optional()
    .describe(
      'Legacy JSON array of MCP servers (kept for compatibility). Prefer "servers".',
    ),
  servers: z
    .array(mcpServerSchema)
    .optional()
    .describe(
      'MCP servers, e.g. [{"name":"fs","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/data"]}]. Use "transport":"http" with "url" for remote servers. Set "trustReadOnlyHint":false to require approval even for tools the server marks read-only.',
    ),
  requireApproval: z
    .boolean()
    .optional()
    .describe("Require approval before running MCP tools (recommended)."),
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;

export interface ServerConfig {
  name: string;
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  token?: string;
  trustReadOnlyHint?: boolean;
}

function normalizeServer(raw: unknown, index: number): ServerConfig {
  const parsed = mcpServerSchema.safeParse(raw);
  if (!parsed.success) {
    const label =
      typeof raw === "object" && raw !== null && "name" in raw && typeof (raw as { name: unknown }).name === "string" && (raw as { name: string }).name
        ? `"${(raw as { name: string }).name}"`
        : `#${index + 1}`;
    throw new Error(
      `MCP server ${label}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "value"} ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

export function parseServers(
  config: { serversJson?: string; servers?: unknown } | string | undefined,
): ServerConfig[] {
  const json = typeof config === "string" ? config : config?.serversJson;
  const structured = typeof config === "object" ? config?.servers : undefined;

  // Structured config wins when present; the legacy JSON string is the fallback
  // so old clients (and the raw-JSON editor) keep working.
  if (Array.isArray(structured)) {
    return (structured as unknown[]).map((entry, i) => normalizeServer(entry, i));
  }

  if (!json?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("serversJson is not valid JSON: expected an array of servers");
  }
  if (!Array.isArray(parsed)) throw new Error("serversJson must be a JSON array");
  return (parsed as unknown[]).map((entry, i) => normalizeServer(entry, i));
}

export function validateServers(servers: ServerConfig[]): void {
  const seen = new Set<string>();
  for (const server of servers) {
    if (!server.name?.trim()) throw new Error("each MCP server needs a name");
    if (seen.has(server.name)) throw new Error(`duplicate MCP server name: "${server.name}"`);
    seen.add(server.name);
    if ((server.transport ?? "stdio") === "http") {
      if (!server.url?.trim()) throw new Error(`MCP server "${server.name}": url is required for http transport`);
      if (!/^https?:\/\//i.test(server.url.trim())) {
        throw new Error(`MCP server "${server.name}": url must start with http:// or https://`);
      }
    } else if (!server.command?.trim()) {
      throw new Error(`MCP server "${server.name}": command is required for stdio transport`);
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * `mcp__<server>__<tool>`, unique among the names already `taken`.
 * Sanitizing folds distinct names together (`get-item` and `get_item`, or
 * servers "a b" and "a-b"), and a duplicate registration fails the whole
 * plugin, so a clash gets a short hash of the name it came from.
 */
export function mcpToolName(serverName: string, toolName: string, taken: Set<string>): string {
  let name = `mcp__${sanitize(serverName)}__${sanitize(toolName)}`;
  if (taken.has(name)) {
    let hash = 5381;
    for (const char of `${serverName}\u0000${toolName}`) hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
    name = `${name}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }
  taken.add(name);
  return name;
}

function toParts(result: { content?: unknown[]; isError?: boolean }): Part[] {
  const parts: Part[] = [];
  for (const item of (result.content ?? []) as Array<Record<string, unknown>>) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push({ type: "text", text: item.text });
    } else if (item.type === "image" && typeof item.data === "string") {
      parts.push({
        type: "image",
        source: { kind: "data", data: item.data, mime: String(item.mimeType ?? "image/png") },
      });
    } else if (item.type === "resource") {
      parts.push({ type: "text", text: JSON.stringify(item.resource ?? item).slice(0, 4000) });
    }
  }
  if (parts.length === 0) {
    parts.push({ type: "text", text: result.isError ? "MCP tool reported an error." : "(no content)" });
  }
  return parts;
}

/**
 * Annotations come from the server and are only hints, so anything short of an
 * explicit, non-destructive read-only claim from a trusted server still asks.
 */
export function mcpToolNeedsApproval(
  tool: McpTool,
  requireApproval: boolean,
  trustReadOnlyHint = true,
): boolean {
  if (!requireApproval) return false;
  const hints = tool.annotations;
  const readOnly = hints?.readOnlyHint === true && hints.destructiveHint !== true;
  return !(trustReadOnlyHint && readOnly);
}

function makeTool(
  name: string,
  serverName: string,
  tool: McpTool,
  client: McpClient,
  requireApproval: boolean,
  isRunnerUp: () => boolean,
): Tool {
  return {
    name,
    description: tool.description ?? `MCP tool "${tool.name}" from ${serverName}`,
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
    requiresApproval: requireApproval,
    async execute(args, ctx): Promise<Part[]> {
      // The stdio process lives on the runner, so it dies with it. The tool
      // stays registered on purpose: unregistering would make it disappear
      // from the model's tool list mid-turn, and "Unknown tool" is a far worse
      // answer than saying the runner is down.
      if (!isRunnerUp()) {
        return [
          {
            type: "text",
            text: `MCP server "${serverName}" is unavailable: no runner is connected. ` +
              `It will work again once a runner joins; try another tool meanwhile.`,
          },
        ];
      }
      const result = await client.callTool(tool.name, args ?? {}, ctx.signal);
      return toParts(result);
    },
  };
}

async function connectServer(server: ServerConfig, processHost: ProcessHost | undefined): Promise<McpConnection> {
  if ((server.transport ?? "stdio") === "http") {
    // validateServers guarantees url is present for http servers.
    return connectHttp(server.url ?? "", server.token);
  }
  if (!processHost) {
    throw new Error("No runner connected; stdio MCP servers need a runner.");
  }
  try {
    return await connectStdio(processHost, {
      // validateServers guarantees command is present for stdio servers.
      command: server.command ?? "",
      args: server.args,
      env: server.env,
    });
  } catch (error) {
    // The usual cause at boot is that no runner has dialed in yet. The
    // server reactivates this plugin when one does, so say so instead
    // of leaving a bare spawn failure in the plugin list.
    throw new Error(
      `MCP server ${server.name}: ${error instanceof Error ? error.message : String(error)} ` +
        `(stdio servers run on the runner; this retries when one connects)`,
    );
  }
}

export function createMcpPlugin(): Plugin {
  const connections = new Map<string, { close: () => void }>();

  return {
    id: "mcp",
    name: "MCP servers",
    version: "0.1.0",
    description:
      "Connect to Model Context Protocol servers — stdio (on the runner) or streamable HTTP — and expose their tools.",
    permissions: ["runner:process", "net:mcp"],
    configSchema: mcpConfigSchema,

    async activate(ctx) {
      const config = ctx.getConfig<{ serversJson?: string; servers?: unknown; requireApproval?: boolean }>();
      const servers = parseServers(config);
      validateServers(servers);
      const requireApproval = config.requireApproval ?? true;
      const isRunnerUp = ctx.runnerAvailable ?? (() => Boolean(ctx.processHost));
      const taken = new Set<string>();

      try {
        for (const server of servers) {
          const connection = await connectServer(server, ctx.processHost);
          connections.set(server.name, { close: connection.close });
          const tools = await connection.client.listTools();
          for (const tool of tools) {
            const needsApproval = mcpToolNeedsApproval(tool, requireApproval, server.trustReadOnlyHint ?? true);
            const name = mcpToolName(server.name, tool.name, taken);
            ctx.register.tool(makeTool(name, server.name, tool, connection.client, needsApproval, isRunnerUp));
          }
          ctx.logger.info(`connected ${server.name}: ${tools.length} tool(s)`);
        }
      } catch (error) {
        // The host drops the tools registered so far; the connections are
        // this plugin's to close, or their processes outlive it.
        closeAll();
        throw error;
      }
    },

    deactivate() {
      closeAll();
    },
  };

  function closeAll(): void {
    for (const connection of connections.values()) {
      try {
        connection.close();
      } catch {
        /* ignore */
      }
    }
    connections.clear();
  }
}
