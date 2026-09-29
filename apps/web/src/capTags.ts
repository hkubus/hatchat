import type { ModelInfo, ProviderCapabilities } from "@hat/core";

export interface CapTag {
  key: string;
  label: string;
  title: string;
}

/**
 * Compact context-window label: 1048576 -> "1M", 200000 -> "200k", 8192 -> "8k".
 * Deliberately rounds to whole thousands, unlike the measured counts in
 * `tokens.ts`: a window is an advertised round number, so "8k" reads truer than
 * "8.2k".
 */
export function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const rounded = millions >= 10 || Number.isInteger(millions) ? Math.round(millions) : Math.round(millions * 10) / 10;
    return `${rounded}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

/** The capability chips shown against a model, in a stable order. */
export function capTags(caps: ProviderCapabilities): CapTag[] {
  const tags: CapTag[] = [];
  if (caps.toolCalls) tags.push({ key: "tools", label: "tools", title: "Can call tools" });
  if (caps.vision) tags.push({ key: "vision", label: "vision", title: "Accepts image input" });
  if (caps.jsonMode) tags.push({ key: "json", label: "json", title: "Supports JSON mode" });
  return tags;
}

/** Context window, rendered as its own dim label rather than a capability chip. */
export function contextTag(contextWindow?: number): CapTag | undefined {
  if (!contextWindow) return undefined;
  return {
    key: "ctx",
    label: formatContext(contextWindow),
    title: `${contextWindow.toLocaleString()} token context window`,
  };
}
