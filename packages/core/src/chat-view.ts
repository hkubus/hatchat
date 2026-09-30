/**
 * The chat view-model: turning the server's message tree into a flat
 * transcript, and folding a live `KernelEvent` stream into the same shape.
 *
 * This is deliberately pure and free of any UI framework. It is the part of
 * the client that has to agree exactly with what the server sends, so the web
 * and desktop clients share it — see `chat-view.test.ts`. The iOS app has a
 * Swift port (`apps/ios/HatKit/Sources/HatKit/ChatView.swift`) whose tests hold
 * the same cases; change the two together.
 */

import type { ApprovalDecision } from "./context.js";
import type { KernelEvent } from "./events.js";
import type { ChatMessage, Part, Usage } from "./messages.js";
import { addUsage } from "./messages.js";

/** One node of the active root-to-leaf path, as the session API returns it. */
export interface ChatPathNode {
  message: ChatMessage;
  parentId: string | null;
  siblingIndex: number;
  siblingCount: number;
  siblingIds: string[];
}

export interface UiTool {
  callId: string;
  name: string;
  args: unknown;
  /**
   * Last approval state seen for this call. `null` means the tool is not
   * approval-gated (or the policy is `auto`), so the card shows no prompt.
   */
  approval: "requested" | "approved" | "denied" | null;
  result?: string;
  isError?: boolean;
  running: boolean;
  /** Images in the result (e.g. a plot from `python`), shown outside the details. */
  images?: UiImage[];
  /** Stored artifacts in the result, shown as tappable cards. */
  files?: UiFile[];
  /** Set optimistically once an `ask_user` question has been answered here. */
  answered?: boolean;
}

/**
 * A stored file: an artifact the assistant produced, or a document the user
 * attached. Either way it is an attachment on the server.
 */
export interface UiFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface UiBranch {
  index: number;
  count: number;
  ids: string[];
}

export interface UiImage {
  /** Data URL for inline and remote images; empty for attachment-backed ones. */
  src: string;
  attachmentId?: string;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  tools: UiTool[];
  branch?: UiBranch;
  images: UiImage[];
  /** Documents attached to a user message. */
  files: UiFile[];
  usage?: Usage;
  /** Why the model stopped; `length` means the reply was cut off. */
  finishReason?: string;
  /** True while this is the in-flight assistant message rather than stored state. */
  streaming?: boolean;
}

export function emptyAssistant(id: string): UiMessage {
  return {
    id,
    role: "assistant",
    text: "",
    reasoning: "",
    tools: [],
    images: [],
    files: [],
    streaming: true,
  };
}

/**
 * Replace the message with `messageId`, or the newest one when the id is
 * unknown.
 *
 * The fallback matters: `tool.approval` and `tool.result` carry no message id,
 * and a delta for a message that has already scrolled out of the in-flight list
 * should still land somewhere sensible rather than being dropped.
 */
function patchMessage(
  list: UiMessage[],
  messageId: string | undefined,
  fn: (m: UiMessage) => UiMessage,
): UiMessage[] {
  const known = messageId ? list.findIndex((m) => m.id === messageId) : -1;
  const index = known === -1 ? list.length - 1 : known;
  if (index < 0) return list;
  const next = [...list];
  next[index] = fn(next[index]);
  return next;
}

/**
 * Patch a tool by `callId`, searching newest message first. The call id is the
 * only handle: the approval and result events do not say which message they
 * belong to, and a tool-using turn spans several.
 */
function patchTool(
  list: UiMessage[],
  callId: string,
  fn: (t: UiTool) => UiTool,
): UiMessage[] {
  for (let i = list.length - 1; i >= 0; i--) {
    const index = list[i].tools.findIndex((t) => t.callId === callId);
    if (index === -1) continue;
    const tools = [...list[i].tools];
    tools[index] = fn(tools[index]);
    const next = [...list];
    next[i] = { ...next[i], tools };
    return next;
  }
  return list;
}

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function reasoningOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "reasoning" }> => p.type === "reasoning")
    .map((p) => p.text)
    .join("");
}

