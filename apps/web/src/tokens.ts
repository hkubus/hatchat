import type { Usage } from "@hat/core";
import { cacheHitRate, usageTotal } from "@hat/core";

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

/** Spoken-form breakdown for tooltips: "1,234 in · 567 out · 1,801 total · 1,000 cached (81%)". */
export function usageDetail(usage: Usage | null | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.inputTokens) parts.push(`${usage.inputTokens.toLocaleString()} in`);
  if (usage.outputTokens) parts.push(`${usage.outputTokens.toLocaleString()} out`);
  const total = totalTokens(usage);
  if (total) parts.push(`${total.toLocaleString()} total`);
  const cached = formatCachedDetail(usage);
  if (cached) parts.push(cached);
  return parts.join(" · ");
}

/** "1,000 cached (81%)", "1,000 cached", or "" when the provider reported nothing. */
export function formatCachedDetail(usage: Usage | null | undefined): string {
  if (!usage || usage.cachedTokens === undefined) return "";
  const count = `${usage.cachedTokens.toLocaleString()} cached`;
  const rate = cacheHitRate(usage);
  return rate === undefined ? count : `${count} (${formatCacheHitRate(rate)})`;
}

/** Compact "81%" label for a hit rate, or "" when unknown. */
export function formatCacheHitRate(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return "";
  return `${Math.round(rate * 100)}%`;
}

/** Hit-rate label for a usage figure: "81% cached" or "" when unknown. */
export function cacheHitLabel(usage: Usage | null | undefined): string {
  if (!usage) return "";
  const label = formatCacheHitRate(cacheHitRate(usage));
  return label ? `${label} cached` : "";
}
