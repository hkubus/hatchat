import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExecutionHost,
  Logger,
  ModelInfo,
  Part,
  Plugin,
  PluginContext,
  Provider,
  ProviderCapabilities,
  ProviderEvent,
  Tool,
} from "@hat/core";
import {
  HOST_METHOD_PERMISSIONS,
  type PluginManifest,
  type ProviderRegistration,
  type ToolCallInfo,
  type ToolRegistration,
} from "./protocol.js";
import { RpcPeer, type RpcHandlerContext, type RpcMessage } from "./rpc.js";

const CHILD_ENTRY = fileURLToPath(new URL("./child.ts", import.meta.url));
const BOOTSTRAP_URL = new URL("./bootstrap.mjs", import.meta.url).href;

/** The only environment an isolated plugin sees; no keys, tokens or paths. */
const PASSTHROUGH_ENV = ["NODE_ENV", "TZ", "LANG"];

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export interface IsolationOptions {
  logger: Logger;
  /** How long the child may take to import the plugin. */
  startTimeoutMs?: number;
  /** How long `activate` may run before the child is killed. */
  activateTimeoutMs?: number;
}

/**
 * Whether plugin processes can be sandboxed: that needs the permission model,
 * native type stripping and in-thread module hooks (Node >= 22.18). Without
 * them plugins still get their own process and a scrubbed environment, but
 * can read the filesystem and spawn processes.
 */
export const sandboxSupported =
  typeof module.registerHooks === "function" &&
  Boolean(process.features.typescript) &&
  process.allowedNodeEnvironmentFlags.has("--permission");

/**
 * Load an external plugin file into its own process. The file is imported
 * once to read its manifest; every activation then runs in a fresh child that
 * is killed on deactivation. The returned proxy is registered like any other
 * plugin; its tools and providers forward over IPC.
 */
export async function loadIsolatedPlugin(file: string, options: IsolationOptions): Promise<Plugin> {
  const probe = new PluginProcess(file, options);
  let manifest: PluginManifest;
  try {
    manifest = checkManifest(await probe.started());
  } finally {
    await probe.stop();
  }

  let current: PluginProcess | undefined;
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    permissions: manifest.permissions,
    requiresSecrets: manifest.requiresSecrets,
    configJsonSchema: manifest.configJsonSchema,
    async activate(ctx) {
      const proc = new PluginProcess(file, options);
      current = proc;
      try {
        const fresh = await proc.started();
        // Secrets and permissions stay as loaded at startup; a file that now
        // claims another identity needs a restart to be picked up.
        if (fresh.id !== manifest.id) {
          throw new Error(`plugin file now exports "${fresh.id}"; restart the server to load it`);
        }
        await proc.activate(ctx, manifest);
      } catch (error) {
        if (current === proc) current = undefined;
        await proc.stop();
        throw error;
      }
    },
    async deactivate() {
      const proc = current;
      current = undefined;
      await proc?.stop();
    },
  };
}

interface RunningCall {
  sessionId: string;
  host: ExecutionHost;
  signal: AbortSignal;
}

/** One child process and the server side of its RPC channel. */
class PluginProcess {
  private readonly child: ChildProcess;
  private readonly peer: RpcPeer;
  private readonly label: string;
  private readonly ready: Promise<PluginManifest>;
  private readonly exited: Promise<void>;
  private readonly calls = new Map<number, RunningCall>();
  private nextScope = 1;
  private stopping = false;
  private activated = false;
  private dead = false;
  private fatal: string | undefined;
  private lastStderr = "";
  private onCrash: ((error: Error) => void) | undefined;

