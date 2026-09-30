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
  ProviderCapabilities,
  Tool,
  ToolPolicy,
  Usage,
} from "@hat/core";
import { DEFAULT_CAPABILITIES, DEFAULT_TOOL_POLICY, newId, usageTotal } from "@hat/core";
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

/** Emits plain text, then reports what it cost, split without a total. */
function spendingProvider(reports: Usage[]): Provider {
  let call = 0;
  return {
    id: "spend",
    label: "spend",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES }),
    listModels: async () => [],
    async *chat() {
      const usage = reports[Math.min(call, reports.length - 1)];
      call += 1;
      yield { type: "text.delta", text: "answer" };
      if (usage) yield { type: "usage", usage };
      yield { type: "done", finishReason: "stop" as const };
    },
  };
}

async function runAgent(
  provider: Provider,
  policy: Partial<ToolPolicy>,
  onApproval?: (req: ApprovalRequest) => void,
  onMessage?: (sessionId: string, message: ChatMessage) => void,
  resolveHost: () => Promise<ExecutionHost> = async () => ({}) as ExecutionHost,
): Promise<KernelEvent[]> {
  const providers = new ProviderRegistry();
  providers.register(provider);
  const tools = new ToolRegistry();
  tools.register(tool());

  const agent = new Agent({
    providers,
    tools,
    resolveHost,
    approval: {
      async request(req) {
        onApproval?.(req);
        return "approve";
      },
    },
    secrets: { async get() { return undefined; } },
    audit: { record() {} },
    logger,
    onMessage,
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
  // 3 executions then the guard trips on the 4th call, plus the closing
  // no-tools call that lets the turn end with prose instead of a tool result.
  assert.equal(counter.calls, 5);
});

/** Each round calls `name` `perRound` times with fresh args; prose after `rounds`. */
function roundsProvider(name: string, perRound: number, rounds: number): Provider {
  let round = 0;
  let n = 0;
  return {
    id: "rounds",
    label: "rounds",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES, toolCalls: true }),
    listModels: async () => [],
    async *chat(req) {
      if (req.tools && req.tools.length > 0 && round < rounds) {
        round += 1;
        for (let i = 0; i < perRound; i++) {
          n += 1;
          yield { type: "toolcall", call: { id: newId("call"), name, args: { x: n } } };
        }
        yield { type: "done", finishReason: "tool_calls" as const };
        return;
      }
      yield { type: "text.delta", text: "final answer" };
      yield { type: "done", finishReason: "stop" as const };
    },
  };
}

const warnings = (events: KernelEvent[]) =>
  events.filter((e) => e.type === "warning").map((e) => (e as { message: string }).message);

test("parallel failures in one round count once toward the failure streak", async () => {
  const events = await runAgent(roundsProvider("missing_tool", 3, 2), { mode: "auto", maxConsecutiveFailures: 3 });
  assert.deepEqual(warnings(events), []);
  assert.equal(events.filter((e) => e.type === "tool.result").length, 6);
});

test("consecutive failing rounds trip the guard", async () => {
  const events = await runAgent(roundsProvider("missing_tool", 1, 5), { mode: "auto", maxConsecutiveFailures: 3 });
  assert.match(warnings(events)[0] ?? "", /loop guard/);
  assert.equal(events.filter((e) => e.type === "tool.result").length, 3);
});

test("a missing runner does not count toward the failure streak", async () => {
  const events = await runAgent(
    roundsProvider("loop_tool", 2, 4),
    { mode: "auto", maxConsecutiveFailures: 3 },
    undefined,
    undefined,
    async () => {
      throw new Error("No runner connected.");
    },
  );
  assert.deepEqual(warnings(events), []);
  const results = events.filter((e) => e.type === "tool.result") as Array<{ isError: boolean }>;
  assert.equal(results.length, 8);
  assert.ok(results.every((r) => r.isError));
});

/** Requests a fresh tool call while tools are offered, then writes prose. */
function toolSpenderProvider(): Provider {
  let n = 0;
  return {
    id: "spend-tools",
    label: "spend-tools",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES, toolCalls: true }),
    listModels: async () => [],
    async *chat(req) {
      if (req.tools && req.tools.length > 0) {
        n += 1;
        yield { type: "toolcall", call: { id: newId("call"), name: "loop_tool", args: { x: n } } };
        yield { type: "done", finishReason: "tool_calls" as const };
        return;
      }
      yield { type: "text.delta", text: "final answer" };
      yield { type: "done", finishReason: "stop" as const };
    },
  };
}

