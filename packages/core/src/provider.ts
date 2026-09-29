import type { NormalizedError } from "./errors.js";
import type { ChatMessage, Usage } from "./messages.js";

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalls: boolean;
  vision: boolean;
  imageGeneration: boolean;
  reasoning: boolean;
  /** Whether `reasoningEffort` is accepted as a tunable knob. */
  reasoningEffort?: boolean;
  jsonMode: boolean;
  systemPrompt: "native" | "merge-first-user" | "none";
  /**
   * Maximum prompt + completion tokens, when the provider knows it. The kernel
   * uses it to keep long conversations from overflowing the model.
   */
  contextWindow?: number;
}

/**
 * How much internal reasoning a model should spend before answering. Providers
 * that expose a tunable effort level map this onto their own wire field; those
 * that don't simply ignore it.
 */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["off", "low", "medium", "high"];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export interface ModelInfo {
  /** Fully-qualified id, `${providerId}/${modelId}`. */
  id: string;
  label: string;
  provider: string;
  contextWindow?: number;
  capabilities: ProviderCapabilities;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** Ignored by providers whose capabilities do not include `reasoningEffort`. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Stable per-conversation key sent as `prompt_cache_key` where the provider
   * supports it (OpenAI). It only optimizes cache routing for requests that
   * already share a reusable prefix — it never merges different conversations.
   */
  cacheKey?: string;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

export interface ToolCallDelta {
  id: string;
  name: string;
  args: unknown;
}

export type ProviderEvent =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "toolcall"; call: ToolCallDelta }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: FinishReason }
  | { type: "error"; error: NormalizedError };

export interface Provider {
  readonly id: string;
  readonly label: string;
  capabilities(model: string): ProviderCapabilities;
  listModels(): Promise<ModelInfo[]>;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  toolCalls: false,
  vision: false,
  imageGeneration: false,
  reasoning: false,
  jsonMode: false,
  systemPrompt: "native",
};