  constructor(
    file: string,
    private readonly options: IsolationOptions,
  ) {
    this.label = path.basename(file);
    const env: Record<string, string> = {};
    for (const name of PASSTHROUGH_ENV) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    this.child = fork(CHILD_ENTRY, [file], {
      ...launchOptions(path.dirname(file)),
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.peer = new RpcPeer((message: RpcMessage) => {
      if (this.child.connected) this.child.send(message);
      else throw new Error("plugin process is not running");
    });
    this.child.on("message", (message) => this.peer.receive(message));
    this.pipe(this.child.stdout, (line) => this.options.logger.info(`[${this.label}] ${line}`));
    this.pipe(this.child.stderr, (line) => {
      if (!/^Node\.js v\d/.test(line)) this.lastStderr = line;
      this.options.logger.warn(`[${this.label}] ${line}`);
    });

    let markReady: (manifest: PluginManifest) => void = () => {};
    let failReady: (error: Error) => void = () => {};
    this.ready = new Promise<PluginManifest>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    this.ready.catch(() => {});
    this.peer.on("ready", (manifest: PluginManifest) => markReady(manifest));
    this.peer.on("fatal", (params: { message?: unknown }) => {
      this.fatal = String(params?.message ?? "plugin process failed");
    });

    this.exited = new Promise<void>((resolve) => {
      const onGone = (reason: string): void => {
        if (this.dead) return;
        this.dead = true;
        const error = new Error(reason);
        this.peer.close(error);
        failReady(error);
        if (!this.stopping) this.onCrash?.(error);
        resolve();
      };
      this.child.once("exit", (code, signal) => onGone(this.exitReason(code, signal)));
      this.child.once("error", (error) => {
        onGone(`plugin process failed: ${error.message}`);
        this.child.kill("SIGKILL");
      });
    });
  }

  started(): Promise<PluginManifest> {
    const ms = this.options.startTimeoutMs ?? 15_000;
    return withTimeout(this.ready, ms, `plugin did not start within ${ms}ms`);
  }

  async activate(ctx: PluginContext, manifest: PluginManifest): Promise<void> {
    let registrationError: unknown;
    const register = (kind: string, fn: () => void): void => {
      try {
        fn();
      } catch (error) {
        if (this.activated) ctx.logger.warn(`late ${kind} registration failed`, String(error));
        else registrationError ??= error;
      }
    };
    this.peer.on("register.tool", (spec: ToolRegistration) =>
      register("tool", () => ctx.register.tool(this.proxyTool(checkTool(spec)))),
    );
    this.peer.on("register.provider", (spec: ProviderRegistration) =>
      register("provider", () => ctx.register.provider(this.proxyProvider(checkProvider(spec)))),
    );
    this.peer.on("log", (params: { level?: unknown; msg?: unknown; meta?: unknown }) => {
      const level = LOG_LEVELS.find((l) => l === params?.level) ?? "info";
      ctx.logger[level](String(params?.msg ?? ""), params?.meta);
    });
    this.peer.handle("secrets.get", async (params: { name?: unknown }) => {
      const name = String(params?.name ?? "");
      if (!manifest.requiresSecrets.includes(name)) {
        throw new Error(`secret "${name}" is not declared in requiresSecrets`);
      }
      return ctx.secrets.get(name);
    });
    this.serveHost(manifest);
    this.onCrash = (error) => ctx.fail?.(error);

    this.activated = true;
    const ms = this.options.activateTimeoutMs ?? 30_000;
    await withTimeout(
      this.peer.request("activate", { config: ctx.getConfig() }),
      ms,
      `plugin activation timed out after ${ms}ms`,
    );
    if (registrationError) throw registrationError;
  }

  /** Let the plugin clean up, then kill the process. Safe to call repeatedly. */
  async stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      if (this.activated && !this.dead) {
        await withTimeout(this.peer.request("deactivate", {}), 5_000, "deactivate timed out").catch(
          (error: unknown) => this.options.logger.warn(`[${this.label}] ${String(error)}`),
        );
      }
      this.child.kill("SIGKILL");
    }
    await this.exited;
  }

