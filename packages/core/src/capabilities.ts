import type { ChatMessage } from "./messages.js";
import type { ProviderCapabilities } from "./provider.js";

export interface CapabilityNeeds {
  vision?: boolean;
  toolCalls?: boolean;
  reasoning?: boolean;
}

/**
 * Infer what a conversation needs. Vision is strict (from image parts); tool
 * calls are required only once the conversation has actually used tools.
 */
export function inferNeeds(messages: ChatMessage[]): CapabilityNeeds {
  const vision = messages.some((m) => m.parts.some((p) => p.type === "image"));
  const toolCalls = messages.some((m) => m.parts.some((p) => p.type === "tool_call"));
  return { vision, toolCalls };
}

export function satisfies(caps: ProviderCapabilities, needs: CapabilityNeeds): boolean {
  return unmetNeeds(caps, needs).length === 0;
}

export function unmetNeeds(caps: ProviderCapabilities, needs: CapabilityNeeds): string[] {
  const unmet: string[] = [];
  if (needs.vision && !caps.vision) unmet.push("vision");
  if (needs.toolCalls && !caps.toolCalls) unmet.push("tool calls");
  if (needs.reasoning && !caps.reasoning) unmet.push("reasoning");
  return unmet;
}
