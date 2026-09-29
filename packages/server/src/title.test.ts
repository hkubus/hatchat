import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage, ChatRequest, ModelInfo, Provider, ProviderCapabilities, ProviderEvent } from "@hat/core";
import { ProviderRegistry } from "@hat/kernel";
import { FakeProvider } from "./fake-provider.js";
import { generateTitle, TITLE_SYSTEM_PROMPT } from "./title.js";

const CAPS: ProviderCapabilities = {
  streaming: true,
  toolCalls: false,
  vision: false,
  imageGeneration: false,
  reasoning: false,
  jsonMode: false,
  systemPrompt: "native",
};

const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Collects a full reply from a provider. */
async function drain(iterable: AsyncIterable<ProviderEvent>): Promise<string> {
  let text = "";
  for await (const event of iterable) {
    if (event.type === "text.delta") text += event.text;
  }
  return text;
}

function message(role: ChatMessage["role"], text: string): ChatMessage {
  return { id: "m", role, parts: [{ type: "text", text }], createdAt: 0 };
}

class ScriptedProvider implements Provider {
  readonly id = "scripted";
  readonly label = "Scripted";
  /** The last request this provider was asked to fulfil. */
  last?: ChatRequest;

  constructor(private readonly reply: string) {}

  capabilities(): ProviderCapabilities {
    return CAPS;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.last = req;
    yield { type: "text.delta", text: this.reply };
    yield { type: "done", finishReason: "stop" };
  }
}

function registryWith(provider: Provider): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(provider);
  return registry;
}

test("titles a conversation with the session's own model", async () => {
  const provider = new ScriptedProvider("Fixing the flaky integration test");
  const title = await generateTitle({
    providers: registryWith(provider),
    model: "scripted/quick",
    subject: "why does the integration test fail only on fridays",
    logger,
  });

  assert.equal(title, "Fixing the flaky integration test");
  // The bare model id, not the qualified one the session stores.
  assert.equal(provider.last?.model, "quick");
  assert.equal(provider.last?.maxTokens, 24);
  assert.equal(provider.last?.temperature, 0);
  // No tools: this is a one-shot call, not a turn.
  assert.equal(provider.last?.tools, undefined);
});

test("strips the decoration models add around a title", async () => {
  const cases: [string, string | undefined][] = [
    ['"Debugging the auth race"', "Debugging the auth race"],
    ["Title: Refactor the store layer", "Refactor the store layer"],
    ["Rename this field everywhere.\n\nHere is why I think...", "Rename this field everywhere"],
    ["  spaced   out  ", "spaced out"],
    ["", undefined],
    ["\n\n", undefined],
  ];

  for (const [reply, expected] of cases) {
    const title = await generateTitle({
      providers: registryWith(new ScriptedProvider(reply)),
      model: "scripted/quick",
      subject: "anything",
      logger,
    });
    assert.equal(title, expected, `reply: ${JSON.stringify(reply)}`);
  }
});

test("caps an overlong title and drops an empty subject", async () => {
  const long = await generateTitle({
    providers: registryWith(new ScriptedProvider("word ".repeat(60))),
    model: "scripted/quick",
    subject: "anything",
    logger,
  });
  assert.ok(long);
  assert.ok((long?.length ?? 0) <= 80, `length was ${long?.length}`);

  assert.equal(
    await generateTitle({
      providers: registryWith(new ScriptedProvider("unused")),
      model: "scripted/quick",
      subject: "   ",
      logger,
    }),
    undefined,
  );
});

test("gives up quietly when the model or provider is unusable", async () => {
  // A session can name a model whose provider plugin was since disabled.
  assert.equal(
    await generateTitle({
      providers: registryWith(new ScriptedProvider("never used")),
      model: "gone/quick",
      subject: "hello",
      logger,
    }),
    undefined,
  );

  // A provider that throws must not take the turn down with it.
  const exploding: Provider = {
    id: "boom",
    label: "Boom",
    capabilities: () => CAPS,
    listModels: async () => [],
    chat: () => {
      throw new Error("upstream 503");
    },
  };
  assert.equal(
    await generateTitle({
      providers: registryWith(exploding),
      model: "boom/quick",
      subject: "hello",
      logger,
    }),
    undefined,
  );
});

test("the fake provider answers a titling request without an API key", async () => {
  const fake = new FakeProvider();
  const reply = await drain(
    fake.chat(
      {
        model: "fake-agent",
        messages: [
          message("system", TITLE_SYSTEM_PROMPT),
          message("user", "why is the docker build so slow on ci"),
        ],
      },
      new AbortController().signal,
    ),
  );
  assert.equal(reply, "Why is the docker build");
});
