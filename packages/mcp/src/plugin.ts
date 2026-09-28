import type { Part, Plugin, Tool } from "@hat/core";
import { z } from "zod";
import { connectHttp, connectStdio, type McpClient, type McpTool } from "./mcp.js";

export const mcpConfigSchema = z.object({
  serversJson: z
    .string()
    .optional()
    .describe(
      'JSON array of MCP servers, e.g. [{"name":"fs","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/data"]}]. Use "transport":"http" with "url" for remote servers.',
    ),
  requireApproval: z
    .boolean()
    .optional()
    .describe("Require approval before running MCP tools (recommended)."),
});

interface ServerConfig {
  name: string;
  transport?: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  token?: string;
}

function parseServers(json: string | undefined): ServerConfig[] {
  if (!json?.trim()) return [];
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("serversJson must be a JSON array");
  return parsed as ServerConfig[];
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
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

function makeTool(
  serverName: string,
  tool: McpTool,
  client: McpClient,
  requireApproval: boolean,
): Tool {
  return {
    name: `mcp__${sanitize(serverName)}__${sanitize(tool.name)}`,
    description: tool.description ?? `MCP tool "${tool.name}" from ${serverName}`,
    parameters: tool.inputSchema ?? { type: "object", properties: {} },
    requiresApproval: requireApproval,
    async execute(args): Promise<Part[]> {
      const result = await client.callTool(tool.name, args ?? {});
      return toParts(result);
    },
  };
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
      const config = ctx.getConfig<{ serversJson?: string; requireApproval?: boolean }>();
      const servers = parseServers(config.serversJson);
      const requireApproval = config.requireApproval ?? true;

      for (const server of servers) {
        if (!server.name) throw new Error("each MCP server needs a name");
        let connection;
        if ((server.transport ?? "stdio") === "http") {
          if (!server.url) throw new Error(`MCP server ${server.name}: url is required`);
          connection = await connectHttp(server.url, server.token);
        } else {
          if (!ctx.processHost) {
            throw new Error("No runner connected; stdio MCP servers need a runner.");
          }
          if (!server.command) {
            throw new Error(`MCP server ${server.name}: command is required`);
          }
          connection = await connectStdio(ctx.processHost, {
            command: server.command,
            args: server.args,
            env: server.env,
          });
        }

        connections.set(server.name, { close: connection.close });
        const tools = await connection.client.listTools();
        for (const tool of tools) {
          ctx.register.tool(makeTool(server.name, tool, connection.client, requireApproval));
        }
        ctx.logger.info(`connected ${server.name}: ${tools.length} tool(s)`);
      }
    },

    deactivate() {
      for (const connection of connections.values()) {
        try {
          connection.close();
        } catch {
          /* ignore */
        }
      }
      connections.clear();
    },
  };
}
