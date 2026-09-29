import {
  PROTOCOL_VERSION,
  encodeLinkMessage,
  parseServerToRunner,
  type RunnerToServer,
  type ServerToRunner,
} from "@hat/runner-protocol";
import WebSocket from "ws";
import { detectCapabilities } from "./capabilities.js";
import { loadConfig, type RunnerConfig } from "./config.js";
import { startJob, type JobHandle } from "./exec.js";
import { startProcess, type ProcessHandle } from "./processes.js";
import { WorkspaceManager } from "./workspace.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env file present */
}

const log = (msg: string, meta?: unknown): void => {
  const suffix = meta === undefined ? "" : ` ${JSON.stringify(meta)}`;
  console.log(`[runner] ${msg}${suffix}`);
};

interface PendingRequest {
  resolve: (message: RunnerToServer) => void;
  reject: (error: unknown) => void;
}

class Runner {
  private ws?: WebSocket;
  private readonly workspace: WorkspaceManager;
  private readonly jobs = new Map<string, JobHandle>();
  private readonly processes = new Map<string, ProcessHandle>();
  private readonly pending = new Map<string, PendingRequest>();
  private stopped = false;
  private readonly startedAt = Date.now();

  constructor(private readonly config: RunnerConfig) {
    this.workspace = new WorkspaceManager(config.workspaceRoot, config.maxOutputBytes);
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.killManaged();
    this.ws?.close();
  }

  /**
   * Reap everything the server owns. When the link drops, the server can no
   * longer send `exec.cancel`/`proc.cancel` and will re-issue work on reconnect,
   * so jobs and long-lived processes (stdio MCP servers) must die with the link
   * instead of piling up across reconnects.
   */
  private killManaged(): void {
    for (const job of this.jobs.values()) job.abort();
    this.jobs.clear();
    for (const proc of this.processes.values()) proc.kill();
    this.processes.clear();
  }

  private connect(): void {
    if (this.stopped) return;
    log(`connecting to ${this.config.serverUrl}`);
    const ws = new WebSocket(this.config.serverUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.send({
        t: "hello",
        v: PROTOCOL_VERSION,
        runnerId: this.config.runnerId,
        enrollToken: this.config.enrollToken,
        credential: this.config.credential,
        caps: detectCapabilities(this.config.tags),
      });
    });

    ws.on("message", (data) => {
      try {
        this.onMessage(parseServerToRunner(data.toString()));
      } catch (error) {
        log("failed to parse server message", String(error));
      }
    });

    ws.on("close", () => {
      log("link closed; reconnecting in 1s");
      this.ws = undefined;
      this.failAllPending("link closed");
      this.killManaged();
      if (!this.stopped) setTimeout(() => this.connect(), 1000);
    });