test("closes with an answer when the tool-iteration budget runs out", async () => {
  const persisted: ChatMessage[] = [];
  const events = await runAgent(
    toolSpenderProvider(),
    { maxIterations: 2 },
    undefined,
    (_sessionId, message) => {
      persisted.push(message);
    },
  );

  const warning = events.find((e) => e.type === "warning") as { message: string } | undefined;
  assert.match(warning?.message ?? "", /Tool-call limit/);
  assert.equal(events.some((e) => e.type === "error"), false);

  const toolResults = events.filter((e) => e.type === "tool.result");
  assert.equal(toolResults.length, 2);

  const assistants = persisted.filter((m) => m.role === "assistant");
  const finalText = assistants
    .at(-1)
    ?.parts.filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
  assert.equal(finalText, "final answer");
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
  systemPrompt?: string,
  onMessage?: (sessionId: string, message: ChatMessage) => void,
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
    systemPrompt,
    onMessage,
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

test("records provider usage on the assistant message it persists", async () => {
  const persisted: ChatMessage[] = [];
  await runAgent(
    spendingProvider([{ inputTokens: 120, outputTokens: 30, totalTokens: 150 }]),
    {},
    undefined,
    (_sessionId, message) => {
      persisted.push(message);
    },
  );

  const assistant = persisted.find((m) => m.role === "assistant");
  assert.ok(assistant);
  assert.deepEqual(assistant.meta?.usage, {
    inputTokens: 120,
    outputTokens: 30,
    totalTokens: 150,
  });
  // The provider/model stamp must survive alongside the new usage field.
  assert.equal(assistant.meta?.provider, "spend");
});

test("a provider that reports no split total still yields a usable figure", async () => {
  const persisted: ChatMessage[] = [];
  await runAgent(
    spendingProvider([{ inputTokens: 40, outputTokens: 8 }]),
    {},
    undefined,
    (_sessionId, message) => {
      persisted.push(message);
    },
  );

  const assistant = persisted.find((m) => m.role === "assistant");
  assert.ok(assistant?.meta?.usage);
  assert.equal(usageTotal(assistant.meta.usage), 48);
});

test("usage is still relayed as a stream event", async () => {
  const events = await runAgent(spendingProvider([{ inputTokens: 5, outputTokens: 1 }]), {});
  const usageEvents = events.filter((e) => e.type === "usage");
  assert.equal(usageEvents.length, 1);
  assert.deepEqual(usageEvents[0], {
    type: "usage",
    usage: { inputTokens: 5, outputTokens: 1 },
  });
});

function systemCapturingProvider(
  sink: { messages?: ChatMessage[] },
  systemPrompt: ProviderCapabilities["systemPrompt"],
): Provider {
  return {
    id: "cap",
    label: "cap",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES, toolCalls: false, systemPrompt }),
    listModels: async () => [],
    async *chat(req) {
      sink.messages = req.messages;
      yield { type: "text.delta", text: "ok" };
      yield { type: "done", finishReason: "stop" as const };
    },
  };
}

test("prepends the system prompt as a native system message", async () => {
  const sink: { messages?: ChatMessage[] } = {};
  const agent = agentWith(systemCapturingProvider(sink, "native"), undefined, "BASE PROMPT");
  await drain(agent, [{ type: "text", text: "hi" }]);

  const system = sink.messages?.[0];
  assert.equal(system?.role, "system");
  assert.match((system?.parts[0] as { text: string }).text, /BASE PROMPT/);
  assert.match((system?.parts[0] as { text: string }).text, /Current date: \d{4}-\d{2}-\d{2}/);
  assert.equal(sink.messages?.[1]?.role, "user");
});

test("merges the system prompt into the first user message when unsupported natively", async () => {
  const sink: { messages?: ChatMessage[] } = {};
  const agent = agentWith(
    systemCapturingProvider(sink, "merge-first-user"),
    undefined,
    "BASE PROMPT",
  );
  await drain(agent, [{ type: "text", text: "hi" }]);

  assert.equal(sink.messages?.some((m) => m.role === "system"), false);
  const firstUser = sink.messages?.[0];
  assert.equal(firstUser?.role, "user");
  assert.match((firstUser?.parts[0] as { text: string }).text, /BASE PROMPT/);
});

test("omits the system prompt for providers that refuse one", async () => {
  const sink: { messages?: ChatMessage[] } = {};
  const agent = agentWith(systemCapturingProvider(sink, "none"), undefined, "BASE PROMPT");
  await drain(agent, [{ type: "text", text: "hi" }]);

  assert.equal(sink.messages?.some((m) => m.role === "system"), false);
  assert.equal(
    sink.messages?.some((m) => m.parts.some((p) => p.type === "text" && p.text.includes("BASE PROMPT"))),
    false,
  );
});

