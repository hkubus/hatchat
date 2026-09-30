import { hashPassword } from "@hat/auth";
import { defaultSystemPrompt } from "./prompt.js";

/**
 * Native shells (Tauri desktop, mobile webviews) serve the UI from their own
 * asset origin, so the API has to opt those origins in. Desktop uses
 * `tauri://localhost` on macOS/Linux and `http://tauri.localhost` on Windows;
 * in `tauri dev` the window loads the vite dev server instead, which is a
 * plain `http://localhost` origin.
 */
const DEFAULT_CORS_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  prefix?: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  urlExpiresSeconds: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  /** When set, /api requires this bearer token. Unset disables auth (dev only). */
  authToken?: string;
  enrollToken: string;
  maxToolIterations: number;
  workspaceHint: string;
  dbPath: string;
  masterKeyPath: string;
  uploadDir: string;
  pluginsDir: string;
  appTitle: string;
  appUrl?: string;
  /** Base system prompt prepended to every turn. */
  systemPrompt: string;
  s3?: S3Config;
  authPasswordHash?: string;
  cookieSecure: boolean;
  sessionTtlMs: number;
  /** Origins allowed to call the API from a browser (native shells). */
  corsOrigins: string[];
  /**
   * Addresses of reverse proxies whose `X-Forwarded-For` is believed. Anyone
   * else could write that header, and claim a fresh address on every request.
   */
  trustedProxies: string[];
  /** SSE keepalive comment interval; 0 disables keepalives. */
  sseKeepaliveMs: number;
  /** Model used for background title generation (defaults to the session model). */
  titleModel?: string;
  /** Set HAT_ENABLE_EXTERNAL_PLUGINS=false to disable loading ./plugins. */
  enableExternalPlugins: boolean;
  /**
   * How long a tool approval or `ask_user` question waits for the user before
   * giving up; 0 (the default) waits until answered or the turn is stopped.
   */
  approvalTimeoutMs: number;
  /** Retries for a rate-limited or overloaded provider before a turn fails. */
  providerRetries: number;
  /** Run each external plugin in its own sandboxed process; HAT_PLUGINS_ISOLATION=off loads them in-process. */
  pluginIsolation: boolean;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** Comma-separated list, blank entries dropped. */
function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const list = raw
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

/** Treat unset and empty env vars the same. */
function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw : fallback;
}

function loadS3(): S3Config | undefined {
  const bucket = process.env.HAT_S3_BUCKET;
  const accessKeyId = process.env.HAT_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.HAT_S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return undefined;
  // Presigned URLs are bearer credentials: clamp to AWS max (7d), default 15m.
  const rawExpires = envInt("HAT_S3_URL_EXPIRES", 900);
  const urlExpiresSeconds = Math.min(604800, Math.max(60, rawExpires));
  const endpoint = process.env.HAT_S3_ENDPOINT || undefined;
  if (endpoint && !/^https?:\/\//.test(endpoint)) {
    throw new Error("HAT_S3_ENDPOINT must be an http(s) URL");
  }
  return {
    bucket,
    region: envStr("HAT_S3_REGION", "us-east-1"),
    endpoint,
    prefix: process.env.HAT_S3_PREFIX || undefined,
    pathStyle: envBool("HAT_S3_PATH_STYLE", true),
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.HAT_S3_SESSION_TOKEN || undefined,
    urlExpiresSeconds,
  };
}

export function loadConfig(): ServerConfig {
  const passwordHash =
    process.env.HAT_AUTH_PASSWORD_HASH ||
    (process.env.HAT_AUTH_PASSWORD ? hashPassword(process.env.HAT_AUTH_PASSWORD) : undefined);

  const appTitle = envStr("HAT_APP_TITLE", "hat");

  const enrollToken = envStr("HAT_ENROLL_TOKEN", "dev-enroll-token");
  if (enrollToken === "dev-enroll-token") {
    console.warn(
      "[hat] HAT_ENROLL_TOKEN is the dev default; set a random token before exposing the server",
    );
  }
  // Shorter default (24h vs 7d) limits the blast radius of a stolen cookie.
  // Approval mode default stays `auto` (see Store) — this only bounds sessions.

  return {
    port: envInt("HAT_PORT", 8787),
    host: envStr("HAT_HOST", "127.0.0.1"),
    authToken: process.env.HAT_AUTH_TOKEN || undefined,
    enrollToken,
    maxToolIterations: envInt("HAT_MAX_TOOL_ITERATIONS", 100),
    workspaceHint: envStr("HAT_WORKSPACE_ROOT", "./.hat/workspaces"),
    dbPath: envStr("HAT_DB_PATH", "./.hat/hat.db"),
    masterKeyPath: envStr("HAT_MASTER_KEY_FILE", "./.hat/master.key"),
    uploadDir: envStr("HAT_UPLOAD_DIR", "./.hat/uploads"),
    pluginsDir: envStr("HAT_PLUGINS_DIR", "./plugins"),
    appTitle,
    appUrl: process.env.HAT_APP_URL || undefined,
    systemPrompt: envStr("HAT_SYSTEM_PROMPT", defaultSystemPrompt(appTitle)),
    s3: loadS3(),
    authPasswordHash: passwordHash,
    cookieSecure: envBool("HAT_COOKIE_SECURE", false),
    sessionTtlMs: envInt("HAT_SESSION_TTL_HOURS", 24) * 3_600_000,
    corsOrigins: envList("HAT_CORS_ORIGINS", DEFAULT_CORS_ORIGINS),
    trustedProxies: envList("HAT_TRUSTED_PROXIES", []),
    sseKeepaliveMs: envInt("HAT_SSE_KEEPALIVE_MS", 1_000),
    titleModel: process.env.HAT_TITLE_MODEL || undefined,
    enableExternalPlugins: envBool("HAT_ENABLE_EXTERNAL_PLUGINS", true),
    approvalTimeoutMs: Math.max(0, envInt("HAT_APPROVAL_TIMEOUT_MINUTES", 0)) * 60_000,
    providerRetries: Math.max(0, envInt("HAT_PROVIDER_RETRIES", 3)),
    pluginIsolation: envBool("HAT_PLUGINS_ISOLATION", true),
  };
}