    ws.on("error", (error) => {
      log("link error", String(error));
    });
  }

  private send(message: RunnerToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeLinkMessage(message));
    }
  }

  private onMessage(message: ServerToRunner): void {
    switch (message.t) {
      case "hello.ok":
        if (message.credential) this.config.credential = message.credential;
        log(`enrolled as ${message.runnerId}`);
        break;
      case "workspace.ensure":
        void this.handleEnsure(message.reqId, message.sessionId);
        break;
      case "exec.start":
        void this.handleExec(message);
        break;
      case "exec.stdin":
        this.jobs.get(message.jobId)?.write(message.chunk);
        break;
      case "exec.cancel":
        this.jobs.get(message.jobId)?.abort();
        break;
      case "proc.start":
        this.handleProcStart(message);
        break;
      case "proc.stdin":
        this.processes.get(message.procId)?.write(message.chunk);
        break;
      case "proc.stdin.end":
        this.processes.get(message.procId)?.endStdin();
        break;
      case "proc.cancel":
        this.processes.get(message.procId)?.kill();
        break;
      case "fs.read":
        void this.handle(async () => ({
          t: "fs.read.result",
          reqId: message.reqId,
          data: await this.workspace.read(message.sessionId, message.path),
        }), message.reqId);
        break;
      case "fs.write":
        void this.handle(async () => {
          await this.workspace.write(message.sessionId, message.path, message.data);
          return { t: "fs.write.result", reqId: message.reqId };
        }, message.reqId);
        break;
      case "fs.list":
        void this.handle(async () => ({
          t: "fs.list.result",
          reqId: message.reqId,
          entries: await this.workspace.list(message.sessionId, message.path),
        }), message.reqId);
        break;
      case "net.fetch":
        void this.handle(async () => ({
          t: "net.fetch.result",
          reqId: message.reqId,
          response: await runFetch(message.url, message.method, message.headers, message.body),
        }), message.reqId);
        break;
    }
  }

  private async handleEnsure(reqId: string, sessionId: string): Promise<void> {
    await this.handle(async () => {
      const root = await this.workspace.ensure(sessionId);
      return { t: "workspace.ok", reqId, sessionId, root };
    }, reqId);
  }

  private async handleExec(message: Extract<ServerToRunner, { t: "exec.start" }>): Promise<void> {
    let cwd: string;
    try {
      cwd = await this.workspace.resolveCwd(message.sessionId, message.cwd);
    } catch (error) {
      this.sendError({ jobId: message.jobId }, error);
      return;
    }

    const timeoutMs = Math.min(
      message.timeoutMs ?? this.config.defaultTimeoutMs,
      this.config.maxTimeoutMs,
    );

    const handle = startJob(
      {
        jobId: message.jobId,
        command: message.command,
        cwd,
        env: message.env,
        timeoutMs,
        stdin: message.stdin,
        maxOutputBytes: this.config.maxOutputBytes,
      },
      this.config.sandbox,
      (out) => this.send(out),
      (jobId) => this.jobs.delete(jobId),
    );
    this.jobs.set(message.jobId, handle);
  }

  private handleProcStart(message: Extract<ServerToRunner, { t: "proc.start" }>): void {
    let cwd: string;
    const scope = message.sessionId ?? "_processes";
    try {
      cwd = message.cwd
        ? this.workspace.resolveCwdSync(scope, message.cwd)
        : this.workspace.ensureSync(scope);
    } catch (error) {
      this.sendError({ procId: message.procId }, error);
      return;
    }

    const handle = startProcess(
      {
        procId: message.procId,
        command: message.command,
        args: message.args,
        cwd,
        env: message.env,
        shell: message.shell ? this.config.sandbox : undefined,
      },
      (out) => this.send(out),
      (procId) => this.processes.delete(procId),
    );
    // Register synchronously so the immediately-following proc.stdin isn't lost.
    this.processes.set(message.procId, handle);
  }

  private async handle(
    work: () => Promise<RunnerToServer>,
    reqId: string,
  ): Promise<void> {
    try {
      this.send(await work());
    } catch (error) {
      this.sendError({ reqId }, error);
    }
  }

  private sendError(
    target: { reqId?: string; jobId?: string; procId?: string },
    error: unknown,
  ): void {
    this.send({
      t: "job.error",
      ...target,
      error: {
        code: "runner_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pending) pending.reject(new Error(reason));
    this.pending.clear();
    this.jobs.clear();
  }
}

async function runFetch(
  url: string,
  method: string | undefined,
  headers: Record<string, string> | undefined,
  body: string | undefined,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`fetch blocked: invalid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`fetch blocked: only http(s) allowed`);
  }
  const host = parsed.hostname.toLowerCase();
  // Basic SSRF guard: block metadata + loopback + private literals.
  // (DNS-rebinding needs a resolving guard; this stops the cheap escapes.)
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal") ||
    host === "169.254.169.254" ||
    host === "213.0.0.0" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    throw new Error(`fetch blocked: private/metadata host (${host})`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: method ?? "GET",
      headers,
      body,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await response.text();
    // 2MB cap to avoid blowing the link / memory on huge pages.
    const capped = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    return { status: response.status, headers: responseHeaders, body: capped };
  } finally {
    clearTimeout(timer);
  }
}

const runner = new Runner(loadConfig());
runner.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`received ${signal}, shutting down`);
    runner.stop();
    process.exit(0);
  });
}
