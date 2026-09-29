import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionHost,
  KernelEvent,
  Logger,
  Part,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
} from "@hat/core";
import { DEFAULT_CAPABILITIES, textOf } from "@hat/core";
import { Agent, type AgentTurnInput, type KernelDeps } from "./agent.js";
import { estimateTokens, fitToContext } from "./context.js";
import { ProviderRegistry, ToolRegistry } from "./registries.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A provider that plays back one scripted response per call and records requests. */
function scripted(
  responses: ProviderEvent[][],
  caps: Partial<ProviderCapabilities> = {},
): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let call = 0;
  return {
    id: "p",
    label: "p",
    requests,
    capabilities: () => ({ ...DEFAULT_CAPABILITIES, ...caps }),
    listModels: async () => [],
    async *chat(req) {
      requests.push(structuredClone(req));
      const events = responses[Math.min(call, responses.length - 1)];
      call += 1;
      for (const event of events) yield event;
    },
  };
}

async function run(
  provider: Provider,
  input: Partial<AgentTurnInput> = {},
  deps: Partial<KernelDeps> = {},
): Promise<{ events: KernelEvent[]; persisted: ChatMessage[] }> {
  const providers = new ProviderRegistry();
  providers.register(provider);
  const persisted: ChatMessage[] = [];
  const agent = new Agent({
    providers,
    tools: new ToolRegistry(),
    resolveHost: async () => ({}) as ExecutionHost,
    approval: { request: async () => "approve" },
    secrets: { get: async () => undefined },
    audit: { record() {} },
    logger,
    onMessage: (_sessionId, message) => {
      persisted.push(message);
    },
    retryBaseDelayMs: 1,
    ...deps,
  });
  const events: KernelEvent[] = [];
  for await (const event of agent.run({
    sessionId: "s1",
    history: [],
    model: `${provider.id}/m`,
    userText: "go",
    signal: new AbortController().signal,
    ...input,
  })) {
    events.push(event);
  }
  return { events, persisted };
}

const answer = (text: string): ProviderEvent[] => [
  { type: "text.delta", text },
  { type: "done", finishReason: "stop" },
];
const failure = (retryable: boolean, retryAfterMs?: number): ProviderEvent[] => [
  { type: "error", error: { code: "http_429", message: "rate limited", retryable, retryAfterMs } },
];

// --- retries -----------------------------------------------------------------

test("a retryable error before any output is retried", async () => {
  const provider = scripted([failure(true), failure(true), answer("ok")]);
  const { events, persisted } = await run(provider);
  assert.equal(provider.requests.length, 3);
  assert.equal(events.filter((e) => e.type === "warning").length, 2);
  assert.equal(events.some((e) => e.type === "error"), false);
  assert.equal(textOf(persisted.at(-1)!), "ok");
});

test("retries give up after maxRetries and surface the error", async () => {
  const provider = scripted([failure(true)]);
  const { events } = await run(provider, {}, { maxRetries: 2 });
  assert.equal(provider.requests.length, 3);
  assert.equal(events.filter((e) => e.type === "error").length, 1);
});

test("a non-retryable error is not retried", async () => {
  const provider = scripted([failure(false), answer("never")]);
  const { events } = await run(provider);
  assert.equal(provider.requests.length, 1);
  assert.equal(events.filter((e) => e.type === "error").length, 1);
});

test("an error after output has streamed is not retried", async () => {
  const provider = scripted([
    [{ type: "text.delta", text: "half" }, ...failure(true)],
    answer("again"),
  ]);
  const { events, persisted } = await run(provider);
  assert.equal(provider.requests.length, 1, "a retry would duplicate the streamed text");
  assert.equal(events.filter((e) => e.type === "error").length, 1);
  assert.equal(textOf(persisted.at(-1)!), "half");
});

test("cancelling during a retry wait ends the turn quietly", async () => {
  const controller = new AbortController();
  const provider = scripted([failure(true, 10_000), answer("late")]);
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  const { events } = await run(provider, { signal: controller.signal });
  assert.ok(Date.now() - started < 5_000, "the wait must not outlive the cancel");
  assert.equal(provider.requests.length, 1);
  assert.equal(events.at(-1)?.type, "turn.done");
});

// --- per-turn options ------------------------------------------------------------

test("instructions, temperature and maxTokens reach the request", async () => {
  const provider = scripted([answer("ok")]);
  await run(
    provider,
    { instructions: "Answer in French.", temperature: 0.2, maxTokens: 321 },
    { systemPrompt: "Base prompt." },
  );
  const request = provider.requests[0];
  assert.equal(request.temperature, 0.2);
  assert.equal(request.maxTokens, 321);
  const system = request.messages.find((m) => m.role === "system");
  assert.ok(system);
  assert.match(textOf(system), /Base prompt\./);
  assert.match(textOf(system), /Answer in French\./);
});

test("the finish reason is stored on the assistant message", async () => {
  const provider = scripted([[{ type: "text.delta", text: "cut" }, { type: "done", finishReason: "length" }]]);
  const { events, persisted } = await run(provider);
  assert.equal(persisted.at(-1)?.meta?.finishReason, "length");
  const done = events.find((e) => e.type === "message.done") as { finishReason: string };
  assert.equal(done.finishReason, "length");
});

