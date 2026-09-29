import type {
  ChatMessage,
  KernelEvent,
  ModelInfo,
  ReasoningEffort,
  Usage,
} from "@hat/core";
import { SseFrameParser, decodeFrame } from "@hat/core";
import { apiUrl, bearerHeaders } from "./runtime";

/**
 * Typed client for the hat server.
 *
 * This is `apps/web/src/api.ts` reduced to what a native client needs, and it
 * is the one place where the two differ in substance:
 *
 *   - **Streaming goes through `expo/fetch`, not `fetch`.** React Native's
 *     built-in `fetch` (whatwg-fetch over XHR) buffers the whole response before
 *     handing back a body, so a turn would not appear until the model had
 *     finished. `expo/fetch` is a native implementation that exposes
 *     `response.body` as a real `ReadableStream`, which the loop below reads
 *     chunk by chunk. `EventSource` is not an option either: the turn endpoint
 *     is a POST, and EventSource is GET-only.
 *   - **No CSRF, no cookies, no login.** The bearer token is exempt from both
 *     on the server, so none of the browser flow is ported.
 */

/** Carries the HTTP status so callers can tell "gone" from "unreachable". */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`${url}: ${status}`);
    this.name = "HttpError";
  }
}

/**
 * True for the rejection raised when an `AbortSignal` fires. Matched on `name`
 * rather than `instanceof` because the rejection is a `DOMException` on some
 * platforms and does not reliably inherit from `Error`.
 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError"
  );
}

// --- Response shapes -------------------------------------------------------
// These mirror what the Hono handlers in `packages/server/src/app.ts` actually
// serialize. `SessionRecord` and `PathNode` have no home in `@hat/core` (they
// live in `@hat/store-sqlite`, which is Node-only and cannot be bundled), so
// they are restated here. Keep them in step with `app.ts`.

export type ApprovalMode = "ask" | "auto" | "allowlist" | "deny";

export interface SessionRecord {
  id: string;
  title: string;
  /**
   * Who owns the title. `derived` is the truncated first user message and the
   * server will overwrite it with a generated one; `user` and `model` are
   * final. Not needed to render anything — kept so a rename knows whether it
   * can be undone by a generated title.
   */
  titleSource?: "derived" | "user" | "model";
  model: string;
  activeLeafId: string | null;
  approvalMode: ApprovalMode;
  allowedTools: string[];
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
  /** Tokens spent on the active branch; null when nothing has been recorded. */
  usage: Usage | null;
  updatedAt: number;
}

export interface RunnerSummary {
  id: string;
  capabilities: { os: string; arch: string; tags: string[]; runtimes?: string[] };
  /** In-flight jobs plus processes; the server picks the least busy. */
  load: number;
}

export interface ProviderStatus {
  id: string;
  label: string;
  secretName: string;
  configured: boolean;
  registered: boolean;
  status?: string;
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

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

/** Resolve the API origin and attach the bearer token. */
async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = await apiUrl(path);
  const headers = { ...init?.headers, ...(await bearerHeaders()) } as Record<string, string>;
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) onUnauthorized?.();
  return res;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await authFetch(url);
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