  private proxyTool(spec: ToolRegistration): Tool {
    return {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      requiresApproval: spec.requiresApproval,
      execute: async (args, ctx) => {
        const scope = this.nextScope++;
        this.calls.set(scope, { sessionId: ctx.sessionId, host: ctx.host, signal: ctx.signal });
        const call: ToolCallInfo = {
          scope,
          sessionId: ctx.sessionId,
          callId: ctx.callId,
          messageId: ctx.messageId,
          host: { id: ctx.host.id, capabilities: ctx.host.capabilities },
        };
        try {
          const parts = await this.peer.request<Part[]>(
            "tool.execute",
            { name: spec.name, args, call },
            { signal: ctx.signal },
          );
          if (!Array.isArray(parts)) throw new Error("tool returned a malformed result");
          return parts;
        } finally {
          this.calls.delete(scope);
        }
      },
    };
  }

  private proxyProvider(spec: ProviderRegistration): Provider {
    // `capabilities` is synchronous, so it answers from what `listModels`
    // last reported, falling back to the registration-time default.
    const known = new Map<string, ProviderCapabilities>();
    const prefix = `${spec.id}/`;
    return {
      id: spec.id,
      label: spec.label,
      capabilities: (model) => known.get(model) ?? spec.capabilities,
      listModels: async () => {
        const models = await this.peer.request<ModelInfo[]>("provider.listModels", {
          providerId: spec.id,
        });
        if (!Array.isArray(models)) throw new Error("provider returned a malformed model list");
        for (const model of models) {
          if (typeof model?.id === "string" && model.id.startsWith(prefix) && model.capabilities) {
            known.set(model.id.slice(prefix.length), model.capabilities);
          }
        }
        return models;
      },
      chat: (req, signal) =>
        this.peer.stream<ProviderEvent>("provider.chat", { providerId: spec.id, req }, signal),
    };
  }

  /**
   * Serve the execution host of a running tool call. Each request names the
   * call's scope, is checked against the plugin's declared `runner:*`
   * permissions, and stays pinned to that call's session.
   */
  private serveHost(manifest: PluginManifest): void {
    const serve = (
      method: keyof typeof HOST_METHOD_PERMISSIONS,
      fn: (call: RunningCall, params: any, rpc: RpcHandlerContext, signal: AbortSignal) => unknown,
    ): void => {
      this.peer.handle(method, async (params: { scope?: unknown }, rpc) => {
        const needed: readonly string[] = HOST_METHOD_PERMISSIONS[method];
        if (!needed.some((p) => manifest.permissions.includes(p))) {
          throw new Error(`${method} requires the ${needed.join(" or ")} permission`);
        }
        const call = this.calls.get(Number(params?.scope));
        if (!call) throw new Error("the tool call has already finished");
        return fn(call, params, rpc, AbortSignal.any([rpc.signal, call.signal]));
      });
    };
    serve("host.ensureWorkspace", (call) => call.host.ensureWorkspace(call.sessionId));
    serve("host.exec", async (call, params, rpc, signal) => {
      if (typeof params.req?.command !== "string") throw new Error("exec needs a command");
      for await (const event of call.host.exec(params.req, signal)) rpc.emit(event);
    });
    serve("host.fs.read", (call, params) => call.host.fs.read(call.sessionId, String(params.path)));
    serve("host.fs.write", (call, params) =>
      call.host.fs.write(call.sessionId, String(params.path), String(params.data)),
    );
    serve("host.fs.list", (call, params) => call.host.fs.list(call.sessionId, String(params.path)));
    serve("host.net.fetch", (call, params) =>
      call.host.net.fetch(String(params.url), params.init ?? undefined),
    );
  }

  private exitReason(code: number | null, signal: NodeJS.Signals | null): string {
    if (this.fatal) return this.fatal;
    const how = signal ? `signal ${signal}` : `code ${code}`;
    return `plugin process exited (${how})${this.lastStderr ? `: ${this.lastStderr}` : ""}`;
  }

  private pipe(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
    if (!stream) return;
    let buffered = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line.trimEnd());
    });
    stream.on("end", () => {
      if (buffered.trim()) onLine(buffered.trimEnd());
    });
  }
}

