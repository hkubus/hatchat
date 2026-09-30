import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Logger, PluginContext, Tool } from "@hat/core";
import { JsonRpcClient, type Transport } from "./jsonrpc.js";
import { McpClient, connectHttp } from "./mcp.js";
import { createMcpPlugin, mcpToolName } from "./plugin.js";
import { HttpTransport } from "./transports.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A transport to a server that answers only what `reply` returns something for. */
class ScriptedTransport implements Transport {
  readonly sent: Array<{ id?: number; method?: string; params?: any }> = [];
  closed = false;
  private messageHandler: (message: unknown) => void = () => {};
  private closeHandler: (error?: Error) => void = () => {};

  constructor(private readonly reply: (message: { id?: number; method?: string; params?: any }) => unknown) {}

  send(message: unknown): void {
    const msg = message as { id?: number; method?: string; params?: any };
    this.sent.push(msg);
    const answer = this.reply(msg);
    if (answer !== undefined) queueMicrotask(() => this.messageHandler({ jsonrpc: "2.0", id: msg.id, result: answer }));
  }
  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }
  close(): void {
    this.closed = true;
    this.closeHandler();
  }
}

test("a request the server never answers times out, and the server is told", async () => {
  const transport = new ScriptedTransport(() => undefined);
  const rpc = new JsonRpcClient(transport);
  await assert.rejects(rpc.request("tools/call", {}, { timeoutMs: 30 }), /did not answer tools\/call/);
  const cancel = transport.sent.at(-1);
  assert.equal(cancel?.method, "notifications/cancelled");
  assert.equal(cancel?.params?.requestId, 1);
});

test("stopping a tool call abandons the request and cancels it on the server", async () => {
  const transport = new ScriptedTransport(() => undefined);
  const client = new McpClient(new JsonRpcClient(transport));
  const stop = new AbortController();
  const call = client.callTool("scan", {}, stop.signal);
  stop.abort();
  await assert.rejects(call, /cancelled/);
  assert.equal(transport.sent.at(-1)?.method, "notifications/cancelled");
});

test("closing the connection fails what is still waiting", async () => {
  const rpc = new JsonRpcClient(new ScriptedTransport(() => undefined));
  const waiting = rpc.request("tools/list");
  rpc.close();
  await assert.rejects(waiting, /closed/);
  await assert.rejects(rpc.request("tools/list"), /closed/);
});

test("every page of a paginated tool list is read", async () => {
  const pages: Record<string, unknown> = {
    first: { tools: [{ name: "a" }], nextCursor: "p2" },
    p2: { tools: [{ name: "b" }], nextCursor: "p3" },
    p3: { tools: [{ name: "c" }] },
  };
  const client = new McpClient(
    new JsonRpcClient(new ScriptedTransport((msg) => (msg.method === "tools/list" ? pages[msg.params?.cursor ?? "first"] : {}))),
  );
  assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["a", "b", "c"]);
});

/** A Streamable HTTP server whose answers the test scripts per method. */
async function httpServer(t: TestContext, handle: (method: string, id: unknown, res: ServerResponse) => void) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "DELETE") return res.writeHead(200).end();
      const message = JSON.parse(body) as { id?: unknown; method?: string };
      if (message.id === undefined) return res.writeHead(202).end();
      handle(message.method ?? "", message.id, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

const initialized = (id: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05" } });

test("an HTTP error answers the request instead of leaving it waiting", async (t) => {
  const url = await httpServer(t, (_method, _id, res) => res.writeHead(401).end("missing token"));
  await assert.rejects(connectHttp(url), /HTTP 401: missing token/);
});

test("an SSE answer framed with CRLF is read", async (t) => {
  const url = await httpServer(t, (_method, id, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: message\r\ndata: ${initialized(id)}\r\n\r\n`);
  });
  const connection = await connectHttp(url);
  connection.close();
});

test("a stream that ends without an answer, or an answer to nobody, fails the request", async (t) => {
  let call = 0;
  const url = await httpServer(t, (method, id, res) => {
    if (method === "initialize") return res.writeHead(200, { "content-type": "application/json" }).end(initialized(id));
    call += 1;
    if (call === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(": nothing to say\n\n");
    }
    // What a server that forgot the session sends back.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "unknown session" } }));
  });
  const connection = await connectHttp(url);
  await assert.rejects(connection.client.callTool("x", {}), /without answering/);
  await assert.rejects(connection.client.callTool("x", {}), /without answering/);
  connection.close();
});

test("closing an HTTP connection fails requests still in flight", async (t) => {
  const url = await httpServer(t, (method, id, res) => {
    if (method === "initialize") return res.writeHead(200, { "content-type": "application/json" }).end(initialized(id));
    // Never answers tools/call.
  });
  const rpc = new JsonRpcClient(new HttpTransport(url));
  await rpc.request("initialize", {});
  const waiting = rpc.request("tools/call", {});
  rpc.close();
  await assert.rejects(waiting, /closed/);
});

test("tool names that sanitize alike stay distinct", () => {
  const taken = new Set<string>();
  const names = [
    mcpToolName("srv", "get-item", taken),
    mcpToolName("srv", "get_item", taken),
    mcpToolName("a b", "x", taken),
    mcpToolName("a-b", "x", taken),
  ];
  assert.equal(new Set(names).size, 4);
  assert.equal(names[0], "mcp__srv__get_item");
  assert.match(names[1], /^mcp__srv__get_item_[0-9a-f]{8}$/);
});

test("a server whose tools collide still gets all of them registered", async () => {
  const registered: Tool[] = [];
  const plugin = createMcpPlugin();
  const ctx = {
    pluginId: "mcp",
    register: { tool: (tool: Tool) => registered.push(tool), provider() {} },
    getConfig: () => ({ servers: [{ name: "srv", transport: "http", url: "http://127.0.0.1:1/unused" }] }),
    logger,
    secrets: { get: async () => undefined },
  } as unknown as PluginContext;
  // No real server: swap in one that lists two tools whose names collide.
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const message = JSON.parse(String(init?.body)) as { id?: unknown; method?: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "tools/list" ? { tools: [{ name: "get-item" }, { name: "get_item" }] } : { protocolVersion: "2024-11-05" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await plugin.activate(ctx);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(registered.length, 2);
  assert.notEqual(registered[0].name, registered[1].name);
  await plugin.deactivate?.();
});
