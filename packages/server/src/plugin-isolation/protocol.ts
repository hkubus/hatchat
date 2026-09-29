// Types shared by the server and the isolated plugin process (erasable only).
import type { HostCapabilities, ProviderCapabilities } from "@hat/core";

/** A plugin's static metadata, reported once the child has imported it. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  permissions: string[];
  requiresSecrets: string[];
  /** The zod `configSchema`, converted in the child. */
  configJsonSchema?: unknown;
}

/** `register.tool` note: a tool with its zod schema flattened to JSON Schema. */
export interface ToolRegistration {
  name: string;
  description: string;
  parameters?: unknown;
  /** A `requiresApproval` predicate can't cross IPC; it is reported as `true`. */
  requiresApproval: boolean;
}

/** `register.provider` note. `capabilities` is the answer for an unknown model. */
export interface ProviderRegistration {
  id: string;
  label: string;
  capabilities: ProviderCapabilities;
}

/**
 * The server-side context of one `tool.execute` request. `scope` names the call
 * in `host.*` requests and is only honoured while the call is running.
 */
export interface ToolCallInfo {
  scope: number;
  sessionId: string;
  callId?: string;
  messageId?: string;
  host: { id: string; capabilities: HostCapabilities };
}

/** Execution-host requests, keyed by the plugin permission each one needs. */
export const HOST_METHOD_PERMISSIONS = {
  "host.ensureWorkspace": ["runner:exec", "runner:fs", "runner:net"],
  "host.exec": ["runner:exec"],
  "host.fs.read": ["runner:fs"],
  "host.fs.write": ["runner:fs"],
  "host.fs.list": ["runner:fs"],
  "host.net.fetch": ["runner:net"],
} as const;
