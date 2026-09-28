/**
 * Runtime connection config.
 *
 * The browser app runs same-origin behind the vite proxy (or whatever serves
 * `apps/web/dist`), so it needs no config. Native shells (Tauri desktop, and
 * eventually mobile) load the same bundle from their own asset origin, so they
 * need to know which hat server to talk to and how to authenticate.
 *
 * Shells expose a storage bridge instead of being imported directly, which
 * keeps `@tauri-apps/api` (and any other host SDK) out of this package:
 *
 * - Tauri: `app.withGlobalTauri` puts `window.__TAURI__.core.invoke` in reach,
 *   and the Rust side persists the config in the app config dir.
 * - Browser: `localStorage`.
 */

export interface HatConfig {
  /** Base URL of the hat server, e.g. `http://127.0.0.1:8787`. Empty = same origin. */
  serverUrl: string;
  /** `HAT_AUTH_TOKEN` for bearer auth. Empty = cookie/session auth. */
  token: string;
}

interface TauriGlobal {
  core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
}

const STORAGE_KEY = "hat.connection";

export const EMPTY_CONFIG: HatConfig = { serverUrl: "", token: "" };

function invoke(): ((command: string, args?: Record<string, unknown>) => Promise<unknown>) | undefined {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  const call = tauri?.core?.invoke;
  return call ? call.bind(tauri!.core) : undefined;
}

/** True when running inside a native shell rather than a plain browser tab. */
export function isNativeShell(): boolean {
  return invoke() !== undefined;
}

/** Trim a user-typed server URL down to an origin+path we can prefix onto paths. */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

let cached: Promise<HatConfig> | undefined;
let snapshot: HatConfig = EMPTY_CONFIG;

/** Last known config, for call sites that need it synchronously. */
export function currentConfig(): HatConfig {
  return snapshot;
}

export function loadConfig(): Promise<HatConfig> {
  if (cached) return cached;
  const call = invoke();
  const next = call
    ? call("load_config")
        .then((value) => coerce(value))
        .catch(() => ({ ...EMPTY_CONFIG }))
    : Promise.resolve().then(() => {
        try {
          return coerce(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
        } catch {
          return { ...EMPTY_CONFIG };
        }
      });
  cached = next.then((value) => {
    snapshot = value;
    return value;
  });
  return cached;
}

export function saveConfig(config: HatConfig): Promise<HatConfig> {
  const next: HatConfig = {
    serverUrl: normalizeServerUrl(config.serverUrl),
    token: config.token.trim(),
  };
  const call = invoke();
  cached = call
    ? call("save_config", { config: next }).then(() => next).catch(() => {
        cached = undefined;
        throw new Error("could not save connection settings");
      })
    : Promise.resolve().then(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
  return cached.then((value) => {
    snapshot = value;
    return value;
  });
}

/** Forget the cached config and re-read it (used after "disconnect"). */
export function resetConfig(): void {
  cached = undefined;
}

export async function apiUrl(path: string): Promise<string> {
  if (/^https?:\/\//i.test(path)) return path;
  const { serverUrl } = await loadConfig();
  return `${serverUrl}${path}`;
}

export async function bearerHeaders(): Promise<Record<string, string>> {
  const { token } = await loadConfig();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function coerce(value: unknown): HatConfig {
  const raw = (value ?? {}) as Partial<HatConfig>;
  return {
    serverUrl: normalizeServerUrl(typeof raw.serverUrl === "string" ? raw.serverUrl : ""),
    token: typeof raw.token === "string" ? raw.token.trim() : "",
  };
}
