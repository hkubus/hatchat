export interface OpenAIStreamToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAIStreamDelta {
  role?: string;
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAIStreamToolCall[];
}

export interface OpenAIStreamChoice {
  index?: number;
  delta?: OpenAIStreamDelta;
  finish_reason?: string | null;
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  /** DeepSeek's native (documented) cache fields; also mirrored into the nested shape. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface OpenAIStreamChunk {
  choices?: OpenAIStreamChoice[];
  usage?: OpenAIUsage | null;
  error?: { message?: string; code?: string | number; type?: string };
}

/**
 * Parse an OpenAI-compatible `text/event-stream` body into chunk objects.
 * Ignores comments/keep-alives and stops at `[DONE]`.
 */
export async function* iterateSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<OpenAIStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data === "[DONE]") return;
        if (data) {
          try {
            yield JSON.parse(data) as OpenAIStreamChunk;
          } catch {
            /* skip malformed frame */
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
