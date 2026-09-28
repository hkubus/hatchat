import type { ChatMessage, KernelEvent, ModelInfo, ReasoningEffort } from "@hat/core";
import { apiUrl, bearerHeaders } from "./runtime";

export interface RunnerSummary {
  id: string;
  capabilities: { os: string; arch: string; tags: string[] };
}

export interface SessionRecord {
  id: string;
  title: string;
  model: string;
  activeLeafId: string | null;
  approvalMode: "ask" | "auto" | "allowlist" | "deny";
  allowedTools: string[];
  autoRoute: boolean;
  reasoningEffort: ReasoningEffort;
  createdAt: number;
  updatedAt: number;
}

export interface PathNode {
  message: ChatMessage;
  parentId: string | null;
  siblingIndex: number;
  siblingCount: number;
  siblingIds: string[];
}

export interface SessionPayload {
  session: SessionRecord;
  path: PathNode[];
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  messageCount: number;
  updatedAt: number;
}

export interface ProviderStatus {
  id: string;
  label: string;
  secretName: string;
  configured: boolean;
  registered: boolean;
}

export interface AttachmentRecord {
  id: string;
  sha256: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: number;
  url: string;
}

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface PluginDescriptor {
  id: string;
  name: string;
  version: string;
  description?: string;
  permissions: string[];
  requiresSecrets: string[];
  source: "builtin" | "external";
  enabled: boolean;
  status: "active" | "disabled" | "needs-config" | "error";
  error?: string;
  config: Record<string, unknown>;
  configSchema?: JsonSchema;
}

let onUnauthorized: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  onUnauthorized = handler;
}

function csrfToken(): string | undefined {
  const match = document.cookie.match(/(?:^|; )hat_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function csrfHeaders(): Record<string, string> {
  const csrf = csrfToken();
  return csrf ? { "x-csrf-token": csrf } : {};
}

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

function mergeHeaders(existing: HeadersInit | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  if (existing instanceof Headers) {
    existing.forEach((value, key) => {
      base[key] = value;
    });
  } else if (Array.isArray(existing)) {
    for (const [key, value] of existing) base[key] = value;
  } else if (existing) {
    Object.assign(base, existing);
  }
  return { ...base, ...csrfHeaders() };
}

/**
 * Every request goes through here: it resolves the API origin from the runtime
 * connection config and attaches credentials (bearer token for native shells,
 * session cookie + CSRF header for the browser).
 */
async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? await apiUrl(input) : input;
  const headers = { ...mergeHeaders(init?.headers), ...(await bearerHeaders()) };
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) onUnauthorized?.();
  return res;
}

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  password: boolean;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await authFetch("/api/auth/status");
  if (!res.ok) throw new Error(`auth status: ${res.status}`);
  return (await res.json()) as AuthStatus;
}

export async function login(password: string): Promise<void> {
  const res = await authFetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.status === 401) throw new Error("Invalid password");
  if (res.status === 429) throw new Error("Too many attempts; try again later");
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
}

export async function logout(): Promise<void> {
  await authFetch("/api/auth/logout", { method: "POST", headers: jsonHeaders() });
}


async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Fetch an attachment with credentials attached. Used for `<img>` rendering,
 * since a plain `src` request cannot carry the bearer token.
 */
export async function fetchAttachmentBlob(id: string): Promise<Blob> {
  const res = await authFetch(`/api/attachments/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`attachment ${id}: ${res.status}`);
  return res.blob();
}

export async function getModels(): Promise<ModelInfo[]> {
  return (await getJson<{ models: ModelInfo[] }>("/api/models")).models;
}

export async function getRunners(): Promise<RunnerSummary[]> {
  return (await getJson<{ runners: RunnerSummary[] }>("/api/runners")).runners;
}

export async function getProviders(): Promise<ProviderStatus[]> {
  return (await getJson<{ providers: ProviderStatus[] }>("/api/providers")).providers;
}

export async function setSecret(name: string, value: string): Promise<void> {
  const res = await authFetch("/api/secrets", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ name, value }),
  });
  if (!res.ok) throw new Error(`set secret: ${res.status}`);
}

export async function deleteSecret(name: string): Promise<void> {
  const res = await authFetch(`/api/secrets/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: jsonHeaders(),
  });
  if (!res.ok) throw new Error(`delete secret: ${res.status}`);
}

