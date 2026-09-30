import type {
  ApprovalDecision,
  ChatMessage,
  ExecutionHost,
  MessageMeta,
  KernelEvent,
  Part,
  ProcessHost,
  ProviderCapabilities,
  SpawnRequest,
  ToolPolicy,
} from "@hat/core";
import {
  AsyncQueue,
  DEFAULT_TOOL_POLICY,
  inferNeeds,
  isReasoningEffort,
  normalizeError,
  unmetNeeds,
} from "@hat/core";
import { loadMasterKey } from "@hat/crypto";
import { createArtifactStore } from "@hat/artifacts";
import {
  RateLimiter,
  newToken,
  signSession,
  verifyPassword,
  verifySession,
} from "@hat/auth";
import { createRemoteHost } from "@hat/host-remote";
import { Agent, PluginHost, ProviderRegistry, ToolRegistry } from "@hat/kernel";
import { createMcpPlugin } from "@hat/mcp";
import { createDeepSeekPlugin } from "@hat/provider-deepseek";
import { createOpenRouterPlugin } from "@hat/provider-openrouter";
import type { SessionRecord } from "@hat/store-sqlite";
import { Store } from "@hat/store-sqlite";
import { createShellPlugin } from "@hat/tool-shell";
import { createBrowserPlugin } from "@hat/tool-browser";
import { ceneoPrompt, createCeneoPlugin } from "@hat/tool-ceneo";
import { createWebSearchPlugin } from "@hat/tool-websearch";
import { createFsPlugin } from "@hat/tool-fs";
import { createWebFetchPlugin } from "@hat/tool-webfetch";
import { createProcessPlugin, createPythonPlugin } from "@hat/tool-process";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import crypto from "node:crypto";
import { ApprovalManager } from "./approvals.js";
import type { ServerConfig } from "./config.js";
import { createFakePlugin } from "./fake-provider.js";
import { RunnerRegistry } from "./link.js";
import { createAuditLog, createLogger } from "./logger.js";
import { KEEPALIVE, kernelStream } from "./sse.js";
import { generateTitle } from "./title.js";
import { IMAGE_MIME, readUpload } from "./documents.js";
import { exportMarkdown, isSessionExport } from "./transfer.js";
import { TurnHub, type Turn } from "./turns.js";
import { loadExternalPlugins } from "./plugin-loader.js";
import { createArtifactsPlugin } from "./tools/artifacts.js";
import { createMemoryPlugin, memoryPrompt } from "./tools/memory.js";
import { QuestionManager, createPlanningPlugin } from "./tools/planning.js";
import { Scheduler, createSchedulerPlugin, nextRunFor } from "./tools/schedule.js";
import { createSubagentPlugin } from "./tools/subagent.js";

export interface ServerRuntime {
  app: Hono;
  registry: RunnerRegistry;
  store: Store;
  close(): void;
}

interface TurnOptions {
  sessionId: string;
  history: ChatMessage[];
  userText?: string;
  userParts?: Part[];
  userMeta?: MessageMeta;
}

/** What the "Continue" button sends on the user's behalf. */
const CONTINUE_PROMPT =
  "Your previous reply was cut off by the output limit. Continue exactly where it stopped, " +
  "without repeating what you already wrote and without any preamble.";