test("userMeta is stored on the new user message", async () => {
  const provider = scripted([answer("more")]);
  const { persisted } = await run(provider, { userText: "Continue", userMeta: { synthetic: "continue" } });
  assert.equal(persisted[0].role, "user");
  assert.equal(persisted[0].meta?.synthetic, "continue");
});

test("user-attached documents are inlined as text for the model", async () => {
  const provider = scripted([answer("read it")]);
  const parts: Part[] = [
    { type: "text", text: "summarize" },
    { type: "file", id: "att_1", name: "notes.md", mime: "text/markdown", size: 5 },
  ];
  const { persisted } = await run(
    provider,
    { userText: undefined, userParts: parts },
    { resolveFile: async (id) => (id === "att_1" ? { text: "# hi" } : undefined) },
  );
  const sent = provider.requests[0].messages.find((m) => m.role === "user")!;
  assert.match(textOf(sent), /<file name="notes.md" type="text\/markdown">\n# hi\n<\/file>/);
  // Stored history keeps the reference, not the contents.
  assert.equal(persisted[0].parts[1].type, "file");
});

// --- context window ------------------------------------------------------------

const big = (n: number): string => "x".repeat(n);

function toolExchange(i: number, size: number): ChatMessage[] {
  return [
    { id: `u${i}`, role: "user", parts: [{ type: "text", text: `question ${i}` }], createdAt: i },
    {
      id: `a${i}`,
      role: "assistant",
      parts: [{ type: "tool_call", id: `c${i}`, name: "read", args: {} }],
      createdAt: i,
    },
    {
      id: `t${i}`,
      role: "tool",
      parts: [{ type: "tool_result", id: `c${i}`, name: "read", content: [{ type: "text", text: big(size) }] }],
      createdAt: i,
    },
    { id: `r${i}`, role: "assistant", parts: [{ type: "text", text: `answer ${i}` }], createdAt: i },
  ];
}

test("fitToContext leaves a conversation that fits untouched", () => {
  const history = toolExchange(1, 100);
  const fit = fitToContext(history, 10_000);
  assert.equal(fit.messages, history);
  assert.equal(fit.elidedToolResults + fit.droppedMessages, 0);
});

test("fitToContext elides old tool outputs before dropping messages", () => {
  const history = [...toolExchange(1, 20_000), ...toolExchange(2, 20_000), ...toolExchange(3, 2_000)];
  const fit = fitToContext(history, 4_000);
  assert.ok(fit.elidedToolResults >= 1);
  assert.equal(fit.droppedMessages, 0);
  assert.ok(fit.tokens <= 4_000);
  assert.equal(fit.messages.length, history.length);
  // The latest tool output is what the model is working from: never elided.
  assert.equal(textOf({ ...fit.messages[10], parts: (fit.messages[10].parts[0] as any).content }), big(2_000));
  // The input is not mutated.
  assert.equal((history[2].parts[0] as any).content[0].text.length, 20_000);
});

test("fitToContext drops the oldest exchanges when eliding is not enough", () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 20; i++) {
    history.push({ id: `u${i}`, role: "user", parts: [{ type: "text", text: big(2_000) }], createdAt: i });
    history.push({ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: big(2_000) }], createdAt: i });
  }
  const fit = fitToContext(history, 5_000);
  assert.ok(fit.droppedMessages > 0);
  assert.ok(fit.tokens <= 5_000 + 50);
  assert.equal(fit.messages.at(-1)?.id, "a19", "the newest exchange survives");
  assert.equal(fit.messages[0].role, "user", "the request still opens on a user turn");
  assert.match(textOf(fit.messages[0]), /earlier messages were left out/);
});

test("fitToContext keeps the cut point stable as the conversation grows", () => {
  const history: ChatMessage[] = [];
  const cuts = new Set<string>();
  let trimmedTurns = 0;
  for (let i = 0; i < 60; i++) {
    history.push({ id: `u${i}`, role: "user", parts: [{ type: "text", text: big(200) }], createdAt: i });
    history.push({ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: big(200) }], createdAt: i });
    const fit = fitToContext(history, 2_000);
    if (fit.droppedMessages === 0) continue;
    trimmedTurns += 1;
    cuts.add(fit.messages[1].id);
  }
  // Paged cuts move far less often than once per exchange, so most turns
  // reuse the previous request's prefix.
  assert.ok(trimmedTurns > 20);
  assert.ok(cuts.size * 3 < trimmedTurns, `cut moved ${cuts.size} times over ${trimmedTurns} turns`);
});

test("an over-full conversation is trimmed for the request and a warning is emitted", async () => {
  const provider = scripted([answer("ok")], { contextWindow: 4_000 });
  const history = [...toolExchange(1, 40_000), ...toolExchange(2, 100)];
  const { events } = await run(provider, { history });
  const sent = provider.requests[0].messages;
  assert.ok(estimateTokens(sent) < 4_000);
  const warning = events.find((e) => e.type === "warning") as { message: string } | undefined;
  assert.match(warning?.message ?? "", /context window/);
});
