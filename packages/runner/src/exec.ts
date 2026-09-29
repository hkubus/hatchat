import { spawn } from "node:child_process";
import type { RunnerToServer } from "@hat/runner-protocol";
import { removeContainer, spawnPlan, type SandboxConfig } from "./sandbox.js";

export interface RunSpec {
  jobId: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  stdin?: string;
  maxOutputBytes: number;
}

export interface JobHandle {
  /** Resolves once any container cleanup has finished (or given up). */
  abort(): Promise<void>;
  write(chunk: string): void;
}

/**
 * Start a detached shell job. Output is streamed to the server; the process
 * tree (and container) is killed on timeout, cancel, or output-cap breach.
 */
export function startJob(
  spec: RunSpec,
  sandbox: SandboxConfig,
  send: (message: RunnerToServer) => void,
  onDone: (jobId: string) => void,
): JobHandle {
  const startedAt = Date.now();
  let outputBytes = 0;
  let finished = false;
  let timedOut = false;

  // The plan filters caller env: the model never overrides loader / runtime knobs.
  const plan = spawnPlan(spec.command, spec.cwd, sandbox, { env: spec.env, id: spec.jobId });
  const child = spawn(plan.bin, plan.args, {
    shell: plan.shell,
    cwd: spec.cwd,
    env: plan.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let removal: Promise<void> | undefined;
  /**
   * Kill the process tree, then force-remove the job's container (if any):
   * killing the runtime CLI alone leaves the container running.
   */
  const kill = (): Promise<void> => {
    if (finished || !child.pid) return removal ?? Promise.resolve();
    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    removal ??= removeContainer(plan.cleanup);
    return removal;
  };

  const timer = setTimeout(() => {
    timedOut = true;
    send({
      t: "exec.stderr",
      jobId: spec.jobId,
      chunk: `\n[timeout after ${spec.timeoutMs}ms; killing process]\n`,
    });
    void kill();
  }, spec.timeoutMs);

  const emit = (chunk: string, stream: "stdout" | "stderr"): void => {
    if (finished) return;
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > spec.maxOutputBytes) {
      send({
        t: "exec.stderr",
        jobId: spec.jobId,
        chunk: `\n[output limit ${spec.maxOutputBytes} bytes reached; killing process]\n`,
      });
      void kill();
      return;
    }
    if (stream === "stdout") {
      send({ t: "exec.stdout", jobId: spec.jobId, chunk });
    } else {
      send({ t: "exec.stderr", jobId: spec.jobId, chunk });
    }
  };

  child.stdout.on("data", (data: Buffer) => emit(data.toString(), "stdout"));
  child.stderr.on("data", (data: Buffer) => emit(data.toString(), "stderr"));

  child.on("error", (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    send({
      t: "job.error",
      jobId: spec.jobId,
      error: { code: "spawn_error", message: error.message },
    });
    onDone(spec.jobId);
  });

  child.on("close", (code, signal) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    send({
      t: "exec.exit",
      jobId: spec.jobId,
      code: code ?? null,
      signal: signal ?? (timedOut ? "timeout" : null),
      durationMs: Date.now() - startedAt,
    });
    onDone(spec.jobId);
  });

  if (spec.stdin != null) {
    child.stdin.write(spec.stdin);
  }
  child.stdin.end();

  return {
    abort(): Promise<void> {
      send({
        t: "exec.stderr",
        jobId: spec.jobId,
        chunk: "\n[cancelled]\n",
      });
      return kill();
    },
    write(chunk: string): void {
      if (!finished && child.stdin.writable) {
        child.stdin.write(chunk);
      }
    },
  };
}