/**
 * Sandboxed: the permission model with read access to the plugin's directory
 * and the code it can import, nothing else; no writes, child processes,
 * workers or native addons. Unsandboxed: the parent's loader flags (tsx).
 */
function launchOptions(pluginDir: string): { execArgv: string[]; cwd: string } {
  if (!sandboxSupported) {
    // Bare `--import tsx` style specifiers resolve against the cwd.
    return { execArgv: loaderFlags(process.execArgv), cwd: process.cwd() };
  }
  return {
    execArgv: [
      "--permission",
      ...readablePaths(pluginDir).map((dir) => `--allow-fs-read=${dir}`),
      "--disable-warning=ExperimentalWarning",
      "--import",
      BOOTSTRAP_URL,
    ],
    cwd: pluginDir,
  };
}

function loaderFlags(argv: readonly string[]): string[] {
  const flags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (/^--(import|require|loader|experimental-loader)=/.test(arg)) {
      flags.push(arg);
    } else if (/^(--import|--require|-r|--loader|--experimental-loader)$/.test(arg) && argv[i + 1]) {
      flags.push(arg, argv[++i]);
    }
  }
  return flags;
}

const readableCache = new Map<string, string[]>();

/**
 * Directories a sandboxed plugin process may read: the plugin's own directory,
 * the child runtime, every `node_modules` on their ancestor chains, and the
 * packages those link to (pnpm workspace packages live outside node_modules),
 * followed transitively. Data dirs, the master key and the rest of the
 * filesystem stay unreadable.
 */
function readablePaths(pluginDir: string): string[] {
  const cached = readableCache.get(pluginDir);
  if (cached) return cached;
  const roots: string[] = [];
  const queue: string[] = [];
  const covered = (dir: string): boolean =>
    roots.some((root) => dir === root || dir.startsWith(root + path.sep));
  const allow = (dir: string): void => {
    const real = realpath(dir);
    if (!real || covered(real)) return;
    roots.push(real);
    queue.push(real);
  };

  const starts = [pluginDir, path.dirname(CHILD_ENTRY)];
  for (const start of starts) allow(start);
  for (const start of starts) {
    let dir = realpath(start);
    while (dir) {
      allow(path.join(dir, "node_modules"));
      const parent = path.dirname(dir);
      dir = parent === dir ? undefined : parent;
    }
  }
  while (queue.length > 0) {
    const root = queue.shift() as string;
    const modules = path.basename(root) === "node_modules" ? root : path.join(root, "node_modules");
    for (const link of symlinkedPackages(modules)) allow(link);
  }
  readableCache.set(pluginDir, roots);
  return roots;
}

function symlinkedPackages(modulesDir: string): string[] {
  const links: string[] = [];
  const scan = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) links.push(full);
      else if (depth === 0 && entry.isDirectory() && entry.name.startsWith("@")) scan(full, 1);
    }
  };
  scan(modulesDir, 0);
  return links;
}

function realpath(dir: string): string | undefined {
  try {
    return fs.realpathSync(dir);
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The child is untrusted: check the shapes it reports before using them.

function checkManifest(value: PluginManifest): PluginManifest {
  const strings = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((item) => typeof item === "string");
  if (
    typeof value?.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.version !== "string" ||
    (value.description !== undefined && typeof value.description !== "string") ||
    !strings(value.permissions) ||
    !strings(value.requiresSecrets)
  ) {
    throw new Error("plugin reported a malformed manifest");
  }
  return value;
}

function checkTool(spec: ToolRegistration): ToolRegistration {
  if (typeof spec?.name !== "string" || typeof spec.description !== "string") {
    throw new Error("malformed tool registration");
  }
  return { ...spec, requiresApproval: spec.requiresApproval !== false };
}

function checkProvider(spec: ProviderRegistration): ProviderRegistration {
  if (typeof spec?.id !== "string" || typeof spec.label !== "string" || !spec.capabilities) {
    throw new Error("malformed provider registration");
  }
  return spec;
}
