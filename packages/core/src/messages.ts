export type ImageSource =
  | { kind: "url"; url: string; mime: string }
  | { kind: "data"; data: string; mime: string }
  | { kind: "attachment"; id: string; mime: string };

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      content: Part[];
      isError?: boolean;
    };

export type Role = "system" | "user" | "assistant" | "tool";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface MessageMeta {
  provider?: string;
  model?: string;
  usage?: Usage;
  incomplete?: boolean;
}

export interface ChatMessage {
  id: string;
  role: Role;
  parts: Part[];
  createdAt: number;
  meta?: MessageMeta;
}

export function textPart(text: string): Part {
  return { type: "text", text };
}

export function userMessage(text: string): ChatMessage {
  return { id: "", role: "user", parts: [{ type: "text", text }], createdAt: 0 };
}

/** Concatenate all text parts of a message. */
export function textOf(message: ChatMessage): string {
  return message.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function toolCallsOf(
  message: ChatMessage,
): Array<Extract<Part, { type: "tool_call" }>> {
  return message.parts.filter(
    (p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call",
  );
}
