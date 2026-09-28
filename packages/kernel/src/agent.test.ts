import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ApprovalRequest,
  ChatMessage,
  ExecutionHost,
  KernelEvent,
  Logger,
  Part,
  Provider,
  Tool,
  ToolPolicy,
} from "@hat/core";
import { DEFAULT_CAPABILITIES, DEFAULT_TOOL_POLICY, newId } from "@hat/core";
import { z } from "zod";
import { Agent } from "./agent.js";
import { ProviderRegistry, ToolRegistry } from "./registries.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function tool(): Tool {
  return {
    name: "loop_tool",
    description: "test",
    schema: z.object({}),
    requiresApproval: true,
    async execute() {
      return [{ type: "text", text: "ok" }];
    },
  };
}

/** Emits the same tool call every turn, forever. */
function loopingProvider(counter: { calls: number }): Provider {
  return {
    id: "loop",
    label: "loop",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES, toolCalls: true }),
    listModels: async () => [],
    async *chat() {
      counter.calls += 1;
      yield { type: "toolcall", call: { id: newId("call"), name: "loop_tool", args: { x: 1 } } };
      yield { type: "done", finishReason: "tool_calls" as const };
    },
  };
}

/** Emits one tool call, then plain text and stops. */
function onceProvider(): Provider {
  let first = true;
  return {
    id: "once",
    label: "once",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES, toolCalls: true }),
    listModels: async () => [],
    async *chat() {
      if (first) {
        first = false;
        yield { type: "toolcall", call: { id: newId("call"), name: "loop_tool", args: { x: 1 } } };
        yield { type: "done", finishReason: "tool_calls" as const };
        return;
      }
      yield { type: "text.delta", text: "done" };
      yield { type: "done", finishReason: "stop" as const };
    },
  };
}

async function runAgent(
  provider: Provider,
  policy: Partial<ToolPolicy>,
  onApproval?: (req: ApprovalRequest) => void,
): Promise<KernelEvent[]> {
  const providers = new ProviderRegistry();
  providers.register(provider);
  const tools = new ToolRegistry();
  tools.register(tool());

  const agent = new Agent({
    providers,
    tools,
    resolveHost: async () => ({}) as ExecutionHost,
    approval: {
      async request(req) {
        onApproval?.(req);
        return "approve";
      },
    },
    secrets: { async get() { return undefined; } },
    audit: { record() {} },
    logger,
  });

  const events: KernelEvent[] = [];
  for await (const event of agent.run({
    sessionId: "s1",
    history: [],
    model: `${provider.id}/m`,
    userText: "go",
    signal: new AbortController().signal,
    toolPolicy: { ...DEFAULT_TOOL_POLICY, maxIterations: 10, ...policy },
  })) {
    events.push(event);
  }
  return events;
}

test("loop guard stops repeated identical tool calls", async () => {
  const counter = { calls: 0 };
  const events = await runAgent(loopingProvider(counter), { maxDuplicateCalls: 3 });

  const results = events.filter((e) => e.type === "tool.result") as Array<{
    isError: boolean;
    parts: Array<{ type: string; text?: string }>;
  }>;
  const last = results.at(-1);
  assert.equal(last?.isError, true);
  assert.match(last?.parts[0]?.text ?? "", /Loop guard/);
  // 3 executions then the guard trips on the 4th call.
  assert.equal(counter.calls, 4);
});

test("auto policy executes without asking", async () => {
  let approvals = 0;
  const events = await runAgent(onceProvider(), { mode: "auto" }, () => {
    approvals += 1;
  });
  const result = events.find((e) => e.type === "tool.result") as { isError: boolean };
  assert.equal(result.isError, false);
  assert.equal(approvals, 0);
});

test("ask policy requests approval", async () => {
  let approvals = 0;
  await runAgent(onceProvider(), { mode: "ask" }, () => {
    approvals += 1;
  });
  assert.equal(approvals, 1);
});

test("deny policy blocks the tool", async () => {
  let executed = false;
  const providers = new ProviderRegistry();
  providers.register(onceProvider());
  const tools = new ToolRegistry();
  const blocked: Tool = {
    name: "loop_tool",
    description: "test",
    schema: z.object({}),
    async execute() {
      executed = true;
      return [];
    },
  };
  tools.register(blocked);

  const agent = new Agent({
    providers,
    tools,
    resolveHost: async () => ({}) as ExecutionHost,
    approval: { async request() { return "approve"; } },
    secrets: { async get() { return undefined; } },
    audit: { record() {} },
    logger,
  });

  const events: KernelEvent[] = [];
  for await (const event of agent.run({
    sessionId: "s1",
    history: [],
    model: "once/m",
    userText: "go",
    signal: new AbortController().signal,
    toolPolicy: { ...DEFAULT_TOOL_POLICY, mode: "deny" },
  })) {
    events.push(event);
  }

  const result = events.find((e) => e.type === "tool.result") as {
    isError: boolean;
    parts: Array<{ type: string; text?: string }>;
  };
  assert.equal(executed, false);
  assert.equal(result.isError, true);
  assert.match(result.parts[0]?.text ?? "", /blocked by the session policy/);
});

function capturingProvider(sink: { messages?: ChatMessage[] }, vision: boolean): Provider {
  return {
    id: "cap",
    label: "cap",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES, vision, toolCalls: false }),
    listModels: async () => [],
    async *chat(req) {
      sink.messages = req.messages;
      yield { type: "text.delta", text: "ok" };
      yield { type: "done", finishReason: "stop" as const };
    },
  };
}

function agentWith(
  provider: Provider,
  resolveImage?: (id: string) => Promise<{ data: string; mime: string } | undefined>,
) {
  const providers = new ProviderRegistry();
  providers.register(provider);
  return new Agent({
    providers,
    tools: new ToolRegistry(),
    resolveHost: async () => ({}) as ExecutionHost,
    approval: { async request() { return "approve"; } },
    secrets: { async get() { return undefined; } },
    audit: { record() {} },
    logger,
    resolveImage,
  });
}

async function drain(agent: Agent, parts: Part[], sessionId = "s1"): Promise<void> {
  for await (const _ of agent.run({
    sessionId,
    history: [],
    model: "cap/m",
    signal: new AbortController().signal,
    userParts: parts,
  })) {
    /* consume */
  }
}

test("strips images for models without vision", async () => {
  const sink: { messages?: ChatMessage[] } = {};
  const agent = agentWith(capturingProvider(sink, false));
  await drain(agent, [
    { type: "text", text: "what is this" },
    { type: "image", source: { kind: "data", data: "AAAA", mime: "image/png" } },
  ]);

  const last = sink.messages?.at(-1);
  assert.ok(last);
  assert.equal(last.parts.some((p) => p.type === "image"), false);
  assert.ok(last.parts.some((p) => p.type === "text" && p.text.includes("image omitted")));
});

test("resolves attachment images to data for vision models", async () => {
  const sink: { messages?: ChatMessage[] } = {};
  const agent = agentWith(capturingProvider(sink, true), async (id) =>
    id === "att_1" ? { data: "BBBB", mime: "image/png" } : undefined,
  );
  await drain(agent, [
    { type: "image", source: { kind: "attachment", id: "att_1", mime: "image/png" } },
  ]);

  const image = sink.messages?.at(-1)?.parts.find((p) => p.type === "image");
  assert.ok(image && image.type === "image");
  assert.deepEqual(image.source, { kind: "data", data: "BBBB", mime: "image/png" });
});