test("does not persist the system prompt to history", async () => {
  const sink: { messages?: ChatMessage[] } = {};
  const persisted: ChatMessage[] = [];
  const agent = agentWith(
    systemCapturingProvider(sink, "native"),
    undefined,
    "BASE PROMPT",
    (_sessionId, message) => persisted.push(message),
  );
  await drain(agent, [{ type: "text", text: "hi" }]);

  assert.equal(persisted.some((m) => m.role === "system"), false);
});

test("ephemeral runs hide excluded tools, skip persistence and give tools their call context", async () => {
  const providers = new ProviderRegistry();
  const seenTools: string[][] = [];
  const seenSystem: string[] = [];
  let first = true;
  providers.register({
    id: "p",
    label: "p",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES, toolCalls: true }),
    listModels: async () => [],
    async *chat(request) {
      seenTools.push((request.tools ?? []).map((t) => t.name));
      const system = request.messages.find((m) => m.role === "system");
      seenSystem.push(system?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "");
      if (first) {
        first = false;
        yield { type: "toolcall", call: { id: "c1", name: "ctx_tool", args: {} } };
        yield { type: "toolcall", call: { id: "c2", name: "hidden", args: {} } };
        yield { type: "done", finishReason: "tool_calls" as const };
        return;
      }
      yield { type: "text.delta", text: "done" };
      yield { type: "done", finishReason: "stop" as const };
    },
  });

  const tools = new ToolRegistry();
  const contexts: Array<{ callId?: string; messageId?: string }> = [];
  const emitted: KernelEvent[] = [];
  let hiddenRan = false;
  tools.register({
    name: "ctx_tool",
    description: "records its context",
    async execute(_args, ctx) {
      contexts.push({ callId: ctx.callId, messageId: ctx.messageId });
      ctx.emit?.({ type: "warning", message: "from tool" });
      return [{ type: "text", text: "ok" }];
    },
  });
  tools.register({
    name: "hidden",
    description: "must not run",
    async execute() {
      hiddenRan = true;
      return [];
    },
  });

  const persisted: ChatMessage[] = [];
  const agent = new Agent({
    providers,
    tools,
    resolveHost: async () => ({}) as ExecutionHost,
    approval: { async request() { return "approve"; } },
    secrets: { async get() { return undefined; } },
    audit: { record() {} },
    logger,
    systemPrompt: "base",
    systemContext: async () => "memories here",
    onMessage: (_s, m) => persisted.push(m),
  });

  const events: KernelEvent[] = [];
  for await (const event of agent.run({
    sessionId: "s",
    history: [],
    model: "p/m",
    userText: "go",
    signal: new AbortController().signal,
    toolPolicy: { ...DEFAULT_TOOL_POLICY, mode: "auto" },
    excludeTools: ["hidden"],
    persist: false,
    emit: (event) => emitted.push(event),
  })) {
    events.push(event);
  }

  assert.deepEqual(seenTools[0], ["ctx_tool"]);
  assert.match(seenSystem[0], /^base\n\nmemories here/);
  assert.equal(hiddenRan, false);
  const hiddenResult = events.find((e) => e.type === "tool.result" && e.callId === "c2");
  assert.ok(hiddenResult && hiddenResult.type === "tool.result" && hiddenResult.isError);
  assert.equal(contexts[0].callId, "c1");
  const firstMessage = events.find((e) => e.type === "message.start");
  assert.equal(contexts[0].messageId, firstMessage?.type === "message.start" ? firstMessage.messageId : "");
  assert.deepEqual(emitted, [{ type: "warning", message: "from tool" }]);
  assert.deepEqual(persisted, []);
});

/** Calls `tools` (in one round) whenever the user spoke last, and answers once they have run. */
function toolRoundProvider(tools: string[], counter = { calls: 0 }): Provider {
  return {
    id: "round",
    label: "round",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES, toolCalls: true }),
    listModels: async () => [],
    async *chat(req) {
      counter.calls += 1;
      if (req.messages.at(-1)?.role === "tool") {
        yield { type: "text.delta", text: "done" };
        yield { type: "done", finishReason: "stop" as const };
        return;
      }
      for (const name of tools) {
        yield { type: "toolcall", call: { id: newId("call"), name, args: {} } };
      }
      yield { type: "done", finishReason: "tool_calls" as const };
    },
  };
}