function toolsOf(parts: Part[]): UiTool[] {
  return parts
    .filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call")
    .map((p) => ({
      callId: p.id,
      name: p.name,
      args: p.args,
      approval: null,
      // A call that has a result somewhere later in the path starts out marked
      // running; `buildMessages` clears it when it reaches the tool message.
      running: true,
    }));
}

function imagesOf(parts: Part[]): UiImage[] {
  const out: UiImage[] = [];
  for (const part of parts) {
    if (part.type !== "image") continue;
    if (part.source.kind === "attachment") {
      out.push({ src: "", attachmentId: part.source.id });
    } else if (part.source.kind === "url") {
      out.push({ src: part.source.url });
    } else {
      out.push({ src: `data:${part.source.mime};base64,${part.source.data}` });
    }
  }
  return out;
}

function filesOf(parts: Part[]): UiFile[] {
  return parts
    .filter((p): p is Extract<Part, { type: "file" }> => p.type === "file")
    .map((p) => ({ id: p.id, name: p.name, mime: p.mime, size: p.size }));
}

/** What a tool result's content contributes to its card. */
export function toolResultOf(parts: Part[]): { result: string; images: UiImage[]; files: UiFile[] } {
  return { result: textOf(parts), images: imagesOf(parts), files: filesOf(parts) };
}

/**
 * Rebuild the visible conversation from the server's active branch path.
 *
 * `path` is already the active root-to-leaf chain, so this is a walk, not a
 * tree search. The one subtlety is `role: "tool"`: a tool result arrives as its
 * own message, but the UI wants it folded into the tool card of the assistant
 * message that made the call — so the walk walks backwards to find the card and
 * mutates it in place.
 */
export function buildMessages(path: ChatPathNode[]): UiMessage[] {
  const out: UiMessage[] = [];
  for (const node of path) {
    const { message } = node;
    const branch: UiBranch = {
      index: node.siblingIndex,
      count: node.siblingCount,
      ids: node.siblingIds,
    };

    if (message.role === "user") {
      // The "Continue" nudge is the app talking, not the user: the reply it
      // produced reads as a continuation of the message above.
      if (message.meta?.synthetic) continue;
      out.push({
        id: message.id,
        role: "user",
        text: textOf(message.parts),
        reasoning: "",
        tools: [],
        images: imagesOf(message.parts),
        files: filesOf(message.parts),
        branch,
      });
    } else if (message.role === "assistant") {
      out.push({
        id: message.id,
        role: "assistant",
        text: textOf(message.parts),
        reasoning: reasoningOf(message.parts),
        tools: toolsOf(message.parts),
        images: imagesOf(message.parts),
        files: [],
        branch,
        usage: message.meta?.usage,
        finishReason: message.meta?.finishReason,
      });
    } else if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type !== "tool_result") continue;
        for (let i = out.length - 1; i >= 0; i--) {
          const tool = out[i].tools.find((t) => t.callId === part.id);
          if (tool) {
            Object.assign(tool, toolResultOf(part.content));
            tool.isError = part.isError;
            tool.running = false;
            break;
          }
        }
      }
    }
  }
  return out;
}

/** What a single `KernelEvent` does to the live view-model. */
export type ChatEffect =
  | { kind: "none" }
  | { kind: "reset-usage" }
  | { kind: "start-message"; id: string }
  | { kind: "append-text"; messageId: string | undefined; text: string }
  | { kind: "append-reasoning"; messageId: string | undefined; text: string }
  | { kind: "tool-call"; messageId: string | undefined; callId: string; name: string; args: unknown }
  | { kind: "tool-approval"; callId: string; status: "requested" | "approved" | "denied" }
  | {
      kind: "tool-result";
      callId: string;
      result: string;
      images: UiImage[];
      files: UiFile[];
      isError: boolean;
    }
  | { kind: "finish-message"; messageId: string; finishReason: string }
  | { kind: "usage"; usage: Usage }
  | { kind: "session-title"; sessionId: string; title: string }
  | { kind: "error"; message: string }
  | { kind: "warning"; message: string };

