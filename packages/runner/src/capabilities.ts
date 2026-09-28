import os from "node:os";
import type { HostCapabilities } from "@hat/core";

export function detectCapabilities(tags: string[]): HostCapabilities {
  const runtimes = [`node ${process.version}`];
  return {
    os: os.platform(),
    arch: os.arch(),
    runtimes,
    tags,
  };
}
