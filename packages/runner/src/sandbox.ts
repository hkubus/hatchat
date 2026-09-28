export interface SandboxConfig {
  mode: "host" | "container";
  runtime: string;
  image: string;
  network: string;
  memory: string;
  cpus: string;
}

export interface SpawnPlan {
  bin: string;
  args: string[];
  shell: boolean;
}

/**
 * Turn a shell command into a spawn plan. In `container` mode the command runs
 * inside a throwaway container with the workspace bind-mounted, no network by
 * default, and cpu/memory/pids limits.
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