export async function createServer(config: ServerConfig): Promise<ServerRuntime> {
  const logger = createLogger();
  const audit = createAuditLog(logger);

  const master = loadMasterKey({ filePath: config.masterKeyPath });
  if (master.source === "generated") {
    logger.warn(`generated a new master key at ${master.path} (set HAT_MASTER_KEY in production)`);
  }
  const artifacts = createArtifactStore({ dir: config.uploadDir, s3: config.s3 });
  logger.info(`artifact backend: ${artifacts.kind}`);
  const store = new Store(config.dbPath, master.key, artifacts);

  const providers = new ProviderRegistry();
  const tools = new ToolRegistry();

  /**
   * stdio MCP servers live on the runner, so the plugin is wired when a runner
   * is present. A runner joining (re)spawns them; one leaving does *not*
   * unregister the tools, because that would pull them out of the model's tool
   * list mid-turn — the plugin reports the outage per call instead.
   *
   * Runners flap (reconnecting on every command), and PluginHost activation is
   * not reentrant, so the work is chained rather than fired concurrently.
   */
  const runnerAwarePlugins = ["mcp"];
  let runnerSync: Promise<void> = Promise.resolve();
  const syncRunnerPlugins = (): void => {
    runnerSync = runnerSync
      .then(async () => {
        const available = registry.list().length > 0;
        for (const id of runnerAwarePlugins) {
          const descriptor = pluginHost.get(id);
          if (!descriptor?.enabled) continue;
          if (available) {
            // Always cycle: an already-active plugin is holding stdio
            // processes that died with the previous runner.
            logger.info(`runner available; (re)connecting plugin ${id}`);
            await pluginHost.deactivate(id);
            await pluginHost.activate(id);
          } else {
            continue;
          }
          const after = pluginHost.get(id);
          logger.info(
            `plugin ${id}: ${after?.status}${after?.error ? ` (${after.error})` : ""}`,
          );
        }
      })
      .catch((error) => {
        logger.error("runner plugin sync failed", normalizeError(error, "runner_sync_failed"));
      });
  };

  const registry = new RunnerRegistry(logger, config.enrollToken, () => {
    syncRunnerPlugins();
  });

  const processHost: ProcessHost = {
    async spawn(request: SpawnRequest) {
      const channel = registry.acquire();
      if (!channel) throw new Error("No runner connected; cannot start a process.");
      return channel.spawn(request);
    },
  };

  const pluginHost = new PluginHost({
    providers,
    tools,
    secrets: store,
    logger,
    processHost,
    runnerAvailable: () => registry.list().length > 0,
    persistence: {
      get: (id) => store.getPluginState(id),
      set: (id, state) => store.setPluginState(id, state),
    },
  });

  pluginHost.register(
    createOpenRouterPlugin({ appTitle: config.appTitle, appUrl: config.appUrl }),
  );
  pluginHost.register(createDeepSeekPlugin());
  pluginHost.register(createShellPlugin());
  pluginHost.register(createWebSearchPlugin());
  pluginHost.register(createCeneoPlugin());
  pluginHost.register(createBrowserPlugin());
  pluginHost.register(createFsPlugin());
  pluginHost.register(createWebFetchPlugin());
  pluginHost.register(createProcessPlugin());
  pluginHost.register(createPythonPlugin());
  pluginHost.register(createArtifactsPlugin(store));
  pluginHost.register(createMemoryPlugin(store));
  const questions = new QuestionManager(config.approvalTimeoutMs);
  pluginHost.register(createPlanningPlugin(questions));
  pluginHost.register(
    createSubagentPlugin({
      agent: () => agent,
      sessionSettings: (sessionId) => {
        const session = store.getSession(sessionId);
        return {
          model: session?.model ?? "fake/fake-agent",
          toolPolicy: session ? policyFor(session) : undefined,
          reasoningEffort: session?.reasoningEffort,
        };
      },
    }),
  );
  const scheduler = new Scheduler({
    store,
    logger,
    isBusy: (sessionId) => {
      const turn = turns.get(sessionId);
      return Boolean(turn && !turn.done);
    },
    runPrompt: (sessionId, prompt) =>
      new Promise<void>((resolve) => {
        const turn = runTurn({
          sessionId,
          history: pathOf(sessionId).map((n) => n.message),
          userText: prompt,
        });
        turn.subscribe({ onEvent: () => {}, onEnd: resolve });
      }),
  });
  pluginHost.register(
    createSchedulerPlugin({
      store,
      scheduler,
      modelFor: (sessionId) => store.getSession(sessionId)?.model ?? "fake/fake-agent",
    }),
  );
  pluginHost.register(createFakePlugin());
  pluginHost.register(createMcpPlugin());

  for (const plugin of config.enableExternalPlugins
    ? await loadExternalPlugins(config.pluginsDir, logger, { isolate: config.pluginIsolation })
    : []) {
    pluginHost.register(plugin, "external");
  }
  if (!config.enableExternalPlugins) {
    logger.info("external plugins disabled (HAT_ENABLE_EXTERNAL_PLUGINS=false)");
  } else if (!config.pluginIsolation) {
    logger.warn("external plugin isolation is off (HAT_PLUGINS_ISOLATION); plugins run in-process");
  }

  await pluginHost.activateAll();
  for (const descriptor of pluginHost.list()) {
    if (descriptor.status !== "active") {
      logger.info(`plugin ${descriptor.id}: ${descriptor.status}${descriptor.error ? ` (${descriptor.error})` : ""}`);
    }
  }

  const turns = new TurnHub();
  const approvals = new ApprovalManager((sessionId, event) => {
    turns.emit(sessionId, event);
  }, config.approvalTimeoutMs);

  const resolveHost = async (sessionId: string): Promise<ExecutionHost> => {
    const channel = registry.acquire();
    if (!channel) {
      throw new Error(
        "No runner connected. Start @hat/runner and make sure it can reach the server's /link endpoint.",
      );
    }
    await channel.ensureWorkspace(sessionId);
    return createRemoteHost(channel, sessionId);
  };

  const agent = new Agent({
    providers,
    tools,
    resolveHost,
    approval: approvals,
    secrets: store,
    audit,
    logger,
    systemPrompt: config.systemPrompt,
    systemContext: () =>
      [
        pluginHost.get("memory")?.status === "active" ? memoryPrompt(store) : undefined,
        pluginHost.get("ceneo")?.status === "active"
          ? ceneoPrompt(tools.list().map((tool) => tool.name))
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n") || undefined,
    maxToolIterations: config.maxToolIterations,
    onMessage: (sessionId, message) => store.appendMessage(sessionId, message),
    resolveImage: async (attachmentId) => {
      const record = store.getAttachment(attachmentId);
      const data = await store.readAttachment(attachmentId);
      if (!record || !data) return undefined;
      return { data: data.toString("base64"), mime: record.mime };
    },
    resolveFile: async (attachmentId) => {
      const text = store.getAttachmentText(attachmentId);
      return text === undefined ? undefined : { text };
    },
    maxRetries: config.providerRetries,
  });

  const app = new Hono();

  // Baseline security headers for all responses.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    // Only send HSTS when cookies are Secure (i.e. serving over HTTPS).
    if (config.cookieSecure) c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });

  // Native shells (desktop/mobile) load the UI from their own asset origin and
  // authenticate with a bearer token, so their requests are cross-origin.
  // Credentials stay off: the browser app is same-origin and keeps using the
  // session cookie, which CORS would not allow from another origin anyway.
  const allowedOrigins = new Set(config.corsOrigins);
  app.use(
    "/api/*",
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", "x-csrf-token"],
      maxAge: 600,
    }),
  );

  const authRequired = Boolean(config.authPasswordHash || config.authToken);
  const sessionSecret = master.key;
  const sessionTtlSeconds = Math.floor(config.sessionTtlMs / 1000);
  const cookieOptions = {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: config.cookieSecure,
    path: "/",
    maxAge: sessionTtlSeconds,
  };
  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const turnLimiter = new RateLimiter(60, 60_000);
  const uploadLimiter = new RateLimiter(30, 60_000);

  function clientIp(c: Context): string {
    // Prefer the last forwarded entry (closest proxy) and fall back to direct.
    // Full proxy-trust needs explicit config; this at least stops trivial
    // header-rotation bypasses from resetting the login bucket alone.
    const forwarded = c.req.header("x-forwarded-for");
    if (forwarded) {
      const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
    return c.req.header("x-real-ip")?.trim() || "local";
  }

  const bearerAuthed = (c: Context): boolean => {
    const header = c.req.header("authorization");
    if (!config.authToken || !header) return false;
    const expected = `Bearer ${config.authToken}`;
    const a = Buffer.from(header);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const isAuthenticated = (c: Context): boolean => {
    if (bearerAuthed(c)) return true;
    const token = getCookie(c, "hat_session");
    return Boolean(token && verifySession(token, sessionSecret));
  };

  // ---- auth routes (unauthenticated) --------------------------------------

  app.get("/api/auth/status", (c) =>
    c.json({
      required: authRequired,
      authenticated: !authRequired || isAuthenticated(c),
      password: Boolean(config.authPasswordHash),
    }),
  );

  app.post("/api/auth/login", async (c) => {
    if (!config.authPasswordHash) {
      return c.json({ error: "password auth is not configured" }, 400);
    }
    const ip = clientIp(c);
    if (!loginLimiter.allow(ip)) {
      return c.json({ error: "too many attempts; try again later" }, 429);
    }
    let body: { password?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    if (!body.password || !verifyPassword(body.password, config.authPasswordHash)) {
      return c.json({ error: "invalid password" }, 401);
    }
    loginLimiter.reset(ip);
    const csrf = newToken();
    setCookie(
      c,
      "hat_session",
      signSession({ sub: "user", exp: Date.now() + config.sessionTtlMs }, sessionSecret),
      cookieOptions,
    );
    setCookie(c, "hat_csrf", csrf, { ...cookieOptions, httpOnly: false });
    return c.json({ ok: true, csrfToken: csrf });
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, "hat_session", { path: "/" });
    deleteCookie(c, "hat_csrf", { path: "/" });
    return c.json({ ok: true });
  });

  // ---- auth middleware ----------------------------------------------------

  app.use("/api/*", async (c, next) => {
    const path = c.req.path;
    // Login + status stay unauthenticated; logout requires session + CSRF
    // so a cross-site form can't log the user out.
    if (path === "/api/auth/login" || path === "/api/auth/status") return next();
    if (!authRequired) return next();
    if (bearerAuthed(c)) return next();

    const token = getCookie(c, "hat_session");
    const session = token ? verifySession(token, sessionSecret) : undefined;
    if (!session) return c.json({ error: "unauthorized" }, 401);

    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      const csrfCookie = getCookie(c, "hat_csrf");
      const csrfHeader = c.req.header("x-csrf-token");
      if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
        return c.json({ error: "invalid csrf token" }, 403);
      }
    }
    return next();
  });

  function capabilitiesFor(modelId: string): ProviderCapabilities | undefined {
    try {
      const { provider, model } = providers.resolve(modelId);
      return provider.capabilities(model);
    } catch {
      return undefined;
    }
  }

  function policyFor(session: SessionRecord): ToolPolicy {
    return {
      ...DEFAULT_TOOL_POLICY,
      mode: session.approvalMode,
      allowlist: session.allowedTools,
      maxIterations: config.maxToolIterations,
    };
  }

  /**
   * Start a turn and return it. The producer is intentionally decoupled from
   * the HTTP request: closing the connection (refresh, switching chats) only
   * unsubscribes, it does not cancel the model. Use `cancelTurn` for that.
   */
  const runTurn = (options: TurnOptions): Turn => {
    const session = store.getSession(options.sessionId);
    const turn = turns.start(options.sessionId);
    const model = session?.model ?? "fake/fake-agent";

    // Capability check: warn when the model can't do what the conversation
    // needs (e.g. vision on an image-only turn). The model is never swapped
    // out from under the user; picking a different one is their decision.
    if (session) {
      const needs = inferNeeds(options.history);
      const caps = capabilitiesFor(model);
      const unmet = caps ? unmetNeeds(caps, needs) : [];
      if (unmet.length > 0) {
        turn.push({
          type: "warning",
          message: `The selected model does not support ${unmet.join(", ")}. Choose another model.`,
        });
      }
    }

    // Title generation runs alongside the turn rather than after it, so the
    // extra round-trip is usually already paid for by the time the turn
    // finishes. Only the first user message is worth naming, and only while
    // the title is still the derived placeholder. It never gates turn.done:
    // a slow titling model must not hold the stream open.
    const titleModel = config.titleModel ?? model;
    // The subject is what the user typed; a turn with attachments carries it
    // in its parts, and the synthetic "Continue" nudge is not the user's words.
    const subject = options.userMeta?.synthetic
      ? ""
      : (options.userText ??
        (options.userParts ?? []).map((part) => (part.type === "text" ? part.text : "")).join(" ")
      ).trim();
    const titling =
      session && session.titleSource === "derived" && subject
        ? generateTitle({ providers, model: titleModel, subject, logger })
            .then((title) => {
              if (title && store.setGeneratedTitle(options.sessionId, title)) {
                turn.push({ type: "session.title", sessionId: options.sessionId, title });
              }
            })
            .catch(() => undefined)
        : undefined;

    void (async () => {
      try {
        for await (const event of agent.run({
          sessionId: options.sessionId,
          history: options.history,
          model,
          userText: options.userText,
          userParts: options.userParts,
          userMeta: options.userMeta,
          signal: turn.signal,
          toolPolicy: session ? policyFor(session) : undefined,
          reasoningEffort: session?.reasoningEffort,
          instructions: session?.instructions || undefined,
          temperature: session?.temperature ?? undefined,
          maxTokens: session?.maxTokens ?? undefined,
          emit: (event) => turn.push(event),
        })) {
          turn.push(event);
        }
      } catch (error) {
        turn.push({ type: "error", error: normalizeError(error, "turn_error") });
      } finally {
        turns.finish(turn);
      }
    })();

    return turn;
  };

  /** Stream one turn to one client. Disconnecting leaves the turn running. */
  const serveTurn = (c: Context, turn: Turn): Response =>
    streamSSE(c, async (stream) => {
      const queue = new AsyncQueue<KernelEvent>();
      let live = true;
      const unsubscribe = turn.subscribe({
        onEvent: (event) => queue.push(event),
        onEnd: () => queue.end(),
      });
      stream.onAbort(() => {
        live = false;
        unsubscribe();
        queue.end();
      });

      try {
        for await (const item of kernelStream(queue, config.sseKeepaliveMs)) {
          if (!live) break;
          try {
            if (item === KEEPALIVE) {
              await stream.write(": keepalive\n\n");
            } else {
              await stream.writeSSE({ event: "kernel", data: JSON.stringify(item) });
            }
          } catch {
            live = false;
            break;
          }
        }
      } finally {
        unsubscribe();
      }
    });

  const streamTurn = (c: Context, options: TurnOptions): Response =>
    serveTurn(c, runTurn(options));

  const pathOf = (sessionId: string) => store.getPath(sessionId);

  // ---- meta ---------------------------------------------------------------

  app.get("/", (c) => c.text("hat server\n"));

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      runners: registry.list().map((r) => r.id),
      providers: providers.list().map((p) => p.id),
    }),
  );

  app.get("/api/models", async (c) => c.json({ models: await providers.listModels() }));

  app.get("/api/runners", (c) =>
    c.json({
      runners: registry
        .list()
        .map((r) => ({ id: r.id, capabilities: r.capabilities, load: r.load })),
    }),
  );

  app.get("/api/tools", (c) => c.json({ tools: tools.list().map((t) => t.name) }));

  // ---- attachments --------------------------------------------------------

  app.post("/api/attachments", async (c) => {
    if (!uploadLimiter.allow(clientIp(c))) {
      return c.json({ error: "too many uploads; try again later" }, 429);
    }
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "expected multipart/form-data" }, 400);
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file field is required" }, 400);
    if (file.size > 25 * 1024 * 1024) return c.json({ error: "file too large (max 25MB)" }, 413);

    const buffer = Buffer.from(await file.arrayBuffer());
    const name = (file.name || "file").replace(/[\r\n]/g, " ").slice(0, 200);
    const upload = await readUpload(buffer, file.type || "", name);
    if (upload.kind === "rejected") return c.json({ error: upload.error }, upload.status);
    const record =
      upload.kind === "image"
        ? await store.putAttachment(buffer, upload.mime)
        : await store.putAttachment(buffer, upload.mime, { name, text: upload.text });
    const storeUrl = await store.attachmentUrl(record.id);
    return c.json({
      attachment: {
        ...record,
        kind: upload.kind,
        // A deduplicated upload keeps its first name; this upload's name wins here.
        ...(upload.kind === "document" ? { name } : {}),
        url: storeUrl ?? `/api/attachments/${record.id}`,
      },
    });
  });

  app.get("/api/attachments/:id", async (c) => {
    const id = c.req.param("id");
    const record = store.getAttachment(id);
    const data = await store.readAttachment(id);
    if (!record || !data) return c.json({ error: "not found" }, 404);
    // Artifacts are downloaded under the name the assistant gave them.
    const download = c.req.query("download")?.replace(/["\\\r\n]/g, "").slice(0, 200);
    return c.body(new Uint8Array(data), 200, {
      ...(download
        ? { "content-disposition": `attachment; filename="${download.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(download)}` }
        : {}),
      "content-type": record.mime,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
    });
  });

  // ---- plugins ------------------------------------------------------------

  app.get("/api/plugins", (c) => c.json({ plugins: pluginHost.list() }));

  app.post("/api/plugins/:id/enable", async (c) => {
    const id = c.req.param("id");
    const descriptor = pluginHost.get(id);
    if (!descriptor) return c.json({ error: "unknown plugin" }, 404);
    let body: { enabled?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled (boolean) is required" }, 400);
    }
    await pluginHost.setEnabled(id, body.enabled);
    return c.json({ plugin: pluginHost.get(id) });
  });

  app.put("/api/plugins/:id/config", async (c) => {
    const id = c.req.param("id");
    if (!pluginHost.get(id)) return c.json({ error: "unknown plugin" }, 404);
    let body: { config?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    await pluginHost.setConfig(id, body.config ?? {});
    return c.json({ plugin: pluginHost.get(id) });
  });

  // ---- providers + secrets (values are never returned) --------------------

  app.get("/api/providers", (c) =>
    c.json({
      providers: pluginHost
        .list()
        .filter((plugin) => plugin.requiresSecrets.length > 0)
        .map((plugin) => ({
          id: plugin.id,
          label: plugin.name,
          secretName: plugin.requiresSecrets[0],
          configured: store.hasSecret(plugin.requiresSecrets[0]),
          registered: Boolean(providers.get(plugin.id)),
          status: plugin.status,
        })),
    }),
  );

  app.get("/api/secrets", (c) => c.json({ secrets: store.listSecretNames() }));

  app.post("/api/secrets", async (c) => {
    let body: { name?: string; value?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    if (!body.name || typeof body.value !== "string" || body.value.length === 0) {
      return c.json({ error: "name and value are required" }, 400);
    }
    store.setSecret(body.name, body.value);
    await pluginHost.reload();
    return c.json({ ok: true });
  });

  app.delete("/api/secrets/:name", async (c) => {
    const removed = store.deleteSecret(c.req.param("name"));
    await pluginHost.reload();
    return c.json({ ok: removed });
  });

  // ---- sessions -----------------------------------------------------------

  /**
   * What a conversation is doing right now, for the sidebar: a turn running,
   * or a turn blocked on the user (a tool approval or an `ask_user` question).
   */
  const statusOf = (sessionId: string): "idle" | "running" | "waiting" => {
    if (approvals.isWaiting(sessionId) || questions.isWaiting(sessionId)) return "waiting";
    const turn = turns.get(sessionId);
    return turn && !turn.done ? "running" : "idle";
  };

  app.get("/api/sessions", (c) => {
    const usage = store.usageBySession();
    return c.json({
      sessions: store.listSessions().map((s) => ({
        id: s.id,
        title: s.title,
        model: s.model,
        messageCount: store.countVisibleMessages(s.id),
        usage: usage.get(s.id) ?? null,
        status: statusOf(s.id),
        updatedAt: s.updatedAt,
      })),
    });
  });

  /** Recreate a conversation from a `GET /export` JSON file. */
  app.post("/api/sessions/import", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected a JSON export" }, 400);
    }
    if (!isSessionExport(body)) {
      return c.json({ error: "not a hat conversation export (format hat.session, version 1)" }, 400);
    }
    // Attachments travel inline; re-store them and point the parts at the new ids.
    const remap = new Map<string, string>();
    for (const [oldId, attachment] of Object.entries(body.attachments ?? {})) {
      try {
        const record = await store.putAttachment(
          Buffer.from(attachment.data, "base64"),
          attachment.mime,
          attachment.text !== undefined ? { name: attachment.name, text: attachment.text } : undefined,
        );
        remap.set(oldId, record.id);
      } catch (error) {
        logger.warn("import: attachment skipped", normalizeError(error, "import_attachment"));
      }
    }
    const session = store.importSession(body, (part) => {
      if (part.type === "image" && part.source.kind === "attachment") {
        const id = remap.get(part.source.id);
        return id ? { ...part, source: { ...part.source, id } } : { type: "text", text: "[image not included in the import]" };
      }
      if (part.type === "file") {
        const id = remap.get(part.id);
        return id ? { ...part, id } : part;
      }
      if (part.type === "tool_result") {
        return {
          ...part,
          content: part.content.map((inner) =>
            inner.type === "file" && remap.has(inner.id) ? { ...inner, id: remap.get(inner.id)! } : inner,
          ),
        };
      }
      return part;
    });
    return c.json({ session, path: pathOf(session.id) });
  });

  app.post("/api/sessions", async (c) => {
    let body: { model?: string; title?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    const session = store.createSession(body.model ?? "fake/fake-agent", body.title);
    return c.json({ session, path: pathOf(session.id) });
  });

  app.get("/api/sessions/:id", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    return c.json({ session, path: pathOf(session.id) });
  });

  app.patch("/api/sessions/:id", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    let body: {
      model?: string;
      title?: string;
      approvalMode?: "ask" | "auto" | "allowlist" | "deny";
      allowedTools?: string[];
      reasoningEffort?: unknown;
      instructions?: unknown;
      temperature?: unknown;
      maxTokens?: unknown;
    } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    const settings = parseSessionSettings(body);
    if ("error" in settings) return c.json({ error: settings.error }, 400);
    store.setSessionSettings(session.id, settings);
    if (body.model) store.setSessionModel(session.id, body.model);
    if (typeof body.title === "string" && body.title.trim()) {
      store.setSessionTitle(session.id, body.title.trim().slice(0, 200));
    }
    if (isReasoningEffort(body.reasoningEffort)) {
      store.setSessionReasoningEffort(session.id, body.reasoningEffort);
    }
    store.setSessionPolicy(session.id, {
      approvalMode: body.approvalMode,
      allowedTools: body.allowedTools,
    });
    return c.json({ session: store.getSession(session.id) });
  });

  app.delete("/api/sessions/:id", (c) => {
    const removed = store.deleteSession(c.req.param("id"));
    return c.json({ ok: removed });
  });

  /** Start a new conversation from this one's path up to `messageId`. */
  app.post("/api/sessions/:id/fork", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    let body: { messageId?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    const messageId = typeof body.messageId === "string" ? body.messageId : session.activeLeafId;
    if (!messageId) return c.json({ error: "nothing to fork yet" }, 400);
    const fork = store.forkSession(session.id, messageId);
    if (!fork) return c.json({ error: "messageId must reference a message in this conversation" }, 400);
    return c.json({ session: fork, path: pathOf(fork.id) });
  });

  /**
   * Download a conversation. `format=markdown` is the active branch as a
   * readable transcript; the default JSON is the whole tree with attachments
   * inline, suitable for `POST /api/sessions/import`.
   */
  app.get("/api/sessions/:id/export", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    const format = c.req.query("format") === "markdown" ? "markdown" : "json";
    const base = (session.title || "conversation").replace(/[^\p{L}\p{N} _.-]+/gu, "").trim().slice(0, 80) || "conversation";
    const filename = `${base}.${format === "markdown" ? "md" : "json"}`;
    const disposition = `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    if (format === "markdown") {
      return c.body(exportMarkdown(session, pathOf(session.id).map((n) => n.message)), 200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": disposition,
      });
    }
    const data = store.exportSession(session.id)!;
    const attachments: Record<string, { mime: string; name?: string; text?: string; data: string }> = {};
    const collect = async (id: string): Promise<void> => {
      if (attachments[id]) return;
      const record = store.getAttachment(id);
      const bytes = await store.readAttachment(id);
      if (!record || !bytes) return;
      const text = store.getAttachmentText(id);
      attachments[id] = {
        mime: record.mime,
        ...(record.name ? { name: record.name } : {}),
        ...(text !== undefined ? { text } : {}),
        data: bytes.toString("base64"),
      };
    };
    for (const message of data.messages) {
      for (const part of message.parts) {
        if (part.type === "image" && part.source.kind === "attachment") await collect(part.source.id);
        else if (part.type === "file") await collect(part.id);
        else if (part.type === "tool_result") {
          for (const inner of part.content) if (inner.type === "file") await collect(inner.id);
        }
      }
    }
    return c.body(JSON.stringify({ ...data, attachments }), 200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": disposition,
    });
  });

  // ---- turns + branching --------------------------------------------------

  app.post("/api/sessions/:id/turn", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    if (!turnLimiter.allow(`${clientIp(c)}:${session.id}`)) {
      return c.json({ error: "too many turns; slow down" }, 429);
    }
    let body: { text?: string; model?: string; attachmentIds?: unknown; attachmentNames?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    const text = (body.text ?? "").toString();
    const attachmentIds = Array.isArray(body.attachmentIds)
      ? body.attachmentIds.filter((id): id is string => typeof id === "string")
      : [];

    if (!text.trim() && attachmentIds.length === 0) {
      return c.json({ error: "text or attachments are required" }, 400);
    }
    if (body.model) store.setSessionModel(session.id, body.model);

    let userParts: Part[] | undefined;
    if (attachmentIds.length > 0) {
      userParts = [];
      if (text.trim()) userParts.push({ type: "text", text });
      const names =
        body.attachmentNames && typeof body.attachmentNames === "object"
          ? (body.attachmentNames as Record<string, unknown>)
          : {};
      for (const id of attachmentIds) {
        const record = store.getAttachment(id);
        if (!record) continue;
        if (IMAGE_MIME.has(record.mime)) {
          userParts.push({ type: "image", source: { kind: "attachment", id, mime: record.mime } });
        } else if (record.hasText) {
          const name = typeof names[id] === "string" ? String(names[id]).slice(0, 200) : record.name ?? "file";
          userParts.push({ type: "file", id, name, mime: record.mime, size: record.size });
        }
      }
    }

    return streamTurn(c, {
      sessionId: session.id,
      history: pathOf(session.id).map((n) => n.message),
      userText: userParts ? undefined : text,
      userParts,
    });
  });

  /**
   * Continue a reply that was cut off at the output limit. The nudge is a real
   * (synthetic) user message so the history keeps alternating, which every
   * provider accepts; clients hide it and read the next reply as the rest.
   */
  app.post("/api/sessions/:id/continue", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    const history = pathOf(session.id).map((n) => n.message);
    const last = history.at(-1);
    if (!last || last.role !== "assistant") {
      return c.json({ error: "there is no reply to continue" }, 400);
    }
    return streamTurn(c, {
      sessionId: session.id,
      history,
      userText: CONTINUE_PROMPT,
      userMeta: { synthetic: "continue" },
    });
  });

  /** Re-run the model for an assistant message, creating a sibling branch. */
  app.post("/api/sessions/:id/regenerate", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    let body: { messageId?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    if (!body.messageId) return c.json({ error: "messageId is required" }, 400);
    const target = store.hasMessage(session.id, body.messageId) ? store.getMessage(body.messageId) : undefined;
    if (!target || target.role !== "assistant") {
      return c.json({ error: "messageId must reference an assistant message" }, 400);
    }
    const parent = store.getParentId(target.id);
    store.setActiveLeaf(session.id, parent);
    return streamTurn(c, {
      sessionId: session.id,
      history: pathOf(session.id).map((n) => n.message),
    });
  });

  /** Edit a user message and re-run, creating a sibling branch. */
  app.post("/api/sessions/:id/edit", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    let body: { messageId?: string; text?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    if (!body.messageId || !body.text?.trim()) {
      return c.json({ error: "messageId and text are required" }, 400);
    }
    const target = store.hasMessage(session.id, body.messageId) ? store.getMessage(body.messageId) : undefined;
    if (!target || target.role !== "user") {
      return c.json({ error: "messageId must reference a user message" }, 400);
    }
    store.setActiveLeaf(session.id, store.getParentId(target.id));
    return streamTurn(c, {
      sessionId: session.id,
      history: pathOf(session.id).map((n) => n.message),
      userText: body.text,
    });
  });

  /**
   * Follow the turn already running for a session, replaying its pending tail.
   * 204 when nothing is running, so the client can call it unconditionally on
   * opening or restoring a conversation.
   */
  app.get("/api/sessions/:id/stream", (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    const turn = turns.get(session.id);
    if (!turn || turn.done) return c.body(null, 204);
    return serveTurn(c, turn);
  });

  /** Explicitly cancel the running turn (the Stop button). */
  app.post("/api/sessions/:id/turn/cancel", (c) => {
    const turn = turns.get(c.req.param("id"));
    turn?.abort.abort();
    return c.json({ ok: Boolean(turn) });
  });

  /** Switch which sibling branch is active. */
  app.post("/api/sessions/:id/select", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    let body: { messageId?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    if (!body.messageId || !store.hasMessage(session.id, body.messageId)) {
      return c.json({ error: "valid messageId is required" }, 400);
    }
    store.selectBranch(session.id, body.messageId);
    return c.json({ session: store.getSession(session.id), path: pathOf(session.id) });
  });

  // ---- questions (ask_user) ----------------------------------------------

  app.post("/api/questions/:callId", async (c) => {
    let body: { answer?: unknown; sessionId?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    if (typeof body.answer !== "string" || !body.answer.trim() || typeof body.sessionId !== "string") {
      return c.json({ error: "sessionId and a non-empty answer are required" }, 400);
    }
    const ok = questions.answer(c.req.param("callId"), body.sessionId, body.answer.trim().slice(0, 4_000));
    return c.json({ ok }, ok ? 200 : 404);
  });

  // ---- memories -----------------------------------------------------------

  app.get("/api/memories", (c) => c.json({ memories: store.listMemories() }));

  app.post("/api/memories", async (c) => {
    let body: { text?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    if (typeof body.text !== "string" || !body.text.trim()) return c.json({ error: "text is required" }, 400);
    return c.json({ memory: store.addMemory(body.text.trim().slice(0, 500)) });
  });

  app.patch("/api/memories/:id", async (c) => {
    let body: { text?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    if (typeof body.text !== "string" || !body.text.trim()) return c.json({ error: "text is required" }, 400);
    const ok = store.updateMemory(c.req.param("id"), body.text.trim().slice(0, 500));
    return c.json({ ok }, ok ? 200 : 404);
  });

  app.delete("/api/memories/:id", (c) => c.json({ ok: store.deleteMemory(c.req.param("id")) }));

  // ---- chat search --------------------------------------------------------

  app.get("/api/search", (c) => {
    const query = c.req.query("q") ?? "";
    return c.json({ hits: store.searchMessages(query, { limit: 30 }) });
  });

  // ---- schedules ----------------------------------------------------------

  app.get("/api/schedules", (c) => c.json({ schedules: store.listSchedules() }));

  app.patch("/api/schedules/:id", async (c) => {
    const schedule = store.getSchedule(c.req.param("id"));
    if (!schedule) return c.json({ error: "not found" }, 404);
    let body: { enabled?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled (boolean) is required" }, 400);
    let next: number | null = null;
    if (body.enabled) {
      try {
        next = nextRunFor(schedule, Date.now());
      } catch {
        next = null;
      }
      if (next === null) return c.json({ error: "this schedule has no future run" }, 400);
    }
    store.setScheduleEnabled(schedule.id, body.enabled, next);
    return c.json({ schedule: store.getSchedule(schedule.id) });
  });

  app.post("/api/schedules/:id/run", (c) => {
    const schedule = store.getSchedule(c.req.param("id"));
    if (!schedule) return c.json({ error: "not found" }, 404);
    void scheduler.runNow(schedule.id).catch(() => undefined);
    return c.json({ ok: true });
  });

  app.delete("/api/schedules/:id", (c) => c.json({ ok: store.deleteSchedule(c.req.param("id")) }));

  // ---- approvals ----------------------------------------------------------

  app.post("/api/approvals/:callId", async (c) => {
    let body: { decision?: ApprovalDecision; sessionId?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    const decision = body.decision;
    if (decision !== "approve" && decision !== "deny" && decision !== "approve_always") {
      return c.json({ error: "invalid decision" }, 400);
    }
    const ok = approvals.resolve(c.req.param("callId"), decision, body.sessionId);
    return c.json({ ok });
  });

  scheduler.start();

  return {
    app,
    registry,
    store,
    close: () => {
      scheduler.stop();
      registry.close();
      store.close();
    },
  };
}

/**
 * Validate the model settings a PATCH may carry. Absent fields are left alone;
 * `null` (or an empty string for instructions) resets to the default.
 */
function parseSessionSettings(body: {
  instructions?: unknown;
  temperature?: unknown;
  maxTokens?: unknown;
}):
  | { instructions?: string; temperature?: number | null; maxTokens?: number | null }
  | { error: string } {
  const out: { instructions?: string; temperature?: number | null; maxTokens?: number | null } = {};
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "string") return { error: "instructions must be a string" };
    if (body.instructions.length > 20_000) return { error: "instructions are limited to 20,000 characters" };
    out.instructions = body.instructions.trim();
  }
  if (body.temperature !== undefined) {
    if (body.temperature === null) out.temperature = null;
    else if (typeof body.temperature === "number" && body.temperature >= 0 && body.temperature <= 2) {
      out.temperature = body.temperature;
    } else return { error: "temperature must be a number from 0 to 2, or null" };
  }
  if (body.maxTokens !== undefined) {
    if (body.maxTokens === null) out.maxTokens = null;
    else if (Number.isInteger(body.maxTokens) && (body.maxTokens as number) >= 1 && (body.maxTokens as number) <= 1_000_000) {
      out.maxTokens = body.maxTokens as number;
    } else return { error: "maxTokens must be a positive integer, or null" };
  }
  return out;
}
