import type { ChatMessage, Part } from "@hat/core";
import { newId } from "@hat/core";

/** What a call gets in place of the result it never produced. */
const INTERRUPTED = "[no result: this call was interrupted before it finished]";

/**
 * Make stored history safe to send. Providers reject a request outright for
 * shapes that a failed call, a crash or an older bug can leave behind, and
 * then every later turn fails the same way:
 *
 * - an assistant message with nothing a provider can take (no text and no
 *   tool calls: a call that failed before any output, or reasoning alone,
 *   which is never sent back) is dropped;
 * - a tool call with no result (the server stopped mid-call) is answered
 *   with a placeholder, and a result whose call is gone is dropped;
 * - back-to-back user messages are merged, since some providers insist on
 *   alternating turns. A "Continue" nudge that never got its reply is
 *   dropped rather than merged: it would make the model continue an old
 *   answer instead of taking the new message;
 * - `system` messages are dropped. The app never stores any, so one can only
 *   come from an imported file, and it is not shown to the user either.
 *
 * Only the request is repaired; stored history is left as it is.
 */
export function repairTranscript(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  /** Calls of the latest assistant message still waiting for a result. */
  let unanswered: Array<{ id: string; name: string }> = [];

  const answerRest = (): void => {
    if (unanswered.length === 0) return;
    out.push({
      id: newId("msg"),
      role: "tool",
      parts: unanswered.map((call) => ({
        type: "tool_result" as const,
        id: call.id,
        name: call.name,
        content: [{ type: "text" as const, text: INTERRUPTED }],
        isError: true,
      })),
      createdAt: out.at(-1)?.createdAt ?? 0,
    });
    unanswered = [];
  };

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      const results = message.parts.filter(
        (part) => part.type === "tool_result" && unanswered.some((call) => call.id === part.id),
      );
      if (results.length === 0) continue;
      unanswered = unanswered.filter((call) => !results.some((part) => part.type === "tool_result" && part.id === call.id));
      out.push(results.length === message.parts.length ? message : { ...message, parts: results });
      continue;
    }

    answerRest();
    const previous = out.at(-1);

    if (message.role === "assistant") {
      const calls = message.parts.filter((part) => part.type === "tool_call");
      if (!hasText(message.parts) && calls.length === 0) continue;
      unanswered = calls.map((part) => ({ id: part.id, name: part.name }));
      if (previous?.role === "assistant") {
        // Only reachable when the previous one made no calls (they would have
        // been answered above), so the two read as one reply.
        out[out.length - 1] = { ...previous, parts: joinParts(previous.parts, message.parts) };
      } else {
        out.push(message);
      }
      continue;
    }

    if (previous?.role === "user") {
      out[out.length - 1] = previous.meta?.synthetic
        ? message
        : { ...previous, parts: joinParts(previous.parts, message.parts) };
      continue;
    }
    out.push(message);
  }
  answerRest();
  return out;
}

function hasText(parts: Part[]): boolean {
  return parts.some((part) => part.type === "text" && part.text.trim() !== "");
}

/** Two messages' parts as one, with a paragraph break between their text. */
function joinParts(first: Part[], second: Part[]): Part[] {
  return [...first, { type: "text", text: "\n\n" }, ...second];
}
