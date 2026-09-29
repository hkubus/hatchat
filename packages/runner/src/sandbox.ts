import { execFile } from "node:child_process";
import path from "node:path";

export type SandboxMode = "auto" | "host" | "container";
export type SandboxTier = "host" | "container";

/** Sandbox settings as configured; `auto` and an unset runtime are resolved at startup. */
export interface SandboxSettings {
  mode: SandboxMode;
  /** Explicit runtime binary; when unset, docker then podman are probed. */
  runtime?: string;
  /**
   * Tier for shell-mode processes (background processes, the Python tool).
   * Unset follows an explicit `container` mode and is `host` otherwise.
   */
  processes?: SandboxTier;
  image: string;
  network: string;
  memory: string;
  cpus: string;
}

/** The effective sandbox jobs are spawned with. */
export interface SandboxConfig {
  mode: SandboxTier;
  runtime: string;
  /** The engine runs rootless, so container uids map into the runner's subuid range. */
  rootless?: boolean;
  image: string;
  network: string;
  memory: string;
  cpus: string;
}

export type ProbeResult =
  | { ok: true; version: string; rootless: boolean }
  | { ok: false; reason: string };

/** Checks that a runtime binary exists and can reach its engine. */
export type RuntimeProbe = (runtime: string) => Promise<ProbeResult>;

export const DEFAULT_RUNTIMES = ["docker", "podman"];

const isPodman = (runtime: string): boolean => path.basename(runtime).startsWith("podman");

export function parseSandboxMode(raw: string): SandboxMode {
  const mode = raw.trim().toLowerCase();
  if (mode === "auto" || mode === "host" || mode === "container") return mode;
  throw new Error(`HAT_EXEC_SANDBOX must be auto, host or container (got "${raw}")`);
}

export function parseProcessTier(raw: string | undefined): SandboxTier | undefined {
  const tier = raw?.trim().toLowerCase();
  if (!tier) return undefined;
  if (tier === "host" || tier === "container") return tier;
  throw new Error(`HAT_SANDBOX_PROCESSES must be host or container (got "${raw}")`);
}

/**
 * Ask the engine (not just the CLI) for its version and whether it is
 * rootless. An unreachable daemon yields an error or an empty version.
 */
