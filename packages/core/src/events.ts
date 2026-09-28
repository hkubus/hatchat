import type { NormalizedError } from "./errors.js";
import type { Part, Usage } from "./messages.js";

/** Canonical stream events emitted by the kernel towards clients. */
export type KernelEvent =
  | { type: "turn.start"; turnId: string }
  | { type: "message.start"; messageId: string; role: "assistant" }
  | { type: "text.delta"; messageId: string; text: string }
  | { type: "reasoning.delta"; messageId: string; text: string }
  | { type: "tool.call"; messageId: string; callId: string; name: string; args: unknown }
  | { type: "tool.approval"; callId: string; status: "requested" | "approved" | "denied" }
  | { type: "tool.result"; callId: string; name: string; parts: Part[]; isError: boolean }
  | { type: "message.done"; messageId: string; finishReason: string }
  | { type: "usage"; usage: Usage }
  | { type: "warning"; message: string }
  | { type: "error"; error: NormalizedError }
  | { type: "turn.done"; turnId: string };
