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
  /**
   * Whether a runner is currently connected. Lets a plugin keep its
   * registrations stable across runner churn and report a clear error instead
   * of vanishing from the model's tool list.
   */
  runnerAvailable?: () => boolean;
  logger: Logger;
  /**
   * Report that the plugin broke after activation (e.g. its isolated process
   * died): its contributions are unregistered and its status becomes `error`
   * until it is re-activated. No-op once this activation has ended.
   */
  fail?(error: unknown): void;
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
  /**
   * Raw JSON Schema for config, for plugins that can't hand over zod (isolated
   * external plugins). The host skips validation; the plugin validates itself.
   */
  readonly configJsonSchema?: unknown;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
  /**
   * A conversation was deleted: let go of whatever was kept for it (a
   * background process, an interpreter, a browser page). Called on active
   * plugins only.
   */
  sessionDeleted?(sessionId: string): void | Promise<void>;
}
