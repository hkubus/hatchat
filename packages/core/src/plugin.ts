import type { ZodTypeAny } from "zod";
import type { Logger, SecretStore } from "./context.js";
import type { ProcessHost } from "./process.js";
import type { Provider } from "./provider.js";
import type { Tool } from "./tool.js";

export interface PluginRegistration {
  provider(provider: Provider): void;
  tool(tool: Tool): void;
}

export interface PluginContext {
  pluginId: string;
  register: PluginRegistration;
  /** Config parsed against the plugin's `configSchema`. */
  getConfig<T = unknown>(): T;
  /** Named secrets (provider keys, tokens). Never logged or returned to clients. */
  secrets: SecretStore;
  /** Host for long-lived processes (stdio MCP); undefined when no runner is connected. */
  processHost?: ProcessHost;
  logger: Logger;
}

/**
 * A plugin contributes providers/tools at activation time. Activation may be
 * repeated (on config change or secret change); `deactivate` must be safe to
 * call before every re-activation.
 */
export interface Plugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  /** Declared capabilities, e.g. `net:https://openrouter.ai`, `runner:exec`. */
  readonly permissions?: string[];
  /** Secret names the plugin needs; it stays in `needs-config` until set. */
  readonly requiresSecrets?: string[];
  readonly configSchema?: ZodTypeAny;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
