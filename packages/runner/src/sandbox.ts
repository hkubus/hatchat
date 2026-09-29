import { execFile } from "node:child_process";
import path from "node:path";

export type SandboxMode = "auto" | "host" | "container";

/** Sandbox settings as configured; `auto` and an unset runtime are resolved at startup. */
export interface SandboxSettings {
  mode: SandboxMode;
  /** Explicit runtime binary; when unset, docker then podman are probed. */
  runtime?: string;
  image: string;
  network: string;
  memory: string;
  cpus: string;
}

/** The effective sandbox jobs are spawned with. */
export interface SandboxConfig {
  mode: "host" | "container";
  runtime: string;
  image: string;
  network: string;
  memory: string;
  cpus: string;
}

export type ProbeResult = { ok: true; version: string } | { ok: false; reason: string };

/** Checks that a runtime binary exists and can reach its engine. */
export type RuntimeProbe = (runtime: string) => Promise<ProbeResult>;

export const DEFAULT_RUNTIMES = ["docker", "podman"];

export function parseSandboxMode(raw: string): SandboxMode {
  const mode = raw.trim().toLowerCase();
  if (mode === "auto" || mode === "host" || mode === "container") return mode;
  throw new Error(`HAT_EXEC_SANDBOX must be auto, host or container (got "${raw}")`);
}

/**
 * Ask the runtime for its engine version. `docker version` exits non-zero when
 * the daemon is unreachable; local podman has no server section there, so it
 * is asked via `info` instead.
 */
export const probeRuntime: RuntimeProbe = (runtime) => {
  const args = path.basename(runtime).startsWith("podman")
    ? ["info", "--format", "{{.Version.Version}}"]
    : ["version", "--format", "{{.Server.Version}}"];
  return new Promise((resolve) => {
    execFile(runtime, args, { timeout: 5_000 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, version: stdout.trim() || "unknown" });
        return;
      }
      const reason =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "not installed"
          : error.killed
            ? "timed out"
            : stderr.trim().split("\n")[0] || error.message;
      resolve({ ok: false, reason });
    });
  });
};

export interface ResolvedSandbox {
  sandbox: SandboxConfig;
  /** Why this tier was chosen, for the startup log. */
  reason: string;
}

/**
 * Pick the effective tier. `auto` uses the first runtime that answers the
 * probe and otherwise falls back to `host`. An explicit `container` with no
 * working runtime throws, so the runner refuses to start rather than failing
 * every job later.
 */
export async function resolveSandbox(
  settings: SandboxSettings,
  probe: RuntimeProbe = probeRuntime,
): Promise<ResolvedSandbox> {
  const { mode, runtime, ...rest } = settings;
  const candidates = runtime ? [runtime] : DEFAULT_RUNTIMES;
  if (mode === "host") {
    return {
      sandbox: { ...rest, mode: "host", runtime: candidates[0]! },
      reason: "HAT_EXEC_SANDBOX=host",
    };
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    const result = await probe(candidate);
    if (result.ok) {
      return {
        sandbox: { ...rest, mode: "container", runtime: candidate },
        reason: `HAT_EXEC_SANDBOX=${mode} and ${candidate} ${result.version} is available`,
      };
    }
    failures.push(`${candidate}: ${result.reason}`);
  }

  const tried = failures.join("; ");
  if (mode === "container") {
    throw new Error(`HAT_EXEC_SANDBOX=container but no container runtime is usable (${tried})`);
  }
  return {
    sandbox: { ...rest, mode: "host", runtime: candidates[0]! },
    reason: `HAT_EXEC_SANDBOX=auto and no container runtime is usable (${tried})`,
  };
}

export interface SpawnPlan {
  bin: string;
  args: string[];
  shell: boolean;
}

/**
 * Turn a shell command into a spawn plan. In `container` mode the command runs
 * inside a throwaway container with the workspace bind-mounted, no network by
 * default, and cpu/memory/pids limits. Hardened with cap-drop, no-new-
 * privileges, read-only rootfs (workspace stays writable), and a non-root user.
 */
export function spawnPlan(command: string, cwd: string, sandbox: SandboxConfig): SpawnPlan {
  if (sandbox.mode !== "container") {
    return { bin: command, args: [], shell: true };
  }
  return {
    bin: sandbox.runtime,
    shell: false,
    args: [
      "run",
      "--rm",
      "-i",
      "--network",
      sandbox.network,
      "--memory",
      sandbox.memory,
      "--cpus",
      sandbox.cpus,
      "--pids-limit",
      "512",
      "--cap-drop=ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--user",
      "65532:65532",
      "-v",
      `${cwd}:/workspace`,
      "-w",
      "/workspace",
      sandbox.image,
      "sh",
      "-lc",
      command,
    ],
  };
}
