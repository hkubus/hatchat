import os from "node:os";
import type { HostCapabilities } from "@hat/core";
import type { SandboxConfig } from "./sandbox.js";

export function detectCapabilities(tags: string[], sandbox: SandboxConfig): HostCapabilities {
  const runtimes = [`node ${process.version}`];
  return {
    os: os.platform(),
    arch: os.arch(),
    runtimes,
    tags,
    sandbox: sandbox.mode,
  };
}
