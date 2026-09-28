import type {
  ApprovalDecision,
  ChatMessage,
  ExecutionHost,
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
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { ApprovalManager } from "./approvals.js";
import type { ServerConfig } from "./config.js";
import { createFakePlugin } from "./fake-provider.js";
import { RunnerRegistry } from "./link.js";
import { createAuditLog, createLogger } from "./logger.js";
import { loadExternalPlugins } from "./plugin-loader.js";

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
}

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
  const registry = new RunnerRegistry(logger, config.enrollToken);

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
  pluginHost.register(createFakePlugin());
  pluginHost.register(createMcpPlugin());

  for (const plugin of await loadExternalPlugins(config.pluginsDir, logger)) {
    pluginHost.register(plugin, "external");
  }

  await pluginHost.activateAll();
  for (const descriptor of pluginHost.list()) {
    if (descriptor.status !== "active") {
      logger.info(`plugin ${descriptor.id}: ${descriptor.status}${descriptor.error ? ` (${descriptor.error})` : ""}`);
    }
  }

  const activeTurns = new Map<string, (event: KernelEvent) => void>();
  const approvals = new ApprovalManager((sessionId, event) => {
    activeTurns.get(sessionId)?.(event);
  });

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
    maxToolIterations: config.maxToolIterations,
    onMessage: (sessionId, message) => store.appendMessage(sessionId, message),
    resolveImage: async (attachmentId) => {
      const record = store.getAttachment(attachmentId);
      const data = await store.readAttachment(attachmentId);
      if (!record || !data) return undefined;
      return { data: data.toString("base64"), mime: record.mime };
    },
  });

  const app = new Hono();

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

  const bearerAuthed = (c: Context): boolean => {
    const header = c.req.header("authorization");
    return Boolean(config.authToken && header === `Bearer ${config.authToken}`);
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
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
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
    if (path.startsWith("/api/auth/")) return next();
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

  const streamTurn = (c: Context, options: TurnOptions): Response =>
    streamSSE(c, async (stream) => {
      const session = store.getSession(options.sessionId);
      const queue = new AsyncQueue<KernelEvent>();
      const controller = new AbortController();
      activeTurns.set(options.sessionId, (event) => queue.push(event));
      stream.onAbort(() => {
        controller.abort();
        activeTurns.delete(options.sessionId);
      });

      // Capability check: warn when the model can't do what the conversation
      // needs (e.g. vision on an image-only turn). The model is never swapped
      // out from under the user; picking a different one is their decision.
      const model = session?.model ?? "fake/fake-agent";
      if (session) {
        const needs = inferNeeds(options.history);
        const caps = capabilitiesFor(model);
        const unmet = caps ? unmetNeeds(caps, needs) : [];
        if (unmet.length > 0) {
          queue.push({
            type: "warning",
            message: `The selected model does not support ${unmet.join(", ")}. Choose another model.`,
          });
        }
      }

      const producer = (async () => {
        try {
          for await (const event of agent.run({
            sessionId: options.sessionId,
            history: options.history,
            model,
            userText: options.userText,
            userParts: options.userParts,
            signal: controller.signal,
            toolPolicy: session ? policyFor(session) : undefined,
            reasoningEffort: session?.reasoningEffort,
          })) {
            queue.push(event);
          }
        } catch (error) {
          queue.push({ type: "error", error: normalizeError(error, "turn_error") });
        } finally {
          activeTurns.delete(options.sessionId);
          queue.end();
        }
      })();

      const keepalive = setInterval(() => {
        void stream.write(": keepalive\n\n");
      }, 2000);
      try {
        for await (const event of queue) {
          await stream.writeSSE({ event: "kernel", data: JSON.stringify(event) });
        }
      } finally {
        clearInterval(keepalive);
        await producer;
      }
    });

  const pathOf = (sessionId: string) => store.getPath(sessionId);

  // ---- meta ---------------------------------------------------------------

  app.get("/", (c) => c.text("hat server — M2\n"));

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
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "expected multipart/form-data" }, 400);
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file field is required" }, 400);
    if (file.size > 25 * 1024 * 1024) return c.json({ error: "file too large (max 25MB)" }, 413);

    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = file.type || "application/octet-stream";
    const record = await store.putAttachment(buffer, mime);
    const storeUrl = await store.attachmentUrl(record.id);
    return c.json({
      attachment: { ...record, url: storeUrl ?? `/api/attachments/${record.id}` },
    });
  });

  app.get("/api/attachments/:id", async (c) => {
    const id = c.req.param("id");
    const record = store.getAttachment(id);
    const data = await store.readAttachment(id);
    if (!record || !data) return c.json({ error: "not found" }, 404);
    return c.body(new Uint8Array(data), 200, {
      "content-type": record.mime,
      "cache-control": "public, max-age=31536000, immutable",
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

  app.get("/api/sessions", (c) =>
    c.json({
      sessions: store.listSessions().map((s) => ({
        id: s.id,
        title: s.title,
        model: s.model,
        messageCount: store.countMessages(s.id),
        updatedAt: s.updatedAt,
      })),
    }),
  );

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
    } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
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

  // ---- turns + branching --------------------------------------------------

  app.post("/api/sessions/:id/turn", async (c) => {
    const session = store.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    let body: { text?: string; model?: string; attachmentIds?: unknown } = {};
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
      for (const id of attachmentIds) {
        const record = store.getAttachment(id);
        if (record && record.mime.startsWith("image/")) {
          userParts.push({ type: "image", source: { kind: "attachment", id, mime: record.mime } });
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
    const target = store.getMessage(body.messageId);
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
    const target = store.getMessage(body.messageId);
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
    if (!body.messageId || !store.getMessage(body.messageId)) {
      return c.json({ error: "valid messageId is required" }, 400);
    }
    store.selectBranch(session.id, body.messageId);
    return c.json({ session: store.getSession(session.id), path: pathOf(session.id) });
  });

  // ---- approvals ----------------------------------------------------------

  app.post("/api/approvals/:callId", async (c) => {
    let body: { decision?: ApprovalDecision } = {};
    try {
      body = await c.req.json();
    } catch {
      /* ignore */
    }
    const decision = body.decision;
    if (decision !== "approve" && decision !== "deny" && decision !== "approve_always") {
      return c.json({ error: "invalid decision" }, 400);
    }
    const ok = approvals.resolve(c.req.param("callId"), decision);
    return c.json({ ok });
  });

  return {
    app,
    registry,
    store,
    close: () => {
      registry.close();
      store.close();
    },
  };
}
