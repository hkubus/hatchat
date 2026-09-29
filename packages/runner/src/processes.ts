import { spawn } from "node:child_process";
import type { RunnerToServer } from "@hat/runner-protocol";
import { removeContainer, spawnPlan, type SandboxConfig, type SpawnPlan } from "./sandbox.js";

export interface ProcessSpec {
  procId: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  /** When set, `command` is a shell line, spawned through the sandbox plan. */
  shell?: SandboxConfig;
}

export interface ProcessHandle {
  write(chunk: string): void;
  endStdin(): void;
  /** Resolves once any container cleanup has finished (or given up). */
  kill(): Promise<void>;
}

/**
 * Start a long-lived process with an open stdin (for stdio MCP servers) and
 * stream its output to the server.
 */
export function startProcess(
  spec: ProcessSpec,
  send: (message: RunnerToServer) => void,
  onDone: (procId: string) => void,
): ProcessHandle {
  const startedAt = Date.now();
  let finished = false;
  let killed = false;

  const plan: SpawnPlan = spec.shell
    ? spawnPlan(spec.command, spec.cwd, spec.shell, { env: spec.env, id: spec.procId })
    : {
        bin: spec.command,
        args: spec.args ?? [],
        shell: false,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: spec.cwd,
          ...spec.env,
        },
      };
  const child = spawn(plan.bin, plan.args, {
    cwd: spec.cwd,
    env: plan.env,
    shell: plan.shell,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let removal: Promise<void> | undefined;
  /** Kill the process tree, then force-remove its container (if any). */
  const kill = (): Promise<void> => {
    killed = true;
    if (finished || !child.pid) return removal ?? Promise.resolve();
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
    removal ??= removeContainer(plan.cleanup);
    return removal;
  };

  child.stdout.on("data", (data: Buffer) => {
    if (!finished) send({ t: "proc.stdout", procId: spec.procId, chunk: data.toString() });
  });
  child.stderr.on("data", (data: Buffer) => {
    if (!finished) send({ t: "proc.stderr", procId: spec.procId, chunk: data.toString() });
  });

  child.on("error", (error) => {
    if (finished) return;
    finished = true;
    send({
      t: "job.error",
      procId: spec.procId,
      error: { code: "spawn_error", message: error.message },
    });
    onDone(spec.procId);
  });

  child.on("close", (code, signal) => {
    if (finished) return;
    finished = true;
    send({
      t: "proc.exit",
      procId: spec.procId,
      code: code ?? null,
      signal: signal ?? (killed ? "killed" : null),
      durationMs: Date.now() - startedAt,
    });
    onDone(spec.procId);
  });

  return {
    write(chunk: string): void {
      if (!finished && child.stdin.writable) child.stdin.write(chunk);
    },
    endStdin(): void {
      if (!finished && child.stdin.writable) child.stdin.end();
    },
    kill,
  };
}
