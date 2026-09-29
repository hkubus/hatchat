/**
 * Runtime connection config.
 *
 * This mirrors `apps/web/src/runtime.ts` but with two differences forced by the
 * platform:
 *
 *   - **Storage.** `expo-secure-store` (the iOS keychain) rather than
 *     `localStorage`, because the config holds `HAT_AUTH_TOKEN`. A bearer token
 *     in a plist is a bearer token in the iCloud backup.
 *   - **A real bridge instead of a Tauri global.** The web client reaches the
 *     desktop shell through `window.__TAURI__.core.invoke`; here the store *is*
 *     the bridge, so the two shells differ only in this file.
 *
 * There is no cookie/CSRF path. The server's `HAT_AUTH_TOKEN` is accepted as a
 * bearer credential and bearer requests are exempt from CSRF, which is exactly
 * what a native client wants: no `NSHTTPCookieStorage`, no double-submit token,
 * nothing to keep in sync with a login screen.
 */

import * as SecureStore from "expo-secure-store";

export interface HatConfig {
  /** Base URL of the hat server, e.g. `https://hat.tail1234.ts.net`. */
  serverUrl: string;
  /** `HAT_AUTH_TOKEN` for bearer auth. */
  token: string;
}

export const EMPTY_CONFIG: HatConfig = { serverUrl: "", token: "" };

/** Single JSON blob, so the two fields can never be written out of step. */
const CONFIG_KEY = "hat.connection";

/**
 * UI preferences (last model, last open session) go in the keychain too, under
 * a separate prefix. They are not secrets, but they are written rarely — once
 * per user action — and are small, so the keychain's per-item cost never shows
 * up. It also avoids taking a dependency on AsyncStorage just to persist a
 * three-line object.
 */
const PREFS_PREFIX = "hat.pref.";

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

function coerce(value: unknown): HatConfig {
  const raw = (value ?? {}) as Partial<HatConfig>;
  return {
    serverUrl: normalizeServerUrl(typeof raw.serverUrl === "string" ? raw.serverUrl : ""),
    token: typeof raw.token === "string" ? raw.token.trim() : "",
  };
}

let cached: Promise<HatConfig> | undefined;
let snapshot: HatConfig = EMPTY_CONFIG;

/** Last known config, for call sites that need it synchronously. */
export function currentConfig(): HatConfig {
  return snapshot;
}

export function loadConfig(): Promise<HatConfig> {
  if (cached) return cached;
  cached = SecureStore.getItemAsync(CONFIG_KEY)
    .then((value) => coerce(value ? JSON.parse(value) : null))
    .catch(() => ({ ...EMPTY_CONFIG }))
    .then((value) => {
      snapshot = value;
      return value;
    });
  return cached;
}

export async function saveConfig(config: HatConfig): Promise<HatConfig> {
  const next = coerce(config);
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(next));
  cached = Promise.resolve(next);
  snapshot = next;
  return next;
}

/** Forget the connection entirely; the next launch shows the connect screen. */
export async function clearConfig(): Promise<void> {
  await SecureStore.deleteItemAsync(CONFIG_KEY);
  cached = undefined;
  snapshot = EMPTY_CONFIG;
}

/** Read a UI preference, or `fallback` when it was never written. */
export async function loadPref(key: string, fallback: string): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(PREFS_PREFIX + key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function savePref(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(PREFS_PREFIX + key, value);
  } catch {
    // A preference that fails to persist is not worth interrupting the user for.
  }
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

/**
 * Probe a candidate server before saving it, so the connect screen can tell
 * "wrong URL" from "wrong token" instead of failing on the first real request.
 * Returns the server's health payload on success.
 */
export async function probeConnection(config: HatConfig): Promise<{
  ok: boolean;
  runners: string[];
  providers: string[];
}> {
  const headers: Record<string, string> = config.token
    ? { authorization: `Bearer ${config.token}` }
    : {};
  const res = await fetch(`${normalizeServerUrl(config.serverUrl)}/api/health`, {
    headers,
  });
  if (res.status === 401) throw new Error("That server wants a different token.");
  if (!res.ok) throw new Error(`Server replied ${res.status}.`);
  const body = (await res.json()) as { runners?: string[]; providers?: string[] };
  return { ok: true, runners: body.runners ?? [], providers: body.providers ?? [] };
}
