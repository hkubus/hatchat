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

/**
 * Cached input tokens for a usage payload, or undefined when the provider
 * didn't report any. Prefers the OpenAI/OpenRouter nested
 * `prompt_tokens_details.cached_tokens` (even an explicit 0 wins) and falls
 * back to DeepSeek's documented top-level `prompt_cache_hit_tokens`.
 */
export function extractCachedTokens(usage: {
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
  prompt_cache_hit_tokens?: unknown;
}): number | undefined {
  const nested = usage.prompt_tokens_details?.cached_tokens;
  if (typeof nested === "number" && Number.isFinite(nested) && nested >= 0) return Math.floor(nested);
  const hit = usage.prompt_cache_hit_tokens;
  if (typeof hit === "number" && Number.isFinite(hit) && hit >= 0) return Math.floor(hit);
  return undefined;
}

/**
 * `Retry-After` as milliseconds: either delta-seconds or an HTTP date.
 * Undefined when absent or unparseable.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Statuses worth retrying: rate limits, timeouts and overloaded upstreams. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
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
      // Sorted by wire name so the request prefix is byte-stable across
      // turns: prompt caches key on the prefix, and tool order must not
      // shuffle when plugins activate in a different order.
      const canonicalNames = new Map<string, string>();
      if (req.tools && req.tools.length > 0) {
        const sorted = req.tools.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        body.tools = sorted.map((tool) => {
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
      // Stable per-conversation routing key: providers that support it use
      // this to keep requests with a shared prefix on the same cache shard.
      if (req.cacheKey) body.prompt_cache_key = req.cacheKey;
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
        // A connection that never got a response is safe to retry; an abort
        // is the user cancelling and must not be.
        yield {
          type: "error",
          error: { ...normalizeError(error, "network_error"), retryable: !signal.aborted },
        };
        return;
      }

      if (!response.ok || !response.body) {
        const detail = await safeText(response);
        yield {
          type: "error",
          error: {
            code: `http_${response.status}`,
            message: `${config.label} error ${response.status}: ${detail.slice(0, 500)}`,
            retryable: isRetryableStatus(response.status),
            retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
          },
        };
        return;
      }

      const toolAcc = new Map<number, { id: string; name: string; args: string }>();
      let finishReason: FinishReason = "stop";

      try {
        for await (const chunk of iterateSSE(response.body, signal)) {
          if (chunk.error) {
            // OpenRouter reports upstream rate limits and overloads in-stream,
            // with the HTTP-style status as the error code.
            const status = Number(chunk.error.code);
            yield {
              type: "error",
              error: {
                code: "provider_error",
                message: chunk.error.message ?? "provider returned an error",
                retryable: Number.isInteger(status) && isRetryableStatus(status),
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
            const cachedTokens = extractCachedTokens(chunk.usage);
            yield {
              type: "usage",
              usage: {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
                totalTokens: chunk.usage.total_tokens,
                ...(cachedTokens !== undefined ? { cachedTokens } : {}),
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
