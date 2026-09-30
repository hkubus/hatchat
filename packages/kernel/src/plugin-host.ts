import type { Logger, Plugin, PluginContext, ProcessHost, SecretStore } from "@hat/core";
import { normalizeError } from "@hat/core";
import { toJsonSchema } from "./json-schema.js";
import type { ProviderRegistry, ToolRegistry } from "./registries.js";

export type PluginSource = "builtin" | "external";
export type PluginStatus = "active" | "disabled" | "needs-config" | "error";

export interface PluginState {
  enabled: boolean;
  config: unknown;
}

export interface PluginPersistence {
  get(pluginId: string): PluginState | undefined;
  set(pluginId: string, state: PluginState): void;
}

export interface PluginDescriptor {
  id: string;
  name: string;
  version: string;
  description?: string;
  permissions: string[];
  requiresSecrets: string[];
  source: PluginSource;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  config: unknown;
  configSchema?: unknown;
}

interface Contribution {
  providers: string[];
  tools: string[];
}

export interface PluginHostDeps {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  secrets: SecretStore;
  logger: Logger;
  persistence: PluginPersistence;
  processHost?: ProcessHost;
  /** See `PluginContext.runnerAvailable`. */
  runnerAvailable?: () => boolean;
}

/**
 * Loads plugins, calls their lifecycle hooks, and keeps the provider/tool
 * registries in sync with each plugin's enabled state and config.
 */
export class PluginHost {
  private readonly plugins = new Map<string, { plugin: Plugin; source: PluginSource }>();
  private readonly states = new Map<string, PluginState>();
  private readonly contributions = new Map<string, Contribution>();
  private readonly statuses = new Map<string, { status: PluginStatus; error?: string }>();

  constructor(private readonly deps: PluginHostDeps) {}

  register(plugin: Plugin, source: PluginSource = "builtin"): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`duplicate plugin id: ${plugin.id}`);
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(plugin.id)) {
      throw new Error(`invalid plugin id: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, { plugin, source });
    const persisted = this.deps.persistence.get(plugin.id);
    this.states.set(plugin.id, persisted ?? { enabled: true, config: {} });
  }

  async activateAll(): Promise<void> {
    for (const id of this.plugins.keys()) {
      await this.activate(id);
    }
  }

  /** Re-activate every plugin; used after secrets or config change. */
  async reload(): Promise<void> {
    for (const id of this.plugins.keys()) {
      await this.deactivate(id);
      await this.activate(id);
    }
  }

  async activate(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) return;
    const plugin = entry.plugin;
    const state = this.states.get(id) ?? { enabled: true, config: {} };

    if (!state.enabled) {
      this.statuses.set(id, { status: "disabled" });
      return;
    }

    const missing: string[] = [];
    try {
      for (const name of plugin.requiresSecrets ?? []) {
        if (!(await this.deps.secrets.get(name))) missing.push(name);
      }
    } catch (error) {
      // A secret store failing takes this plugin down, not every plugin after it.
      this.statuses.set(id, { status: "error", error: normalizeError(error, "plugin_secrets").message });
      return;
    }
    if (missing.length > 0) {
      this.statuses.set(id, { status: "needs-config", error: `missing secret: ${missing.join(", ")}` });
      return;
    }

    let config: unknown = state.config ?? {};
    if (plugin.configSchema) {
      const parsed = plugin.configSchema.safeParse(config);
      if (!parsed.success) {
        this.statuses.set(id, {
          status: "error",
          error: `invalid config: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        });
        return;
      }
      config = parsed.data;
    }

    const contribution: Contribution = { providers: [], tools: [] };
    const ctx: PluginContext = {
      pluginId: id,
      register: {
        provider: (provider) => {
          this.deps.providers.register(provider);
          contribution.providers.push(provider.id);
        },
        tool: (tool) => {
          this.deps.tools.register(tool);
          contribution.tools.push(tool.name);
        },
      },
      getConfig: <T = unknown>() => config as T,
      secrets: this.deps.secrets,
      processHost: this.deps.processHost,
      runnerAvailable: this.deps.runnerAvailable,
      logger: scopedLogger(id, this.deps.logger),
      fail: (error) => {
        // Only a live activation can fail this way: a stale one (since
        // deactivated) is ignored, and one still inside `activate` surfaces
        // its failure through the rejected activation below.
        if (this.contributions.get(id) !== contribution) return;
        this.rollback(contribution);
        this.contributions.delete(id);
        const message = normalizeError(error, "plugin_failed").message;
        this.statuses.set(id, { status: "error", error: message });
        this.deps.logger.warn(`plugin ${id} failed: ${message}`);
      },
    };

    try {
      await plugin.activate(ctx);
    } catch (error) {
      this.rollback(contribution);
      this.statuses.set(id, {
        status: "error",
        error: normalizeError(error, "plugin_activate_failed").message,
      });
      return;
    }

    this.contributions.set(id, contribution);
    this.statuses.set(id, { status: "active" });
  }

  async deactivate(id: string): Promise<void> {
    const entry = this.plugins.get(id);
    if (!entry) return;
    try {
      await entry.plugin.deactivate?.();
    } catch (error) {
      this.deps.logger.warn(`plugin ${id} deactivate failed`, String(error));
    }
    const contribution = this.contributions.get(id);
    if (contribution) {
      this.rollback(contribution);
      this.contributions.delete(id);
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const state = this.states.get(id);
    if (!state) return;
    state.enabled = enabled;
    this.deps.persistence.set(id, state);
    await this.deactivate(id);
    await this.activate(id);
  }

  async setConfig(id: string, config: unknown): Promise<void> {
    const state = this.states.get(id);
    if (!state) return;
    state.config = config;
    this.deps.persistence.set(id, state);
    await this.deactivate(id);
    await this.activate(id);
  }

  list(): PluginDescriptor[] {
    return [...this.plugins.entries()].map(([id, entry]) => this.describe(id, entry.plugin, entry.source));
  }

  get(id: string): PluginDescriptor | undefined {
    const entry = this.plugins.get(id);
    return entry ? this.describe(id, entry.plugin, entry.source) : undefined;
  }

  private describe(id: string, plugin: Plugin, source: PluginSource): PluginDescriptor {
    const state = this.states.get(id) ?? { enabled: true, config: {} };
    const status = this.statuses.get(id) ?? { status: "disabled" as PluginStatus };
    const configSchema = plugin.configSchema
      ? toJsonSchema(plugin.configSchema)
      : plugin.configJsonSchema;
    return {
      id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      permissions: plugin.permissions ?? [],
      requiresSecrets: plugin.requiresSecrets ?? [],
      source,
      enabled: state.enabled,
      status: status.status,
      error: "error" in status ? status.error : undefined,
      config: state.config ?? {},
      configSchema,
    };
  }

  private rollback(contribution: Contribution): void {
    for (const providerId of contribution.providers) this.deps.providers.unregister(providerId);
    for (const toolName of contribution.tools) this.deps.tools.unregister(toolName);
  }
}

function scopedLogger(pluginId: string, logger: Logger): Logger {
  const prefix = `[${pluginId}]`;
  return {
    debug: (m, meta) => logger.debug(`${prefix} ${m}`, meta),
    info: (m, meta) => logger.info(`${prefix} ${m}`, meta),
    warn: (m, meta) => logger.warn(`${prefix} ${m}`, meta),
    error: (m, meta) => logger.error(`${prefix} ${m}`, meta),
  };
}
