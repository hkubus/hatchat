import type { ModelInfo, Plugin, Provider, ProviderCapabilities } from "@hat/core";
import { createOpenAICompatibleProvider } from "@hat/provider-openai";
import { z } from "zod";

const BASE_URL = "https://openrouter.ai/api/v1";

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
}

export interface OpenRouterOptions {
  apiKey: () => Promise<string | undefined>;
  fetch?: typeof fetch;
  appTitle?: string;
  appUrl?: string;
  providerOrder?: string[];
  allowFallbacks?: boolean;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  toolCalls: true,
  vision: false,
  imageGeneration: false,
  reasoning: false,
  reasoningEffort: false,
  jsonMode: true,
  systemPrompt: "native",
};

export function createOpenRouterProvider(options: OpenRouterOptions): Provider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const cache = new Map<string, ProviderCapabilities>();

  const headers: Record<string, string> = {};
  if (options.appUrl) headers["HTTP-Referer"] = options.appUrl;
  if (options.appTitle) headers["X-Title"] = options.appTitle;

  const hasRouting = Boolean(options.providerOrder?.length) || options.allowFallbacks !== undefined;

  return createOpenAICompatibleProvider({
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: BASE_URL,
    apiKey: options.apiKey,
    fetch: options.fetch,
    extraHeaders: headers,
    extraBody: hasRouting
      ? () => ({
          provider: {
            order: options.providerOrder,
            allow_fallbacks: options.allowFallbacks,
          },
        })
      : undefined,
    // OpenRouter takes a structured object rather than the flat
    // `reasoning_effort` field the OpenAI-compatible shape uses.
    reasoningEffortBody: (effort) => ({ reasoning: { effort } }),
    capabilities: (model) => cache.get(model) ?? DEFAULT_CAPABILITIES,
    listModels: async () => {
      const response = await fetchImpl(`${BASE_URL}/models`, { headers });
      if (!response.ok) throw new Error(`openrouter models: ${response.status}`);
      const json = (await response.json()) as { data?: OpenRouterModel[] };
      return (json.data ?? []).map((model) => {
        const params = model.supported_parameters ?? [];
        const modalities = model.architecture?.input_modalities ?? [];
        const capabilities: ProviderCapabilities = {
          streaming: true,
          toolCalls: params.includes("tools"),
          vision: modalities.includes("image"),
          imageGeneration: false,
          reasoning: params.includes("reasoning"),
          // OpenRouter exposes the effort level on models that accept
          // `reasoning`; others fall back to their own default.
          reasoningEffort: params.includes("reasoning"),
          jsonMode:
            params.includes("response_format") || params.includes("structured_outputs"),
          systemPrompt: "native",
        };
        cache.set(model.id, capabilities);
        const info: ModelInfo = {
          id: `openrouter/${model.id}`,
          label: model.name ?? model.id,
          provider: "openrouter",
          contextWindow: model.context_length,
          capabilities,
        };
        return info;
      });
    },
  });
}

export interface OpenRouterPluginOptions {
  appTitle?: string;
  appUrl?: string;
}

export const openRouterConfigSchema = z.object({
  providerOrder: z
    .string()
    .optional()
    .describe("Comma-separated provider slugs to prefer (OpenRouter routing)."),
  allowFallbacks: z
    .boolean()
    .optional()
    .describe("Allow OpenRouter to fall back to other providers."),
});

export function createOpenRouterPlugin(options: OpenRouterPluginOptions = {}): Plugin {
  return {
    id: "openrouter",
    name: "OpenRouter",
    version: "0.1.0",
    description: "Hundreds of models from many providers behind one API and one key.",
    permissions: ["net:https://openrouter.ai"],
    requiresSecrets: ["OPENROUTER_API_KEY"],
    configSchema: openRouterConfigSchema,
    activate(ctx) {
      const config = ctx.getConfig<{ providerOrder?: string; allowFallbacks?: boolean }>();
      ctx.register.provider(
        createOpenRouterProvider({
          apiKey: () => ctx.secrets.get("OPENROUTER_API_KEY"),
          appTitle: options.appTitle,
          appUrl: options.appUrl,
          providerOrder: config.providerOrder
            ?.split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          allowFallbacks: config.allowFallbacks,
        }),
      );
    },
  };
}