function agentFor(provider: Provider, tools: Tool[], extra: Partial<ConstructorParameters<typeof Agent>[0]> = {}) {
  const providers = new ProviderRegistry();
  providers.register(provider);
  const registry = new ToolRegistry();
  for (const entry of tools) registry.register(entry);
  return new Agent({
    providers,
    tools: registry,
    resolveHost: async () => ({}) as ExecutionHost,
    approval: { async request() { return "approve"; } },
    secrets: { async get() { return undefined; } },
    audit: { record() {} },
    logger,
    ...extra,
  });
}

async function runTurn(
  agent: Agent,
  model: string,
  options: { history?: ChatMessage[]; signal?: AbortSignal; mode?: ToolPolicy["mode"] } = {},
): Promise<KernelEvent[]> {
  const events: KernelEvent[] = [];
  for await (const event of agent.run({
    sessionId: "s1",
    history: options.history ?? [],
    model,
    userText: "go",
    signal: options.signal ?? new AbortController().signal,
    toolPolicy: { ...DEFAULT_TOOL_POLICY, mode: options.mode ?? "auto", maxIterations: 5 },
  })) {
    events.push(event);
  }
  return events;
}

const okTool = (name: string, onRun?: () => void): Tool => ({
  name,
  description: "test",
  async execute() {
    onRun?.();
    return [{ type: "text", text: "ok" }];
  },
});

test("a turn stores its messages as one chain, starting after its history", async () => {
  const stored: Array<{ id: string; role: string; parentId: string | null }> = [];
  const agent = agentFor(toolRoundProvider(["a", "b"]), [okTool("a"), okTool("b")], {
    onMessage: (_s, message, parentId) => stored.push({ id: message.id, role: message.role, parentId }),
  });
  const history: ChatMessage[] = [
    { id: "u0", role: "user", parts: [{ type: "text", text: "earlier" }], createdAt: 1 },
    { id: "a0", role: "assistant", parts: [{ type: "text", text: "reply" }], createdAt: 2 },
  ];

  await runTurn(agent, "round/m", { history });

  assert.deepEqual(stored.map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant"]);
  assert.equal(stored[0].parentId, "a0");
  for (let i = 1; i < stored.length; i++) assert.equal(stored[i].parentId, stored[i - 1].id);
});

test("a cached host whose runner went away is replaced, not reused", async () => {
  const hosts: Array<{ id: string; closed: boolean }> = [];
  const used: string[] = [];
  const recorder: Tool = {
    name: "where",
    description: "records its host",
    async execute(_args, ctx) {
      used.push(ctx.host.id);
      return [{ type: "text", text: "ok" }];
    },
  };
  const agent = agentFor(toolRoundProvider(["where"]), [recorder], {
    resolveHost: async () => {
      const host = { id: `host-${hosts.length + 1}`, closed: false };
      hosts.push(host);
      return host as unknown as ExecutionHost;
    },
  });

  await runTurn(agent, "round/m");
  await runTurn(agent, "round/m");
  assert.deepEqual(used, ["host-1", "host-1"]);

  hosts[0].closed = true; // its runner reconnected: the old link will never answer
  await runTurn(agent, "round/m");
  assert.deepEqual(used, ["host-1", "host-1", "host-2"]);
});

test("stopping a turn mid-round abandons a hung tool and starts nothing else", async () => {
  const counter = { calls: 0 };
  const stop = new AbortController();
  let laterRan = false;
  const hung: Tool = {
    name: "hung",
    description: "ignores its signal, like a wedged MCP server",
    execute() {
      stop.abort();
      return new Promise<Part[]>(() => {});
    },
  };
  const stored: ChatMessage[] = [];
  const agent = agentFor(toolRoundProvider(["hung", "later"], counter), [hung, okTool("later", () => (laterRan = true))], {
    stopGraceMs: 20,
    onMessage: (_s, message) => stored.push(message),
  });

  const events = await runTurn(agent, "round/m", { signal: stop.signal });

  assert.equal(laterRan, false);
  assert.equal(counter.calls, 1, "no model call after the stop");
  const results = events.filter((e) => e.type === "tool.result");
  assert.equal(results.length, 2);
  assert.ok(results.every((e) => e.type === "tool.result" && e.isError));
  assert.equal(events.at(-1)?.type, "turn.done");
  // Every tool call still has a stored result, so the history stays well-formed.
  assert.deepEqual(stored.map((m) => m.role), ["user", "assistant", "tool", "tool"]);
});

test("a tool that honours the stop keeps its own result", async () => {
  const stop = new AbortController();
  const cooperative: Tool = {
    name: "build",
    description: "returns what it has when cancelled",
    execute(_args, ctx) {
      return new Promise<Part[]>((resolve) => {
        ctx.signal.addEventListener("abort", () => resolve([{ type: "text", text: "partial output [cancelled]" }]));
        stop.abort();
      });
    },
  };
  const agent = agentFor(toolRoundProvider(["build"]), [cooperative], { stopGraceMs: 1_000 });

  const events = await runTurn(agent, "round/m", { signal: stop.signal });

  const result = events.find((e) => e.type === "tool.result");
  assert.ok(result && result.type === "tool.result");
  assert.match(JSON.stringify(result.parts), /partial output/);
});

test("stopping while an approval is pending records the call as stopped, not denied", async () => {
  const stop = new AbortController();
  const gated: Tool = { ...okTool("gated"), requiresApproval: true };
  const agent = agentFor(toolRoundProvider(["gated"]), [gated], {
    approval: {
      request: (_req, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("approval aborted")), { once: true });
          stop.abort(); // the user presses Stop instead of answering
        }),
    },
  });

  const events = await runTurn(agent, "round/m", { signal: stop.signal, mode: "ask" });

  const result = events.find((e) => e.type === "tool.result");
  assert.ok(result && result.type === "tool.result");
  assert.match(JSON.stringify(result.parts), /not run: the turn was stopped/);
  assert.doesNotMatch(JSON.stringify(result.parts), /denied/);
});