/**
 * Read one event. Kept separate from the state update so the mapping from wire
 * format to UI intent can be asserted directly.
 *
 * Every turn event is a `KernelEvent` under the single SSE name `kernel`, so
 * the client discriminates on `type`.
 *
 * There is one `message.start` per *model iteration*, not per turn: a turn that
 * calls tools emits several, and each is a separate assistant message on screen.
 * That is why the in-flight state is a list.
 */
export function readEvent(event: KernelEvent): ChatEffect {
  switch (event.type) {
    case "turn.start":
      return { kind: "reset-usage" };
    case "message.start":
      return { kind: "start-message", id: event.messageId };
    case "text.delta":
      return { kind: "append-text", messageId: event.messageId, text: event.text };
    case "reasoning.delta":
      return { kind: "append-reasoning", messageId: event.messageId, text: event.text };
    case "tool.call":
      return {
        kind: "tool-call",
        messageId: event.messageId,
        callId: event.callId,
        name: event.name,
        args: event.args,
      };
    case "tool.approval":
      return { kind: "tool-approval", callId: event.callId, status: event.status };
    case "tool.result":
      return {
        kind: "tool-result",
        callId: event.callId,
        ...toolResultOf(event.parts),
        isError: event.isError,
      };
    case "message.done":
      return { kind: "finish-message", messageId: event.messageId, finishReason: event.finishReason };
    case "usage":
      return { kind: "usage", usage: event.usage };
    case "session.title":
      return { kind: "session-title", sessionId: event.sessionId, title: event.title };
    case "error":
      return { kind: "error", message: event.error.message };
    case "warning":
      return { kind: "warning", message: event.message };
    default:
      // `turn.done` carries no view-model change of its own: a finished turn
      // becomes durable through the post-turn refresh.
      return { kind: "none" };
  }
}

/**
 * Apply one effect to the list of in-flight messages.
 *
 * The list is the whole reason this is not a single-message model: a turn that
 * calls tools produces an assistant message per iteration, and the earlier ones
 * hold the tool calls the user needs to see and approve.
 */
export function applyEffect(list: UiMessage[], effect: ChatEffect): UiMessage[] {
  switch (effect.kind) {
    case "start-message":
      return [...list, emptyAssistant(effect.id)];
    case "append-text":
      return patchMessage(list, effect.messageId, (m) => ({ ...m, text: m.text + effect.text }));
    case "append-reasoning":
      return patchMessage(list, effect.messageId, (m) => ({
        ...m,
        reasoning: m.reasoning + effect.text,
      }));
    case "tool-call":
      return patchMessage(list, effect.messageId, (m) => ({
        ...m,
        tools: [
          ...m.tools,
          {
            callId: effect.callId,
            name: effect.name,
            args: effect.args,
            approval: null,
            running: true,
          },
        ],
      }));
    case "tool-approval":
      return patchTool(list, effect.callId, (t) => ({ ...t, approval: effect.status }));
    case "tool-result":
      return patchTool(list, effect.callId, (t) => ({
        ...t,
        running: false,
        isError: effect.isError,
        result: effect.result,
        images: effect.images,
        files: effect.files,
      }));
    case "finish-message":
      // Only a known id: a stale `message.done` must not stamp its finish
      // reason onto whatever happens to be newest.
      if (!list.some((m) => m.id === effect.messageId)) return list;
      return patchMessage(list, effect.messageId, (m) => ({ ...m, finishReason: effect.finishReason }));
    case "usage":
      // Usage arrives once per model call, before its message.done, so the
      // newest message is the one it belongs to.
      return patchMessage(list, undefined, (m) => ({ ...m, usage: addUsage(m.usage, effect.usage) }));
    default:
      return list;
  }
}

/**
 * Apply a live effect to the stored messages shown above the in-flight ones.
 * Only tool approvals and results can concern them: a client that attached
 * to a turn already under way (a reload, switching back, another device) got
 * the message that made the call with the stored history, since it was saved
 * before the call ran, so the replayed approval request and the result belong
 * to that copy. Applied only in flight, they were dropped, which left an
 * approval with no buttons and the turn waiting on it. The list comes back
 * unchanged when the call is not in it.
 */
