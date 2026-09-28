import { spawn } from "node:child_process";
import type { RunnerToServer } from "@hat/runner-protocol";

export interface ProcessSpec {
  procId: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface ProcessHandle {
  write(chunk: string): void;
  endStdin(): void;
  kill(): void;
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

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: spec.cwd,
    ...spec.env,
  };

  const child = spawn(spec.command, spec.args ?? [], {
    cwd: spec.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  const kill = (): void => {
    killed = true;
    if (!child.pid) return;
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
