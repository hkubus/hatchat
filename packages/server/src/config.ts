import { hashPassword } from "@hat/auth";

/**
 * Native shells (Tauri desktop, mobile webviews) serve the UI from their own
 * asset origin, so the API has to opt those origins in. Desktop uses
 * `tauri://localhost` on macOS/Linux and `http://tauri.localhost` on Windows.
 */
const DEFAULT_CORS_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

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
  s3?: S3Config;
  authPasswordHash?: string;
  cookieSecure: boolean;
  sessionTtlMs: number;
  /** Origins allowed to call the API from a browser (native shells). */
  corsOrigins: string[];
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
  return {
    bucket,
    region: envStr("HAT_S3_REGION", "us-east-1"),
    endpoint: process.env.HAT_S3_ENDPOINT || undefined,
    prefix: process.env.HAT_S3_PREFIX || undefined,
    pathStyle: envBool("HAT_S3_PATH_STYLE", true),
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.HAT_S3_SESSION_TOKEN || undefined,
    urlExpiresSeconds: envInt("HAT_S3_URL_EXPIRES", 3600),
  };
}

export function loadConfig(): ServerConfig {
  const passwordHash =
    process.env.HAT_AUTH_PASSWORD_HASH ||
    (process.env.HAT_AUTH_PASSWORD ? hashPassword(process.env.HAT_AUTH_PASSWORD) : undefined);

  return {
    port: envInt("HAT_PORT", 8787),
    host: envStr("HAT_HOST", "127.0.0.1"),
    authToken: process.env.HAT_AUTH_TOKEN || undefined,
    enrollToken: envStr("HAT_ENROLL_TOKEN", "dev-enroll-token"),
    maxToolIterations: envInt("HAT_MAX_TOOL_ITERATIONS", 5),
    workspaceHint: envStr("HAT_WORKSPACE_ROOT", "./.hat/workspaces"),
    dbPath: envStr("HAT_DB_PATH", "./.hat/hat.db"),
    masterKeyPath: envStr("HAT_MASTER_KEY_FILE", "./.hat/master.key"),
    uploadDir: envStr("HAT_UPLOAD_DIR", "./.hat/uploads"),
    pluginsDir: envStr("HAT_PLUGINS_DIR", "./plugins"),
    appTitle: envStr("HAT_APP_TITLE", "hat"),
    appUrl: process.env.HAT_APP_URL || undefined,
    s3: loadS3(),
    authPasswordHash: passwordHash,
    cookieSecure: envBool("HAT_COOKIE_SECURE", false),
    sessionTtlMs: envInt("HAT_SESSION_TTL_HOURS", 168) * 3_600_000,
    corsOrigins: envList("HAT_CORS_ORIGINS", DEFAULT_CORS_ORIGINS),
  };
}
