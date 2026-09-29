import type { ModelInfo, Provider, Tool, ToolSpec } from "@hat/core";
import { zodToJsonSchema } from "zod-to-json-schema";

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  register(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }

  async listModels(): Promise<ModelInfo[]> {
    const groups = await Promise.all(
      this.list().map(async (p) => {
        try {
          return await p.listModels();
        } catch {
          return [];
        }
      }),
    );
    return groups.flat();
  }

  resolve(modelId: string): { provider: Provider; model: string } {
    const slash = modelId.indexOf("/");
    if (slash === -1) {
      throw new Error(`Model id must be "provider/model", got "${modelId}"`);
    }
    const providerId = modelId.slice(0, slash);
    const model = modelId.slice(slash + 1);
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Unknown provider: ${providerId}`);
    }
    return { provider, model };
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  toToolSpecs(): ToolSpec[] {
    // Sorted by name: prompt caches are prefix-sensitive, and registration
    // order depends on plugin activation order, so an unstable order would
    // bust the cache (and reshuffle tool choice) without any user change.
    return this.list()
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((tool) => {
        let parameters: unknown = tool.parameters;
        if (parameters === undefined && tool.schema) {
          const jsonSchema = zodToJsonSchema(tool.schema, {
            // OpenAI-compatible providers expect JSON Schema (numeric exclusiveMinimum),
            // not OpenAPI 3.0's boolean form, and inline refs.
            target: "jsonSchema7",
            $refStrategy: "none",
          }) as Record<string, unknown>;
          delete jsonSchema.$schema;
          parameters = jsonSchema;
        }
        return {
          name: tool.name,
          description: tool.description,
          parameters: parameters ?? { type: "object", properties: {} },
        };
      });
  }
}
