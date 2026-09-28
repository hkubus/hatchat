import type { ModelInfo, Plugin, Provider, ProviderCapabilities } from "@hat/core";
import { createOpenAICompatibleProvider } from "@hat/provider-openai";
import { z } from "zod";

const BASE_URL = "https://api.deepseek.com/v1";
const CONTEXT_WINDOW = 65_536;

interface DeepSeekModel {
  id: string;
  label: string;
  capabilities: ProviderCapabilities;
}

const MODELS: DeepSeekModel[] = [
  {
    id: "deepseek-chat",
    label: "DeepSeek Chat (V3)",
    capabilities: {
      streaming: true,
      toolCalls: true,
      vision: false,
      imageGeneration: false,
      reasoning: false,
      reasoningEffort: false,
      jsonMode: true,
      systemPrompt: "native",
    },
  },
  {
    id: "deepseek-reasoner",
    label: "DeepSeek Reasoner (R1)",
    capabilities: {
      streaming: true,
      // The reasoner historically does not support function calling.
      toolCalls: false,
      vision: false,
      imageGeneration: false,
      reasoning: true,
      reasoningEffort: false,
      jsonMode: false,
      systemPrompt: "native",
    },
  },
];

const DEFAULT_CAPABILITIES = MODELS[0].capabilities;

export interface DeepSeekOptions {
  apiKey: () => Promise<string | undefined>;
  fetch?: typeof fetch;
}

export function createDeepSeekProvider(options: DeepSeekOptions): Provider {
  return createOpenAICompatibleProvider({
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: BASE_URL,
    apiKey: options.apiKey,
    fetch: options.fetch,
    capabilities: (model) =>
      MODELS.find((m) => m.id === model)?.capabilities ?? DEFAULT_CAPABILITIES,
    listModels: async () => {
      const infos: ModelInfo[] = MODELS.map((model) => ({
        id: `deepseek/${model.id}`,
        label: model.label,
        provider: "deepseek",
        contextWindow: CONTEXT_WINDOW,
        capabilities: model.capabilities,
      }));
      return infos;
    },
  });
}

export const deepSeekConfigSchema = z.object({
  baseUrl: z
    .string()
    .optional()
    .describe("Override the API base URL (default https://api.deepseek.com/v1)."),
});

export function createDeepSeekPlugin(): Plugin {
  return {
    id: "deepseek",
    name: "DeepSeek",
    version: "0.1.0",
    description: "DeepSeek chat and reasoner models via the official API.",
    permissions: ["net:https://api.deepseek.com"],
    requiresSecrets: ["DEEPSEEK_API_KEY"],
    configSchema: deepSeekConfigSchema,
    activate(ctx) {
      ctx.register.provider(
        createDeepSeekProvider({ apiKey: () => ctx.secrets.get("DEEPSEEK_API_KEY") }),
      );
    },
  };
}
