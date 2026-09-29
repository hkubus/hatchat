import type { ChatMessage, Part } from "@hat/core";

export type OpenAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * OpenAI-compatible function names must match `^[a-zA-Z0-9_-]{1,64}$`. We map
 * any other tool name (e.g. `shell.exec`, `mcp/github/create`) to a valid,
 * deterministic wire name. Reversibility is handled by the provider using the
 * request's tool list.
 */
export function toWireName(name: string): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name;
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 54);
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) | 0;
  }
  return `${safe}__${(hash >>> 0).toString(16).padStart(8, "0").slice(0, 8)}`;
}

function toContentParts(parts: Part[]): OpenAIContentPart[] {
  const out: OpenAIContentPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      if (part.source.kind === "attachment") continue; // resolved by the kernel
      const url =
        part.source.kind === "url"
          ? part.source.url
          : `data:${part.source.mime};base64,${part.source.data}`;
      out.push({ type: "image_url", image_url: { url } });
    } else if (part.type === "file") {
      out.push({ type: "text", text: `[file ${part.name} (${part.mime}, ${part.size} bytes), id ${part.id}]` });
    }
  }
  return out;
}

/** Translate canonical messages into OpenAI chat-completions messages. */
export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: textOf(message.parts) });
        break;

      case "user": {
        const hasImage = message.parts.some((p) => p.type === "image");
        out.push({
          role: "user",
          content: hasImage ? toContentParts(message.parts) : textOf(message.parts),
        });
        break;
      }

      case "assistant": {
        const toolCalls: OpenAIToolCall[] = message.parts
          .filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call")
          .map((p) => ({
            id: p.id,
            type: "function" as const,
            function: { name: toWireName(p.name), arguments: JSON.stringify(p.args ?? {}) },
          }));
        const text = textOf(message.parts);
        const entry: OpenAIMessage = {
          role: "assistant",
          content: text || null,
        };
        if (toolCalls.length > 0) entry.tool_calls = toolCalls;
        out.push(entry);
        break;
      }

      case "tool": {
        for (const part of message.parts) {
          if (part.type !== "tool_result") continue;
          out.push({
            role: "tool",
            tool_call_id: part.id,
            content: textOf(part.content),
          });
        }
        break;
      }
    }
  }

  return out;
}
