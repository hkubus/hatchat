import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ExecEvent,
  Logger,
  PluginContext,
  ProcessHost,
  SpawnedProcess,
  Tool,
  ToolContext,
} from "@hat/core";
import { AsyncQueue } from "@hat/core";
import { JsonRpcClient } from "./jsonrpc.js";
import { McpClient } from "./mcp.js";
import { createMcpPlugin } from "./plugin.js";
import type { Transport } from "./jsonrpc.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A transport that behaves like a tiny MCP server. */
class FakeMcpTransport implements Transport {
  private messageHandler: (message: unknown) => void = () => {};
  private closeHandler: (error?: Error) => void = () => {};

  send(message: unknown): void {
    const msg = message as { id?: number; method?: string; params?: any };
    queueMicrotask(() => {
      if (msg.method === "initialize") {
        this.messageHandler({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } });
      } else if (msg.method === "tools/list") {
        this.messageHandler({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] },
        });
      } else if (msg.method === "tools/call") {
        this.messageHandler({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: `echo:${msg.params?.arguments?.text ?? ""}` }] },
        });
      }
    });
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closeHandler();
  }
}

test("jsonrpc client correlates requests", async () => {
  const client = new JsonRpcClient(new FakeMcpTransport());
  const result = await client.request<{ protocolVersion: string }>("initialize", {});
  assert.equal(result.protocolVersion, "2024-11-05");
});

test("mcp client initializes, lists and calls tools", async () => {
  const client = new McpClient(new JsonRpcClient(new FakeMcpTransport()));
  await client.initialize();
  const tools = await client.listTools();
  assert.equal(tools[0].name, "echo");
  const result = await client.callTool("echo", { text: "hi" });
  assert.equal(result.content?.[0]?.text, "echo:hi");
});

/** A fake runner process that speaks MCP over "stdio". */
function fakeProcess(): SpawnedProcess {
  const queue = new AsyncQueue<ExecEvent>();
  return {
    id: "proc",
    events: queue,
    write(data: string) {
      for (const line of data.split("\n")) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; method?: string; params?: any };
        let result: unknown;
        if (msg.method === "initialize") result = { protocolVersion: "2024-11-05" };
        else if (msg.method === "tools/list")
          result = {
            tools: [
              {
                name: "echo",
                description: "echo",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
              },
            ],
          };
        else if (msg.method === "tools/call")
          result = { content: [{ type: "text", text: `mcp echo: ${msg.params?.arguments?.text ?? ""}` }] };
        if (msg.id !== undefined && result !== undefined) {
          queue.push({ type: "stdout", data: `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n` });
        }
      }
    },
    endStdin() {},
    kill() {},
  };
}

test("mcp plugin registers namespaced tools and calls them", async () => {
  const registered: Tool[] = [];
  const processHost: ProcessHost = { async spawn() { return fakeProcess(); } };
  const ctx: PluginContext = {
    pluginId: "mcp",
    register: {
      provider() {},
      tool(tool) {
        registered.push(tool);
      },
    },
    getConfig: (() => ({
      serversJson: JSON.stringify([{ name: "fake server", transport: "stdio", command: "node" }]),
      requireApproval: false,
    })) as PluginContext["getConfig"],
    secrets: { async get() { return undefined; } },
    processHost,
    logger,
  };

  const plugin = createMcpPlugin();
  await plugin.activate(ctx);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "mcp__fake_server__echo");
  assert.equal(registered[0].requiresApproval, false);
  assert.equal((registered[0].parameters as { type: string }).type, "object");

  const parts = await registered[0].execute({ text: "hi" }, {} as ToolContext);
  assert.equal(parts[0].type, "text");
  assert.match((parts[0] as { text: string }).text, /mcp echo: hi/);

  await plugin.deactivate?.();
});

test("mcp plugin fails cleanly without a runner", async () => {
  const ctx: PluginContext = {
    pluginId: "mcp",
    register: { provider() {}, tool() {} },
    getConfig: (() => ({
      serversJson: JSON.stringify([{ name: "x", transport: "stdio", command: "node" }]),
    })) as PluginContext["getConfig"],
    secrets: { async get() { return undefined; } },
    logger,
  };
  await assert.rejects(async () => {
    await createMcpPlugin().activate(ctx);
  }, /No runner connected/);
});

/**
 * A runner that drops mid-conversation must not make the tools disappear: the
 * model has already been given the tool list, and "Unknown tool" mid-turn is
 * worse than saying the runner is down.
 */
test("tools stay registered when the runner drops, and say so", async () => {
  const registered: Tool[] = [];
  let runnerUp = true;
  const processHost: ProcessHost = { async spawn() { return fakeProcess(); } };
  const ctx: PluginContext = {
    pluginId: "mcp",
    register: { provider() {}, tool(tool) { registered.push(tool); } },
    getConfig: (() => ({
      serversJson: JSON.stringify([{ name: "fake server", transport: "stdio", command: "node" }]),
      requireApproval: false,
    })) as PluginContext["getConfig"],
    secrets: { async get() { return undefined; } },
    processHost,
    runnerAvailable: () => runnerUp,
    logger,
  };

  const plugin = createMcpPlugin();
  await plugin.activate(ctx);
  assert.equal(registered.length, 1);

  const tool = registered[0];
  const online = await tool.execute({ text: "hi" }, {} as ToolContext);
  assert.match((online[0] as { text: string }).text, /mcp echo: hi/);

  runnerUp = false;
  // The tool is still registered — that is the point.
  assert.equal(registered.length, 1);
  const offline = await tool.execute({ text: "hi" }, {} as ToolContext);
  assert.match((offline[0] as { text: string }).text, /no runner is connected/i);

  // And it recovers without re-registration once a runner is back.
  runnerUp = true;
  const recovered = await tool.execute({ text: "again" }, {} as ToolContext);
  assert.match((recovered[0] as { text: string }).text, /mcp echo: again/);

  await plugin.deactivate?.();
});
