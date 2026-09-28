import type {
  ChatMessage,
  ChatRequest,
  ModelInfo,
  Plugin,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
} from "@hat/core";
import { newId, textOf } from "@hat/core";
import { TITLE_SYSTEM_PROMPT } from "./title.js";

const MODEL_ID = "fake/fake-agent";

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  toolCalls: true,
  vision: false,
  imageGeneration: false,
  reasoning: false,
  jsonMode: false,
  systemPrompt: "native",
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function lastMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return messages[messages.length - 1];
}

/** Words that read as a dangling tail once a sentence is cut short. */
const TITLE_TAIL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "is", "it", "of", "on",
  "or", "so", "that", "the", "then", "this", "to", "with", "why", "how", "what", "when",
]);

/** First few words of a message, minus a trailing function word. */
function titleWords(text: string): string {
  const words = text.split(/\s+/).filter(Boolean).slice(0, 6);
  while (words.length > 1 && TITLE_TAIL_WORDS.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  return words.join(" ");
}

/**
 * A dependency-free provider so M0 can exercise the whole loop (streaming,
 * tool calls, approvals, runner execution) without any API keys.
 *
 * Behaviour:
 *  - "run: <cmd>"  -> calls the shell.exec tool
 *  - after a tool result -> summarizes the output
 *  - anything else -> echoes
 */
export class FakeProvider implements Provider {
  readonly id = "fake";
  readonly label = "Fake (M0)";

  capabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: MODEL_ID,
        label: "Fake Agent",
        provider: this.id,
        contextWindow: 8192,
        capabilities: CAPABILITIES,
      },
    ];
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const last = lastMessage(req.messages);

    // A titling call: answer it the way a real model would, so the fake
    // provider can stand in for one without a key.
    const titling = req.messages.some(
      (m) => m.role === "system" && textOf(m).includes(TITLE_SYSTEM_PROMPT),
    );
    if (titling) {
      const subject = last ? textOf(last).trim() : "";
      const words = titleWords(subject);
      const title = words.charAt(0).toUpperCase() + words.slice(1);
      yield { type: "text.delta", text: title };
      yield { type: "usage", usage: { inputTokens: subject.length, outputTokens: words.length } };
      yield { type: "done", finishReason: "stop" };
      return;
    }

    if (last?.role === "tool") {
      const resultText = last.parts
        .filter((p) => p.type === "tool_result")
        .flatMap((p) => (p.type === "tool_result" ? p.content : []))
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      const summary = resultText ? resultText.slice(0, 600) : "(no output)";
      yield* this.streamText(`Command finished. Output:\n\n${summary}\n`, signal);
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: summary.length } };
      yield { type: "done", finishReason: "stop" };
      return;
    }

    const text = last ? textOf(last) : "";
    const toolMatch = /^tool:\s*(\S+)\s*([\s\S]*)$/i.exec(text.trim());

    if (toolMatch) {
      const name = toolMatch[1];
      const raw = toolMatch[2].trim();
      let args: unknown = {};
      if (raw) {
        try {
          args = JSON.parse(raw);
        } catch {
          args = { raw };
        }
      }
      yield* this.streamText(`Calling tool ${name}.\n`, signal);
      yield { type: "toolcall", call: { id: newId("call"), name, args } };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }

    const runMatch = /^run:?\s+([\s\S]+)$/i.exec(text.trim());

    if (runMatch) {
      const command = runMatch[1].trim();
      yield* this.streamText(`Running \`${command}\` on the execution host.\n`, signal);
      yield {
        type: "toolcall",
        call: { id: newId("call"), name: "shell_exec", args: { command } },
      };
      yield { type: "done", finishReason: "tool_calls" };
      return;
    }

    yield* this.streamText(
      `You said: "${text}". Try \`run: echo hello\` to exercise the execution link.\n`,
      signal,
    );
    yield { type: "usage", usage: { inputTokens: text.length, outputTokens: 20 } };
    yield { type: "done", finishReason: "stop" };
  }

  private async *streamText(text: string, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const chunks = text.match(/.{1,12}/gs) ?? [text];
    for (const chunk of chunks) {
      await sleep(12, signal);
      yield { type: "text.delta", text: chunk };
    }
  }
}

export function createFakePlugin(): Plugin {
  return {
    id: "fake",
    name: "Fake provider",
    version: "0.1.0",
    description:
      "Dependency-free provider for testing the loop end-to-end. Replies to `run: <cmd>` with a shell_exec call.",
    activate(ctx) {
      ctx.register.provider(new FakeProvider());
    },
  };
}