export async function getPlugins(): Promise<PluginDescriptor[]> {
  return (await getJson<{ plugins: PluginDescriptor[] }>("/api/plugins")).plugins;
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<PluginDescriptor> {
  const res = await authFetch(`/api/plugins/${encodeURIComponent(id)}/enable`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) throw new Error(`set plugin enabled: ${res.status}`);
  return (await res.json()).plugin as PluginDescriptor;
}

export async function setPluginConfig(
  id: string,
  config: Record<string, unknown>,
): Promise<PluginDescriptor> {
  const res = await authFetch(`/api/plugins/${encodeURIComponent(id)}/config`, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify({ config }),
  });
  if (!res.ok) throw new Error(`set plugin config: ${res.status}`);
  return (await res.json()).plugin as PluginDescriptor;
}

export async function createSession(model: string): Promise<SessionPayload> {
  const res = await authFetch("/api/sessions", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ model }),
  });
  if (!res.ok) throw new Error(`create session: ${res.status}`);
  return (await res.json()) as SessionPayload;
}

export async function getSession(id: string): Promise<SessionPayload> {
  return getJson<SessionPayload>(`/api/sessions/${encodeURIComponent(id)}`);
}

export async function updateSession(
  id: string,
  patch: {
    model?: string;
    title?: string;
    approvalMode?: SessionRecord["approvalMode"];
    allowedTools?: string[];
    autoRoute?: boolean;
    reasoningEffort?: ReasoningEffort;
  },
): Promise<SessionRecord> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update session: ${res.status}`);
  return (await res.json()).session as SessionRecord;
}

export async function listSessions(): Promise<SessionSummary[]> {
  return (await getJson<{ sessions: SessionSummary[] }>("/api/sessions")).sessions;
}

export async function renameSession(id: string, title: string): Promise<void> {
  await updateSession(id, { title });
}

export async function deleteSession(id: string): Promise<void> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: jsonHeaders(),
  });
  if (!res.ok) throw new Error(`delete session: ${res.status}`);
}

export async function resolveApproval(
  callId: string,
  decision: "approve" | "deny" | "approve_always",
): Promise<void> {
  await authFetch(`/api/approvals/${encodeURIComponent(callId)}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ decision }),
  });
}

async function postSSE(
  url: string,
  body: unknown,
  onEvent: (event: KernelEvent) => void,
): Promise<void> {
  const res = await authFetch(url, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) {
        try {
          onEvent(JSON.parse(data) as KernelEvent);
        } catch {
          /* ignore malformed frame */
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

export function sendTurn(
  sessionId: string,
  text: string,
  model: string,
  attachmentIds: string[],
  onEvent: (event: KernelEvent) => void,
): Promise<void> {
  return postSSE(
    `/api/sessions/${encodeURIComponent(sessionId)}/turn`,
    { text, model, attachmentIds },
    onEvent,
  );
}

export async function uploadAttachment(file: File): Promise<AttachmentRecord> {
  const form = new FormData();
  form.append("file", file);
  const res = await authFetch("/api/attachments", {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()).attachment as AttachmentRecord;
}

export function regenerate(
  sessionId: string,
  messageId: string,
  onEvent: (event: KernelEvent) => void,
): Promise<void> {
  return postSSE(
    `/api/sessions/${encodeURIComponent(sessionId)}/regenerate`,
    { messageId },
    onEvent,
  );
}

export function editMessage(
  sessionId: string,
  messageId: string,
  text: string,
  onEvent: (event: KernelEvent) => void,
): Promise<void> {
  return postSSE(
    `/api/sessions/${encodeURIComponent(sessionId)}/edit`,
    { messageId, text },
    onEvent,
  );
}

export async function selectBranch(sessionId: string, messageId: string): Promise<SessionPayload> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/select`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ messageId }),
  });
  if (!res.ok) throw new Error(`select branch: ${res.status}`);
  return (await res.json()) as SessionPayload;
}
