// Entry point of an isolated plugin process: `child.ts <plugin file>`.
//
// Imports the plugin, reports its manifest and then serves the server's
// requests over the IPC channel. Everything the plugin can reach on the server
// (secrets, the execution host, logging) is a request back over that channel,
// checked on the server side. When sandboxed, this runs under Node's permission
// model with native type stripping, so it must stay erasable TypeScript.
import { pathToFileURL } from "node:url";
import type {
  ChatRequest,
  DirEntry,
  ExecEvent,
  ExecutionHost,
  FetchResponse,
  Logger,
  Plugin,
  PluginContext,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  SecretStore,
  Tool,
  ToolContext,
  WorkspaceInfo,
} from "@hat/core";
import { DEFAULT_CAPABILITIES, normalizeError } from "@hat/core";
import { toJsonSchema } from "@hat/kernel/json-schema";
import type { PluginManifest, ProviderRegistration, ToolCallInfo, ToolRegistration } from "./protocol.js";
import { RpcPeer, type RpcMessage } from "./rpc.js";

if (!process.send) {
  console.error("plugin child must be started with an IPC channel");
  process.exit(1);
}
const send = process.send.bind(process);

const peer = new RpcPeer((message: RpcMessage) => {
  send(message);
});
process.on("message", (message) => peer.receive(message));
// The server went away (or killed the channel): nothing left to serve.
process.on("disconnect", () => process.exit(0));
// A send racing the channel closing reports asynchronously; the disconnect
// handler above takes care of shutting down.
process.on("error", () => {});

/** Report why the plugin can't be served, then exit once that is delivered. */
function fatal(message: string): Promise<never> {
  return new Promise<never>(() => {
    const note: RpcMessage = { k: "note", method: "fatal", params: { message } };
    send(note, () => process.exit(1));
  });
}