test("a call that fails before any output stores no reply, and the next request carries none", async () => {
  let fail = true;
  const sent: ChatMessage[][] = [];
  const flaky: Provider = {
    id: "flaky",
    label: "flaky",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES }),
    listModels: async () => [],
    async *chat(req) {
      sent.push(req.messages);
      if (fail) {
        yield { type: "error", error: { code: "http_401", message: "invalid api key", retryable: false } };
        return;
      }
      yield { type: "text.delta", text: "hello" };
      yield { type: "done", finishReason: "stop" as const };
    },
  };
  const stored: ChatMessage[] = [];
  const agent = agentFor(flaky, [], { onMessage: (_s, message) => stored.push(message) });

  const events = await runTurn(agent, "flaky/m");
  assert.ok(events.some((e) => e.type === "error"));
  assert.deepEqual(stored.map((m) => m.role), ["user"]);

  // The user fixes the key and asks again, on top of what was stored.
  fail = false;
  await runTurn(agent, "flaky/m", { history: [...stored] });
  const roles = sent[1].map((m) => m.role);
  assert.deepEqual(roles, ["user"], "the two user turns go out as one, with no empty reply between");
});

test("stopping mid-reply keeps what streamed, marks it unfinished and reports no error", async () => {
  const stop = new AbortController();
  const slow: Provider = {
    id: "slow",
    label: "slow",
    capabilities: () => ({ ...DEFAULT_CAPABILITIES }),
    listModels: async () => [],
    async *chat(_req, signal) {
      yield { type: "text.delta", text: "The answer is" };
      stop.abort();
      await new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new DOMException("This operation was aborted", "AbortError"));
        signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
      });
    },
  };
  const stored: ChatMessage[] = [];
  const agent = agentFor(slow, [], { onMessage: (_s, message) => stored.push(message) });

  const events = await runTurn(agent, "slow/m", { signal: stop.signal });

  assert.equal(events.some((e) => e.type === "error"), false);
  const reply = stored.find((m) => m.role === "assistant");
  assert.ok(reply);
  assert.deepEqual(reply.parts, [{ type: "text", text: "The answer is" }]);
  assert.equal(reply.meta?.incomplete, true);
});

test("history is repaired for a model with a known context window too", async () => {
  const sent: ChatMessage[][] = [];
  const windowed: Provider = {
    id: "windowed",
    label: "windowed",
    // A context window turns on fitting, which must work on the repaired history.
    capabilities: () => ({ ...DEFAULT_CAPABILITIES, toolCalls: true, contextWindow: 100_000 }),
    listModels: async () => [],
    async *chat(req) {
      sent.push(req.messages);
      yield { type: "text.delta", text: "hello" };
      yield { type: "done", finishReason: "stop" as const };
    },
  };
  const at = Date.now();
  // The server stopped mid-call: the call never got its result.
  const history: ChatMessage[] = [
    { id: "u0", role: "user", parts: [{ type: "text", text: "list files" }], createdAt: at },
    { id: "a0", role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "shell_exec", args: {} }], createdAt: at + 1 },
  ];
  await runTurn(agentFor(windowed, []), "windowed/m", { history });
  const roles = sent[0].filter((m) => m.role !== "system").map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "user"], "the dangling call is answered before the new message");
});
