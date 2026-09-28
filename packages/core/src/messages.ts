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

/**
 * Add provider-reported usage into an accumulator, treating absent fields as
 * zero. Only totals a provider actually reported are summed: deriving a total
 * here would bake a guess into the accumulator, and the next `addUsage` would
 * then add to that guess instead of re-deriving it. Callers that need a total
 * for a figure with no reported one go through `usageTotal`.
 */
export function addUsage(base: Usage | undefined, next: Usage): Usage {
  return {
    inputTokens: (base?.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (base?.outputTokens ?? 0) + (next.outputTokens ?? 0),
    totalTokens: (base?.totalTokens ?? 0) + (next.totalTokens ?? 0),
  };
}

/**
 * The most trustworthy total for a usage figure, or 0 when nothing is known.
 * Providers are inconsistent about `totalTokens`: some send it, some send only
 * the input/output split, and `addUsage` always materializes the field, so a
 * zero total means "not reported" rather than "genuinely free".
 */
export function usageTotal(usage: Usage | undefined): number {
  if (!usage) return 0;
  if (usage.totalTokens !== undefined && usage.totalTokens > 0) return usage.totalTokens;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** Sum a list of usage figures, skipping the ones that are absent. */
export function sumUsage(list: ReadonlyArray<Usage | undefined>): Usage {
  return list.reduce<Usage | undefined>(
    (acc, usage) => (usage ? addUsage(acc, usage) : acc),
    undefined,
  ) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
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
