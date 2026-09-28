import type { Usage } from "@hat/core";
import { usageTotal } from "@hat/core";

/**
 * Compact token label: 1048576 -> "1M", 4200 -> "4.2k", 812 -> "812".
 * Returns an empty string for zero or non-finite input so callers can hide the
 * readout entirely rather than showing a meaningless "0".
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    const rounded = millions >= 10 || Number.isInteger(millions) ? Math.round(millions) : Math.round(millions * 10) / 10;
    return `${rounded}M`;
  }
  if (tokens >= 1000) {
    const thousands = tokens / 1000;
    return `${thousands >= 100 || Number.isInteger(thousands) ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
  }
  return `${Math.round(tokens)}`;
}

/** The session's total tokens, or 0 when no provider has reported any. */
export function totalTokens(usage: Usage | null | undefined): number {
  return usageTotal(usage ?? undefined);
}

/** Spoken-form breakdown for tooltips: "1,234 in · 567 out · 1,801 total". */
export function usageDetail(usage: Usage | null | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.inputTokens) parts.push(`${usage.inputTokens.toLocaleString()} in`);
  if (usage.outputTokens) parts.push(`${usage.outputTokens.toLocaleString()} out`);
  const total = totalTokens(usage);
  if (total) parts.push(`${total.toLocaleString()} total`);
  return parts.join(" · ");
}