export const probeRuntime: RuntimeProbe = (runtime) => {
  const format = isPodman(runtime)
    ? "{{.Version.Version}}|{{.Host.Security.Rootless}}"
    : "{{.ServerVersion}}|{{range .SecurityOptions}}{{.}} {{end}}";
  return new Promise((resolve) => {
    execFile(runtime, ["info", "--format", format], { timeout: 5_000 }, (error, stdout, stderr) => {
      const [version = "", security = ""] = stdout.trim().split("|");
      if (!error && version.trim()) {
        // podman prints `true`; docker lists `name=rootless` among its security options.
        resolve({ ok: true, version: version.trim(), rootless: /true|rootless/.test(security) });
        return;
      }
      const reason =
        (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
          ? "not installed"
          : error?.killed
            ? "timed out"
            : stderr.trim().split("\n")[0] || error?.message || "engine unreachable";
      resolve({ ok: false, reason });
    });
  });
};

export interface ResolvedSandbox {
  /** Tier for `shell_exec`. */
  sandbox: SandboxConfig;
  /** Why this tier was chosen, for the startup log. */
  reason: string;
  /** Tier for shell-mode processes (background processes, the Python tool). */
  processes: SandboxConfig;
  processReason: string;
}

/**
 * Pick the effective tiers. `auto` uses the first runtime that answers the
 * probe and otherwise falls back to `host`. An explicit `container` with no
 * working runtime throws, so the runner refuses to start rather than failing
 * every job later.
 */
export async function resolveSandbox(
  settings: SandboxSettings,
  probe: RuntimeProbe = probeRuntime,
): Promise<ResolvedSandbox> {
  const { sandbox, reason } = await resolveShellTier(settings, probe);
  const wanted = settings.processes ?? (settings.mode === "container" ? "container" : "host");
  const source = settings.processes
    ? `HAT_SANDBOX_PROCESSES=${settings.processes}`
    : `HAT_SANDBOX_PROCESSES is unset and HAT_EXEC_SANDBOX=${settings.mode}`;
  if (wanted === "container" && sandbox.mode === "container") {
    return { sandbox, reason, processes: sandbox, processReason: source };
  }
  return {
    sandbox,
    reason,
    processes: { ...sandbox, mode: "host" },
    processReason: wanted === "container" ? `${source} but no container runtime is in use` : source,
  };
}

async function resolveShellTier(
  settings: SandboxSettings,
  probe: RuntimeProbe,
): Promise<{ sandbox: SandboxConfig; reason: string }> {
  const { mode, runtime, processes: _processes, ...rest } = settings;
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
      const flavor = result.rootless ? " (rootless)" : "";
      return {
        sandbox: { ...rest, mode: "container", runtime: candidate, rootless: result.rootless },
        reason: `HAT_EXEC_SANDBOX=${mode} and ${candidate} ${result.version}${flavor} is available`,
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

/** Never settable per command: loader/runtime knobs and the basics we pin. */
const BLOCKED_ENV = /^(LD_\w*|DYLD_\w*|NODE_OPTIONS|NODE_PATH|PATH|HOME|IFS)$/i;
/**
 * Also blocked in the container tier, where forwarded values live in the
 * runtime CLI's own environment and could redirect it (another daemon,
 * another storage root, a proxy for image pulls).
 */
const RUNTIME_ENV =
  /^(DOCKER_\w*|PODMAN_\w*|CONTAINERS?_\w*|BUILDAH_\w*|XDG_\w*|REGISTRY_AUTH_FILE|TMPDIR|SSL_CERT_\w*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i;

/** Keep the per-command env entries that are valid names and safe for the tier. */
export function commandEnv(
  env: Record<string, string> | undefined,
  tier: SandboxTier,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || BLOCKED_ENV.test(key)) continue;
    if (tier === "container" && RUNTIME_ENV.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface HostIdentity {
  uid: number;
  gid: number;
}

/** The runner's own uid/gid; undefined where the platform has none (Windows). */
export function currentIdentity(): HostIdentity | undefined {
  if (!process.getuid || !process.getgid) return undefined;
  return { uid: process.getuid(), gid: process.getgid() };
}

/**
 * Who the command runs as inside the container, chosen so files it writes to
 * the bind-mounted workspace are owned by the runner's own user on the host
 * (and files the runner wrote stay writable). Rootless podman maps the
 * runner's uid straight through with keep-id; rootless docker maps container
 * root to the runner's uid, so that is the matching choice there.
 */
export function containerUserArgs(sandbox: SandboxConfig, identity?: HostIdentity): string[] {
  if (!identity) return ["--user", "65532:65532"];
  const user = `${identity.uid}:${identity.gid}`;
  if (sandbox.rootless) {
    return isPodman(sandbox.runtime) ? ["--userns=keep-id", "--user", user] : ["--user", "0:0"];
  }
  return ["--user", user];
}

export interface SpawnOptions {
  /** Per-command env; filtered by `commandEnv` for the tier. */
  env?: Record<string, string>;
  /** Defaults to the runner's own identity. */
  identity?: HostIdentity;
  /** The runner's environment; the runtime CLI needs it (DOCKER_HOST, XDG_RUNTIME_DIR, ...). */
  hostEnv?: NodeJS.ProcessEnv;
}

export interface SpawnPlan {
  bin: string;
  args: string[];
  shell: boolean;
  env: NodeJS.ProcessEnv;
}

/**
 * Turn a shell command into a spawn plan. In `container` mode the command runs
 * inside a throwaway container with the workspace bind-mounted, no network by
 * default, and cpu/memory/pids limits. Hardened with cap-drop, no-new-
 * privileges, and a read-only rootfs (workspace stays writable). Per-command
 * env is forwarded with bare `-e KEY` flags and the values carried in the
 * runtime CLI's environment, so they never appear in its argv.
 */
export function spawnPlan(
  command: string,
  cwd: string,
  sandbox: SandboxConfig,
  options: SpawnOptions = {},
): SpawnPlan {
  const hostEnv = options.hostEnv ?? process.env;
  const env = commandEnv(options.env, sandbox.mode);
  if (sandbox.mode !== "container") {
    return {
      bin: command,
      args: [],
      shell: true,
      env: { PATH: hostEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: cwd, ...env },
    };
  }
  const identity = "identity" in options ? options.identity : currentIdentity();
  return {
    bin: sandbox.runtime,
    shell: false,
    env: { ...hostEnv, ...env },
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
      ...containerUserArgs(sandbox, identity),
      "-e",
      "HOME=/workspace",
      ...Object.keys(env).flatMap((key) => ["-e", key]),
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