// Die as Node would, but tell the server why first.
process.on("uncaughtException", (error) => {
  console.error(error);
  void fatal(`uncaught exception: ${normalizeError(error).message}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(reason);
  void fatal(`unhandled rejection: ${normalizeError(reason).message}`);
});

async function load(): Promise<Plugin> {
  const file = process.argv[2];
  if (!file) throw new Error("no plugin file given");
  let mod: { default?: Plugin; plugin?: Plugin };
  try {
    mod = (await import(pathToFileURL(file).href)) as typeof mod;
  } catch (error) {
    throw new Error(`import failed: ${normalizeError(error).message}`);
  }
  const plugin = mod.default ?? mod.plugin;
  if (!plugin || typeof plugin.id !== "string" || typeof plugin.activate !== "function") {
    throw new Error("does not export a valid Plugin");
  }
  return plugin;
}

const loaded = await load().catch((error: unknown) => fatal(normalizeError(error).message));

const logger: Logger = {
  debug: (msg, meta) => log("debug", msg, meta),
  info: (msg, meta) => log("info", msg, meta),
  warn: (msg, meta) => log("warn", msg, meta),
  error: (msg, meta) => log("error", msg, meta),
};

function log(level: keyof Logger, msg: string, meta: unknown): void {
  peer.notify("log", { level, msg: String(msg), meta: plain(meta) });
}

/** Only secrets named in `requiresSecrets` are served; the server enforces it. */
const secrets: SecretStore = {
  get: (name) => peer.request<string | undefined>("secrets.get", { name }),
};

const tools = new Map<string, Tool>();
const providers = new Map<string, Provider>();

peer.handle("activate", async (params: { config?: unknown }) => {
  let config: unknown = params?.config ?? {};
  if (loaded.configSchema) {
    const parsed = loaded.configSchema.safeParse(config);
    if (!parsed.success) {
      throw new Error(`invalid config: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    config = parsed.data;
  }
  const ctx: PluginContext = {
    pluginId: loaded.id,
    register: {
      tool: (tool) => {
        if (tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
        const registration: ToolRegistration = {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? (tool.schema ? toJsonSchema(tool.schema) : undefined),
          // Approval is decided on the server before the call reaches us, and a
          // predicate can't be evaluated there: err on the side of asking.
          requiresApproval:
            typeof tool.requiresApproval === "function" ? true : tool.requiresApproval === true,
        };
        tools.set(tool.name, tool);
        peer.notify("register.tool", registration);
      },
      provider: (provider) => {
        if (providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`);
        let capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;
        try {
          capabilities = provider.capabilities("");
        } catch {
          /* keep the defaults */
        }
        const registration: ProviderRegistration = {
          id: provider.id,
          label: provider.label,
          capabilities,
        };
        providers.set(provider.id, provider);
        peer.notify("register.provider", registration);
      },
    },
    getConfig: <T = unknown>() => config as T,
    secrets,
    // Long-lived runner processes (`processHost`) are not forwarded.
    logger,
  };
  await loaded.activate(ctx);
});

peer.handle("deactivate", async () => {
  await loaded.deactivate?.();
});

peer.handle("tool.execute", async (params: { name: string; args: unknown; call: ToolCallInfo }, rpc) => {
  const tool = tools.get(params.name);
  if (!tool) throw new Error(`unknown tool: ${params.name}`);
  // The server only has the JSON Schema; the zod schema is enforced here.
  const args = tool.schema ? tool.schema.parse(params.args) : params.args;
  const ctx: ToolContext = {
    sessionId: params.call.sessionId,
    callId: params.call.callId,
    messageId: params.call.messageId,
    host: remoteHost(params.call),
    secrets,
    approval: {
      request: async () => {
        throw new Error("approval requests are not available to isolated plugins");
      },
    },
    audit: { record() {} },
    logger,
    signal: rpc.signal,
  };
  return await tool.execute(args, ctx);
});

peer.handle("provider.listModels", async (params: { providerId: string }) => {
  return await providerFor(params.providerId).listModels();
});

peer.handle("provider.chat", async (params: { providerId: string; req: ChatRequest }, rpc) => {
  const provider = providerFor(params.providerId);
  for await (const event of provider.chat(params.req, rpc.signal)) {
    rpc.emit(wireEvent(event));
  }
});

function providerFor(id: string): Provider {
  const provider = providers.get(id);
  if (!provider) throw new Error(`unknown provider: ${id}`);
  return provider;
}

/**
 * The execution host of the call being served, as requests back to the
 * server. Pinned to the call's session: the `sessionId` arguments of
 * `ScopedFs` are ignored rather than trusted.
 */
function remoteHost(call: ToolCallInfo): ExecutionHost {
  const scope = call.scope;
  return {
    id: call.host.id,
    capabilities: call.host.capabilities,
    ensureWorkspace: () => peer.request<WorkspaceInfo>("host.ensureWorkspace", { scope }),
    exec: (req, signal) => peer.stream<ExecEvent>("host.exec", { scope, req }, signal),
    fs: {
      read: (_sessionId, path) => peer.request<string>("host.fs.read", { scope, path }),
      write: (_sessionId, path, data) => peer.request<void>("host.fs.write", { scope, path, data }),
      list: (_sessionId, path) => peer.request<DirEntry[]>("host.fs.list", { scope, path }),
    },
    net: {
      fetch: (url, init) => peer.request<FetchResponse>("host.net.fetch", { scope, url, init }),
    },
  };
}

/** Error causes are arbitrary objects; only the normalized fields cross over. */
function wireEvent(event: ProviderEvent): ProviderEvent {
  if (event.type !== "error") return event;
  const { code, message, retryable } = event.error;
  return { type: "error", error: { code, message, retryable } };
}

function plain(meta: unknown): unknown {
  if (meta === undefined) return undefined;
  if (meta instanceof Error) return meta.message;
  try {
    return JSON.parse(JSON.stringify(meta));
  } catch {
    return String(meta);
  }
}

const manifest: PluginManifest = {
  id: loaded.id,
  name: loaded.name,
  version: loaded.version,
  description: loaded.description,
  permissions: [...(loaded.permissions ?? [])],
  requiresSecrets: [...(loaded.requiresSecrets ?? [])],
  configJsonSchema: loaded.configSchema ? toJsonSchema(loaded.configSchema) : loaded.configJsonSchema,
};
peer.notify("ready", manifest);