async function sendJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await authFetch(url, {
    method,
    headers: jsonHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

// --- Meta ------------------------------------------------------------------

/** Tool names the server has registered. Used to suggest an allowlist. */
export async function getTools(): Promise<string[]> {
  return (await getJson<{ tools: string[] }>("/api/tools")).tools;
}

export async function getModels(): Promise<ModelInfo[]> {
  return (await getJson<{ models: ModelInfo[] }>("/api/models")).models;
}

export async function getRunners(): Promise<RunnerSummary[]> {
  return (await getJson<{ runners: RunnerSummary[] }>("/api/runners")).runners;
}

// --- Providers and secrets -------------------------------------------------

export async function getProviders(): Promise<ProviderStatus[]> {
  return (await getJson<{ providers: ProviderStatus[] }>("/api/providers")).providers;
}

export async function setSecret(name: string, value: string): Promise<void> {
  await sendJson("/api/secrets", "POST", { name, value });
}

export async function deleteSecret(name: string): Promise<void> {
  await sendJson(`/api/secrets/${encodeURIComponent(name)}`, "DELETE");
}

// --- Plugins ---------------------------------------------------------------

export async function getPlugins(): Promise<PluginDescriptor[]> {
  return (await getJson<{ plugins: PluginDescriptor[] }>("/api/plugins")).plugins;
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
): Promise<PluginDescriptor> {
  const { plugin } = await sendJson<{ plugin: PluginDescriptor }>(
    `/api/plugins/${encodeURIComponent(id)}/enable`,
    "POST",
    { enabled },
  );
  return plugin;
}

export async function setPluginConfig(
  id: string,
  config: Record<string, unknown>,
): Promise<PluginDescriptor> {
  const { plugin } = await sendJson<{ plugin: PluginDescriptor }>(
    `/api/plugins/${encodeURIComponent(id)}/config`,
    "PUT",
    { config },
  );
  return plugin;
}

// --- Sessions --------------------------------------------------------------

export async function createSession(model: string): Promise<SessionPayload> {
  return sendJson<SessionPayload>("/api/sessions", "POST", { model });
}

export async function getSession(id: string): Promise<SessionPayload> {
  return getJson<SessionPayload>(`/api/sessions/${encodeURIComponent(id)}`);
}

export async function listSessions(): Promise<SessionSummary[]> {
  return (await getJson<{ sessions: SessionSummary[] }>("/api/sessions")).sessions;
}

export interface SessionPatch {
  model?: string;
  title?: string;
  approvalMode?: ApprovalMode;
  allowedTools?: string[];
  reasoningEffort?: ReasoningEffort;
}

export async function updateSession(id: string, patch: SessionPatch): Promise<SessionRecord> {
  const { session } = await sendJson<{ session: SessionRecord }>(
    `/api/sessions/${encodeURIComponent(id)}`,
    "PATCH",
    patch,
  );
  return session;
}

export async function renameSession(id: string, title: string): Promise<void> {
  await updateSession(id, { title });
}

export async function deleteSession(id: string): Promise<void> {
  await sendJson(`/api/sessions/${encodeURIComponent(id)}`, "DELETE");
}

export async function selectBranch(sessionId: string, messageId: string): Promise<SessionPayload> {
  return sendJson<SessionPayload>(
    `/api/sessions/${encodeURIComponent(sessionId)}/select`,
    "POST",
    { messageId },
  );
}

// --- Approvals -------------------------------------------------------------

export type ApprovalDecision = "approve" | "approve_always" | "deny";

/**
 * Resolve a pending tool call. `callId` comes from the `tool.approval` event on
 * the turn stream — there is no endpoint to list what is waiting.
 */
export async function resolveApproval(
  callId: string,
  decision: ApprovalDecision,
  sessionId: string,
): Promise<void> {
  const res = await authFetch(`/api/approvals/${encodeURIComponent(callId)}`, {
    method: "POST",
    headers: jsonHeaders(),
    // The server binds an approval to the session that asked for it, so a
    // stale card cannot approve another conversation's call by guessing the id.
    body: JSON.stringify({ decision, sessionId }),
  });
  if (!res.ok) throw new HttpError(res.status, `/api/approvals/${callId}`);
}

// --- Attachments -----------------------------------------------------------

/**
 * The image types the server accepts. It reads dimensions from the file header
 * with no native image dependency, so it only accepts what it can parse — and
 * an unrecognised type comes back as a 415 rather than being stored unreadable.
 *
 * This matters on iOS specifically: `expo-image-picker` hands back HEIC for
 * most camera-roll photos, which is not on this list.
 */
export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** True when the server will take this type. */
export function isAcceptedImageType(type: string | undefined): boolean {
  return ACCEPTED_IMAGE_TYPES.includes((type ?? "") as (typeof ACCEPTED_IMAGE_TYPES)[number]);
}

/**
 * Upload an image picked on-device. The server reads the bytes, dedupes them by
 * sha256, and answers with an id that the turn refers to.
 *
 * `content-type` is deliberately *not* set: React Native's `FormData` knows the
 * part's own type, and setting the header by hand would drop the multipart
 * boundary and make the server reject the body.
 */
export async function uploadAttachment(file: {
  uri: string;
  name: string;
  type: string;
}): Promise<AttachmentRecord> {
  if (!isAcceptedImageType(file.type)) {
    // Caught here rather than as a 415 round trip, so the message can say what
    // to do about it.
    throw new Error(
      `${file.name} is ${file.type || "an unrecognised type"}. The server accepts PNG, JPEG, GIF, and WebP — re-share the photo as JPEG.`,
    );
  }
  const form = new FormData();
  form.append("file", file as unknown as Blob);
  const res = await authFetch("/api/attachments", { method: "POST", body: form });
  if (res.status === 415) throw new Error("The server rejected that image format.");
  if (!res.ok) throw new HttpError(res.status, "/api/attachments");
  return (await res.json()).attachment as AttachmentRecord;
}

/**
 * Download an attachment as a data URL.
 *
 * This is the only way to render one: `<Image>` fetches its own `src` and so
 * cannot carry the bearer token, which rules out a plain URL. The server caps
 * uploads at 25 MiB, and a data URL of that size is already uncomfortable in JS
 * memory, so callers should render these at a bounded size.
 */
export async function fetchAttachmentBase64(id: string): Promise<string> {
  const res = await authFetch(`/api/attachments/${encodeURIComponent(id)}`);
  if (!res.ok) throw new HttpError(res.status, `attachment ${id}`);
  const mime = res.headers.get("content-type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await res.arrayBuffer());
  return `data:${mime};base64,${base64FromBytes(bytes)}`;
}

/** Hermes has no `btoa` with a binary-string input, so encode in chunks. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return globalThis.btoa(binary);
}

// --- Streaming turns -------------------------------------------------------

/**
 * Consume a kernel SSE response.
 *
 * `expo/fetch` is imported lazily and through a namespace so that a future
 * export without streaming support fails one call site rather than the whole
 * bundle.
 *
 * Aborting `signal` closes the socket, but it does **not** stop the turn: a
 * turn outlives any one request so it survives a reload or a dropped
 * connection. Cancelling is a separate, explicit request — see `cancelTurn`.
 */
async function readSSE(
  res: Response,
  onEvent: (event: KernelEvent) => void,
): Promise<void> {
  if (!res.ok || !res.body) throw new HttpError(res.status, res.url);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();

  function emit(payloads: string[]): void {
    for (const payload of payloads) {
      // A frame can be truncated or non-JSON; that must not end the turn.
      const event = decodeFrame<KernelEvent>(payload);
      if (event) onEvent(event);
    }
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      emit(parser.push(decoder.decode(value, { stream: true })));
    }
    // Flush the decoder and whatever is left, so a final frame is not lost when
    // the stream ends mid-frame.
    emit(parser.push(decoder.decode()));
    emit(parser.flush());
  } finally {
    // Also runs on abort, which errors the pending read and releases the socket.
    await reader.cancel().catch(() => undefined);
  }
}

async function postSSE(
  path: string,
  body: unknown,
  onEvent: (event: KernelEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { fetch: expoFetch } = await import("expo/fetch");
  const url = await apiUrl(path);
  const res = await expoFetch(url, {
    method: "POST",
    headers: { ...jsonHeaders(), ...(await bearerHeaders()) },
    body: JSON.stringify(body),
    signal,
  });
  return readSSE(res, onEvent);
}

/**
 * Follow a turn already running for a session.
 *
 * This is what makes the app survive being backgrounded: iOS suspends timers
 * and can kill the process while the model is mid-answer, and the turn keeps
 * running on the server either way. Coming back and reattaching is the
 * difference between picking the answer up and losing it.
 *
 * Resolves `false` when the session is idle (the server answers 204).
 */
export async function followTurn(
  sessionId: string,
  onEvent: (event: KernelEvent) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const { fetch: expoFetch } = await import("expo/fetch");
  const url = await apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/stream`);
  const res = await expoFetch(url, {
    headers: { accept: "text/event-stream", ...(await bearerHeaders()) },
    signal,
  });
  if (res.status === 204) return false;
  await readSSE(res, onEvent);
  return true;
}

/**
 * Actually stop a turn — the Stop button. Without this, aborting the request
 * would only detach this viewer and the model would keep generating (and
 * billing) with nobody watching.
 */
export async function cancelTurn(sessionId: string): Promise<void> {
  await sendJson(`/api/sessions/${encodeURIComponent(sessionId)}/turn/cancel`, "POST");
}

export function sendTurn(
  sessionId: string,
  text: string,
  model: string,
  attachmentIds: string[],
  onEvent: (event: KernelEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return postSSE(
    `/api/sessions/${encodeURIComponent(sessionId)}/turn`,
    { text, model, attachmentIds },
    onEvent,
    signal,
  );
}

export function regenerate(
  sessionId: string,
  messageId: string,
  onEvent: (event: KernelEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return postSSE(
    `/api/sessions/${encodeURIComponent(sessionId)}/regenerate`,
    { messageId },
    onEvent,
    signal,
  );
}

export function editMessage(
  sessionId: string,
  messageId: string,
  text: string,
  onEvent: (event: KernelEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return postSSE(
    `/api/sessions/${encodeURIComponent(sessionId)}/edit`,
    { messageId, text },
    onEvent,
    signal,
  );
}
