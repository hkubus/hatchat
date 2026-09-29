import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatRequest, ProviderCapabilities } from "@hat/core";
import { toWireName } from "./messages.js";
import { createOpenAICompatibleProvider, extractCachedTokens } from "./provider.js";

const CAPS: ProviderCapabilities = {
  streaming: true,
  toolCalls: true,
  vision: false,
  imageGeneration: false,
  reasoning: false,
  jsonMode: false,
  systemPrompt: "native",
};

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function makeProvider(
  fetchImpl: typeof fetch,
  apiKey: string | undefined = "test-key",
) {
  return createOpenAICompatibleProvider({
    id: "test",
    label: "Test",
    baseUrl: "https://example.test/v1",
    apiKey: async () => apiKey,
    listModels: async () => [],
    capabilities: () => CAPS,
    fetch: fetchImpl,
  });
}

function request(messages: ChatRequest["messages"]): ChatRequest {
  return { model: "m", messages };
}

async function collect(provider: ReturnType<typeof makeProvider>) {
  const controller = new AbortController();
  const events = [];
  for await (const event of provider.chat(
    request([{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 }]),
    controller.signal,
  )) {
    events.push(event);
  }
  return events;
}

test("streams text, usage and done", async () => {
  const fetchImpl = (async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;

  const events = await collect(makeProvider(fetchImpl));
  assert.deepEqual(
    events.filter((e) => e.type === "text.delta"),
    [
      { type: "text.delta", text: "Hel" },
      { type: "text.delta", text: "lo" },
    ],
  );
  assert.deepEqual(events.at(-2), {
    type: "usage",
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  });
  assert.deepEqual(events.at(-1), { type: "done", finishReason: "stop" });
});

test("assembles tool calls split across chunks", async () => {
  const fetchImpl = (async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell.exec","arguments":"{\\"comm"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"and\\":\\"ls\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;

  const events = await collect(makeProvider(fetchImpl));
  const call = events.find((e) => e.type === "toolcall");
  assert.deepEqual(call, {
    type: "toolcall",
    call: { id: "call_1", name: "shell.exec", args: { command: "ls" } },
  });
  assert.deepEqual(events.at(-1), { type: "done", finishReason: "tool_calls" });
});

test("maps reasoning_content deltas", async () => {
  const fetchImpl = (async () =>
    sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;

  const events = await collect(makeProvider(fetchImpl));
  assert.deepEqual(events[0], { type: "reasoning.delta", text: "think" });
  assert.deepEqual(events[1], { type: "text.delta", text: "answer" });
});

test("reports missing api key without calling fetch", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return sseResponse([]);
  }) as unknown as typeof fetch;

  const events = await collect(makeProvider(fetchImpl, ""));
  assert.equal(called, false);
  assert.equal(events[0].type, "error");
  assert.equal((events[0] as { error: { code: string } }).error.code, "missing_api_key");
});

test("sends sanitized tool names and maps calls back to canonical names", async () => {
  const wire = toWireName("shell.exec");
  let sentBody: any;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    sentBody = JSON.parse(init.body);
    return sseResponse([
      `data: ${JSON.stringify({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: wire, arguments: "{}" } }] } },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  }) as unknown as typeof fetch;

  const provider = makeProvider(fetchImpl);
  const events = [];
  for await (const event of provider.chat(
    {
      model: "m",
      messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "x" }], createdAt: 0 }],
      tools: [{ name: "shell.exec", description: "d", parameters: { type: "object" } }],
    },
    new AbortController().signal,
  )) {
    events.push(event);
  }

  assert.equal(sentBody.tools[0].function.name, wire);
  assert.match(wire, /^[a-zA-Z0-9_-]{1,64}$/);
  const call = events.find((e) => e.type === "toolcall") as { call: { name: string } };
  assert.equal(call.call.name, "shell.exec");
});

test("surfaces http errors", async () => {
  const fetchImpl = (async () =>
    new Response("nope", { status: 429 })) as unknown as typeof fetch;

  const events = await collect(makeProvider(fetchImpl));
  assert.equal(events[0].type, "error");
  assert.equal((events[0] as { error: { code: string } }).error.code, "http_429");
});

test("sends a flat reasoning_effort field by default", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return sseResponse(["data: [DONE]\n\n"]);
  }) as unknown as typeof fetch;

  const controller = new AbortController();
  const provider = makeProvider(fetchImpl);
  for await (const _ of provider.chat(
    { ...request([{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 }]), reasoningEffort: "high" },
    controller.signal,
  )) {
    /* drain */
  }
  assert.equal(body.reasoning_effort, "high");
});

test("omits reasoning_effort when the session is off", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return sseResponse(["data: [DONE]\n\n"]);
  }) as unknown as typeof fetch;

  const controller = new AbortController();
  const provider = makeProvider(fetchImpl);
  for await (const _ of provider.chat(
    { ...request([{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 }]), reasoningEffort: "off" },
    controller.signal,
  )) {
    /* drain */
  }
  assert.equal("reasoning_effort" in body, false);
});

test("uses a custom reasoning effort encoding when provided", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return sseResponse(["data: [DONE]\n\n"]);
  }) as unknown as typeof fetch;

  const provider = createOpenAICompatibleProvider({
    id: "custom",
    label: "Custom",
    baseUrl: "https://example.test/v1",
    apiKey: async () => "test-key",
    listModels: async () => [],
    capabilities: () => CAPS,
    reasoningEffortBody: (effort) => ({ reasoning: { effort } }),
    fetch: fetchImpl,
  });

  const controller = new AbortController();
  for await (const _ of provider.chat(
    { ...request([{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 }]), reasoningEffort: "low" },
    controller.signal,
  )) {
    /* drain */
  }
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal("reasoning_effort" in body, false);
});

test("extractCachedTokens prefers the nested OpenAI shape over DeepSeek's", () => {
  assert.equal(extractCachedTokens({ prompt_tokens_details: { cached_tokens: 75 } }), 75);
  assert.equal(extractCachedTokens({ prompt_cache_hit_tokens: 60 }), 60);
  assert.equal(
    extractCachedTokens({
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 60,
    }),
    0,
  );
  assert.equal(extractCachedTokens({}), undefined);
  assert.equal(extractCachedTokens({ prompt_tokens_details: null }), undefined);
});

test("streams cached tokens from prompt_tokens_details", async () => {
  const fetchImpl = (async () =>
    sseResponse([
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_tokens_details":{"cached_tokens":80}}}\n\n',
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;

  const events = await collect(makeProvider(fetchImpl));
  assert.deepEqual(events.at(-2), {
    type: "usage",
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedTokens: 80 },
  });
});

test("streams cached tokens from DeepSeek's prompt_cache_hit_tokens", async () => {
  const fetchImpl = (async () =>
    sseResponse([
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_cache_hit_tokens":60,"prompt_cache_miss_tokens":40}}\n\n',
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;

  const events = await collect(makeProvider(fetchImpl));
  assert.deepEqual(events.at(-2), {
    type: "usage",
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedTokens: 60 },
  });
});

test("omits cachedTokens when the provider reports no cache stats", async () => {
  const fetchImpl = (async () =>
    sseResponse([
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ])) as unknown as typeof fetch;

  const events = await collect(makeProvider(fetchImpl));
  const usage = events.at(-2) as unknown as { usage: Record<string, unknown> };
  assert.equal("cachedTokens" in usage.usage, false);
});

test("sends tools sorted and a stable prompt_cache_key", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return sseResponse(["data: [DONE]\n\n"]);
  }) as unknown as typeof fetch;

  const controller = new AbortController();
  const provider = makeProvider(fetchImpl);
  for await (const _ of provider.chat(
    {
      ...request([{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }], createdAt: 0 }]),
      tools: [
        { name: "zebra", description: "z", parameters: { type: "object" } },
        { name: "apple", description: "a", parameters: { type: "object" } },
      ],
      cacheKey: "session-123",
    },
    controller.signal,
  )) {
    /* drain */
  }
  const names = ((body.tools as Array<{ function: { name: string } }>) ?? []).map(
    (t) => t.function.name,
  );
  assert.deepEqual(names, ["apple", "zebra"]);
  assert.equal(body.prompt_cache_key, "session-123");
});
