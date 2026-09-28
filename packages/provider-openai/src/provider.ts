import type {
  ChatRequest,
  FinishReason,
  ModelInfo,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  ReasoningEffort,
} from "@hat/core";
import { newId, normalizeError } from "@hat/core";
import { toOpenAIMessages, toWireName } from "./messages.js";
import { iterateSSE } from "./sse.js";

export interface OpenAICompatibleConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: () => Promise<string | undefined>;
  listModels: () => Promise<ModelInfo[]>;
  capabilities: (model: string) => ProviderCapabilities;
  extraHeaders?: Record<string, string>;
  extraBody?: (req: ChatRequest) => Record<string, unknown>;
  /**
   * How to encode a reasoning effort on this endpoint. Defaults to the flat
   * `reasoning_effort` field used by OpenAI; providers with their own shape
   * (e.g. OpenRouter's nested `reasoning.effort`) override it.
   */
  reasoningEffortBody?: (effort: Exclude<ReasoningEffort, "off">) => Record<string, unknown>;
  fetch?: typeof fetch;
}

function mapFinish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * A provider for any OpenAI-compatible `/chat/completions` endpoint with
 * streaming, tool calls, reasoning fields and vision support.
 */
export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): Provider {
  const fetchImpl = config.fetch ?? globalThis.fetch;

  return {
    id: config.id,
    label: config.label,
    capabilities: config.capabilities,
    listModels: () => config.listModels(),

    async *chat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
      const apiKey = await config.apiKey();
      if (!apiKey) {
        yield {
          type: "error",
          error: {
            code: "missing_api_key",
            message: `No API key configured for ${config.label}.`,
          },
        };
        return;
      }

      const body: Record<string, unknown> = {
        model: req.model,
        messages: toOpenAIMessages(req.messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(config.extraBody?.(req) ?? {}),
      };
      // Map provider-safe wire names back to the canonical tool names.
      const canonicalNames = new Map<string, string>();
      if (req.tools && req.tools.length > 0) {
        body.tools = req.tools.map((tool) => {
          const wire = toWireName(tool.name);
          canonicalNames.set(wire, tool.name);
          return {
            type: "function",
            function: {
              name: wire,
              description: tool.description,
              parameters: tool.parameters,
            },
          };
        });
      }
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
      if (req.reasoningEffort && req.reasoningEffort !== "off") {
        Object.assign(
          body,
          config.reasoningEffortBody?.(req.reasoningEffort) ?? {
            reasoning_effort: req.reasoningEffort,
          },
        );
      }

      let response: Response;
      try {
        response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            authorization: `Bearer ${apiKey}`,
            ...config.extraHeaders,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        yield { type: "error", error: normalizeError(error, "network_error") };
        return;
      }

      if (!response.ok || !response.body) {
        const detail = await safeText(response);
        yield {
          type: "error",
          error: {
            code: `http_${response.status}`,
            message: `${config.label} error ${response.status}: ${detail.slice(0, 500)}`,
            retryable: response.status >= 500 || response.status === 429,
          },
        };
        return;
      }

      const toolAcc = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: FinishReason = "stop";

      try {
        for await (const chunk of iterateSSE(response.body, signal)) {
          if (chunk.error) {
            yield {
              type: "error",
              error: {
                code: "provider_error",
                message: chunk.error.message ?? "provider returned an error",
              },
            };
            return;
          }

          const choice = chunk.choices?.[0];
          const delta = choice?.delta;

          if (delta?.content) {
            yield { type: "text.delta", text: delta.content };
          }
          const reasoning = delta?.reasoning ?? delta?.reasoning_content;
          if (reasoning) {
            yield { type: "reasoning.delta", text: reasoning };
          }
          for (const tc of delta?.tool_calls ?? []) {
            const index = tc.index ?? 0;
            const acc = toolAcc.get(index) ?? { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            toolAcc.set(index, acc);
          }

          if (choice?.finish_reason) finishReason = mapFinish(choice.finish_reason);

          if (chunk.usage) {
            yield {
              type: "usage",
              usage: {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
                totalTokens: chunk.usage.total_tokens,
              },
            };
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          yield { type: "error", error: normalizeError(error, "stream_error") };
        }
        return;
      }

      for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
        if (!acc.name) continue;
        yield {
          type: "toolcall",
          call: {
            id: acc.id || newId("call"),
            name: canonicalNames.get(acc.name) ?? acc.name,
            args: parseArgs(acc.args),
          },
        };
      }

      yield { type: "done", finishReason: toolAcc.size > 0 ? "tool_calls" : finishReason };
    },
  };
}
