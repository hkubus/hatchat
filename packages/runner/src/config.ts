import os from "node:os";
import path from "node:path";
import { parseSandboxMode, type SandboxSettings } from "./sandbox.js";

export interface RunnerConfig {
  serverUrl: string;
  runnerId: string;
  enrollToken?: string;
  credential?: string;
  workspaceRoot: string;
  tags: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  sandbox: SandboxSettings;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Treat unset and empty env vars the same. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw : fallback;
}

export function loadConfig(): RunnerConfig {
  return {
    serverUrl: envStr("HAT_SERVER_URL", "ws://127.0.0.1:8787/link"),
    runnerId: envStr("HAT_RUNNER_ID", os.hostname()),
    enrollToken: envStr("HAT_ENROLL_TOKEN", "dev-enroll-token"),
    credential: process.env.HAT_CREDENTIAL || undefined,
    workspaceRoot: path.resolve(envStr("HAT_WORKSPACE_ROOT", "./.hat/workspaces")),
    tags: envStr("HAT_RUNNER_TAGS", "local")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    defaultTimeoutMs: envInt("HAT_EXEC_TIMEOUT_MS", 120_000),
    maxTimeoutMs: envInt("HAT_EXEC_MAX_TIMEOUT_MS", 600_000),
    maxOutputBytes: envInt("HAT_EXEC_MAX_OUTPUT_BYTES", 1_000_000),
    sandbox: {
      mode: parseSandboxMode(envStr("HAT_EXEC_SANDBOX", "auto")),
      runtime: process.env.HAT_SANDBOX_RUNTIME?.trim() || undefined,
      image: envStr("HAT_SANDBOX_IMAGE", "node:22-slim"),
      network: envStr("HAT_SANDBOX_NETWORK", "none"),
      memory: envStr("HAT_SANDBOX_MEMORY", "512m"),
      cpus: envStr("HAT_SANDBOX_CPUS", "1"),
    },
  };
}
