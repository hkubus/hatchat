/**
 * The chat view-model: turning the server's message tree into a flat
 * transcript, and folding a live `KernelEvent` stream into the same shape.
 *
 * This is deliberately pure and free of React. It is the part of the client
 * that has to agree exactly with what the server sends, so it is the part
 * worth testing directly — see `chat.test.ts`.
 *
 * The shapes mirror `apps/web/src/App.tsx`, which is where the semantics come
 * from; the differences are only in how the state is threaded through React.
 */

import type { KernelEvent, Part, Usage } from "@hat/core";
import type { ApprovalDecision, PathNode } from "./api";

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
  usage?: Usage;
  /** True while this is the in-flight assistant message rather than stored state. */
  streaming?: boolean;
}

export function emptyAssistant(id: string): UiMessage {
  return { id, role: "assistant", text: "", reasoning: "", tools: [], images: [], streaming: true };
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

/**
 * Rebuild the visible conversation from the server's active branch path.
 *
 * `path` is already the active root-to-leaf chain, so this is a walk, not a
 * tree search. The one subtlety is `role: "tool"`: a tool result arrives as its
 * own message, but the UI wants it folded into the tool card of the assistant
 * message that made the call — so the walk walks backwards to find the card and
 * mutates it in place.
 */
export function buildMessages(path: PathNode[]): UiMessage[] {
  const out: UiMessage[] = [];
  for (const node of path) {
    const { message } = node;
    const branch: UiBranch = {
      index: node.siblingIndex,
      count: node.siblingCount,
      ids: node.siblingIds,
    };

    if (message.role === "user") {
      out.push({
        id: message.id,
        role: "user",
        text: textOf(message.parts),
        reasoning: "",
        tools: [],
        images: imagesOf(message.parts),
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
        branch,
        usage: message.meta?.usage,
      });
    } else if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type !== "tool_result") continue;
        for (let i = out.length - 1; i >= 0; i--) {
          const tool = out[i].tools.find((t) => t.callId === part.id);
          if (tool) {
            tool.result = textOf(part.content);
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
  | { kind: "tool-result"; callId: string; result: string; isError: boolean }
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
        result: textOf(event.parts),
        isError: event.isError,
      };
    case "session.title":
      return { kind: "session-title", sessionId: event.sessionId, title: event.title };
    case "error":
      return { kind: "error", message: event.error.message };
    case "warning":
      return { kind: "warning", message: event.message };
    default:
      // `usage`, `message.done` and `turn.done` carry no view-model change of
      // their own: usage is accumulated by the caller, and a finished message
      // becomes visible through the post-turn refresh.
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
      }));
    default:
      return list;
  }
}

/** The local decision recorded optimistically on a tool card, before the POST. */
export function approvalForDecision(decision: ApprovalDecision): "approved" | "denied" {
  return decision === "deny" ? "denied" : "approved";
}

/** One-line preview of a tool call, for the collapsed card. */
export function toolSummary(tool: UiTool): string {
  const args = tool.args;
  if (args === null || args === undefined) return "";
  if (typeof args === "string") return args;
  if (typeof args !== "object") return String(args);
  const record = args as Record<string, unknown>;
  const command = record.command ?? record.cmd;
  if (typeof command === "string") return command;
  const key = Object.keys(record)[0];
  return key ? `${key}: ${JSON.stringify(record[key])}` : "";
}