export function applyStoredEffect(stored: UiMessage[], effect: ChatEffect): UiMessage[] {
  if (effect.kind !== "tool-approval" && effect.kind !== "tool-result") return stored;
  return applyEffect(stored, effect);
}

/**
 * How full the model's context window is, judged by the most recent model
 * call: its prompt plus its reply is what the next call starts from. Undefined
 * when the window is unknown or nothing has been reported yet.
 */
export function contextFill(
  messages: ReadonlyArray<Pick<UiMessage, "role" | "usage">>,
  contextWindow: number | undefined,
): { tokens: number; fraction: number } | undefined {
  if (!contextWindow || contextWindow <= 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i].usage;
    if (messages[i].role !== "assistant" || !usage) continue;
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (tokens <= 0) continue;
    return { tokens, fraction: Math.min(1, tokens / contextWindow) };
  }
  return undefined;
}

/** Whether the conversation ends on a reply that was cut off at the output limit. */
export function endsTruncated(
  messages: ReadonlyArray<Pick<UiMessage, "role" | "finishReason">>,
): boolean {
  const last = messages[messages.length - 1];
  return Boolean(last && last.role === "assistant" && last.finishReason === "length");
}

/** The local decision recorded optimistically on a tool card, before the POST. */
export function approvalForDecision(decision: ApprovalDecision): "approved" | "denied" {
  return decision === "deny" ? "denied" : "approved";
}

/** First non-blank line, for briefs of multi-line arguments like code. */
function firstLine(value: string): string {
  return value.split("\n").find((line) => line.trim())?.trim() ?? "";
}

/**
 * Which argument makes the one-line brief for a known tool. `firstLine` marks
 * arguments that are typically multi-line (code, task descriptions).
 */
const BRIEF_KEYS: Record<string, { key: string; firstLine?: boolean }> = {
  read_file: { key: "path" },
  write_file: { key: "path" },
  edit_file: { key: "path" },
  web_fetch: { key: "url" },
  python: { key: "code", firstLine: true },
  process_start: { key: "command" },
  create_artifact: { key: "name" },
  memory_save: { key: "text" },
  ask_user: { key: "question" },
  spawn_subagent: { key: "task", firstLine: true },
  schedule_create: { key: "title" },
};

/** One-line preview of a tool call, for the collapsed card. */
export function toolSummary(tool: UiTool): string {
  const args = tool.args;
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const record = args as Record<string, unknown>;
  const brief = BRIEF_KEYS[tool.name];
  if (brief) {
    const value = record[brief.key];
    if (typeof value === "string") return brief.firstLine ? firstLine(value) : value;
  }
  // The checklist itself is the preview; a JSON dump of it is noise.
  if (tool.name === "todo_write") return "";
  const command = record.command ?? record.cmd;
  if (typeof command === "string") return command;
  const key = Object.keys(record)[0];
  return key ? `${key}: ${JSON.stringify(record[key])}` : "";
}

export interface UiTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** The checklist from `todo_write` args; malformed entries are dropped, not fatal. */
export function todosOf(args: unknown): UiTodo[] {
  const todos = (args as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return [];
  const out: UiTodo[] = [];
  for (const item of todos) {
    const { content, status } = (item ?? {}) as Record<string, unknown>;
    if (typeof content !== "string") continue;
    out.push({
      content,
      status: status === "in_progress" || status === "completed" ? status : "pending",
    });
  }
  return out;
}

export interface UiQuestion {
  question: string;
  options: string[];
  multiSelect: boolean;
}

/** The prompt from `ask_user` args, or undefined when there is no question. */
export function questionOf(args: unknown): UiQuestion | undefined {
  const record = (args ?? {}) as Record<string, unknown>;
  if (typeof record.question !== "string") return undefined;
  const options = Array.isArray(record.options)
    ? record.options.filter((o): o is string => typeof o === "string" && o.length > 0)
    : [];
  return { question: record.question, options, multiSelect: record.multi_select === true };
}

/** The answer string the server expects: multi-select choices joined by ", ". */
export function joinAnswer(selected: string[], freeText: string): string {
  return [...selected, freeText.trim()].filter(Boolean).join(", ");
}

/** Human-readable byte count: 512 B, 1.5 KB, 12 MB. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
