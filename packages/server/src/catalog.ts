import type { CapabilityNeeds, ModelInfo } from "@hat/core";
import { satisfies } from "@hat/core";
import type { ProviderRegistry } from "@hat/kernel";

/** Cached aggregation of models across providers, used for capability routing. */
export class ModelCatalog {
  private cache: { at: number; models: ModelInfo[] } | null = null;

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly ttlMs = 300_000,
  ) {}

  async list(force = false): Promise<ModelInfo[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) {
      return this.cache.models;
    }
    const models = await this.providers.listModels();
    this.cache = { at: Date.now(), models };
    return models;
  }

  /** First model that satisfies the needs, preferring the given model's provider. */
  async findForNeeds(
    needs: CapabilityNeeds,
    preferredModel?: string,
  ): Promise<ModelInfo | undefined> {
    const models = await this.list();
    const matches = models.filter((model) => satisfies(model.capabilities, needs));
    if (matches.length === 0) return undefined;
    const preferredProvider = preferredModel?.split("/")[0];
    return matches.find((model) => model.provider === preferredProvider) ?? matches[0];
  }
}
