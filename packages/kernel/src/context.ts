import type { ChatMessage, Part } from "@hat/core";

/**
 * Keeping a conversation inside the model's context window.
 *
 * Every turn replays the whole active branch, so a long conversation — or a
 * few large tool outputs — eventually overflows the model and the provider
 * rejects the request outright. Before each model call the kernel estimates the
 * prompt size and, when it is over budget, first elides old tool outputs (the
 * bulk of most long agent sessions), then drops the oldest exchanges.
 *
 * Nothing here touches stored history: the trimming applies to the request
 * only, so switching to a model with a larger window brings everything back.
 *
 * Cuts are quantized to pages of the budget. A cut point that moved with every
 * new message would change the request prefix on every turn and defeat prompt
 * caching; with pages, the prefix stays byte-stable until the conversation has
 * grown by another page.
 */

/** Rough characters-per-token for mixed prose and code. Deliberately low. */
const CHARS_PER_TOKEN = 3.5;
/**
 * Chinese, Japanese and Korean run far denser: about a token a character
 * (less on some tokenizers, more on others). At 3.5 characters a token they
 * were undercounted two- to threefold, and an over-full request went out.
 */
const CJK_TOKENS_PER_CHAR = 1;
/** Flat per-message overhead (role markers, separators). */
const MESSAGE_OVERHEAD = 4;
/** What an image costs, give or take: providers bill ~1k tokens for typical sizes. */
const IMAGE_TOKENS = 1_200;
/** Tool outputs shorter than this are left alone; eliding them saves nothing. */
const MIN_ELIDE_CHARS = 400;
/** Fraction of the budget freed per page when a cut is needed. */
const PAGE_FRACTION = 0.25;

export function estimateTextTokens(text: string): number {
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Kana, CJK ideographs (with extension A), Hangul syllables, compatibility ideographs.
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      wide += 1;
    }
  }
  return Math.ceil((text.length - wide) / CHARS_PER_TOKEN + wide * CJK_TOKENS_PER_CHAR);
}

function partTokens(part: Part): number {
  switch (part.type) {
    case "text":
      return estimateTextTokens(part.text);
    case "reasoning":
      // Kept for the user to read, but never sent back to a provider.
      return 0;
    case "image":
      return IMAGE_TOKENS;
    case "file":
      return estimateTextTokens(part.name) + 16;
    case "tool_call":
      return estimateTextTokens(part.name) + estimateTextTokens(JSON.stringify(part.args ?? {}));
    case "tool_result":
      return estimateTextTokens(part.name) + part.content.reduce((sum, p) => sum + partTokens(p), 0);
  }
}

export function estimateMessageTokens(message: ChatMessage): number {
  return MESSAGE_OVERHEAD + message.parts.reduce((sum, part) => sum + partTokens(part), 0);
}

export function estimateTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/**
 * Tokens a request may spend on messages: the window, minus room for the reply,
 * minus the fixed costs (system prompt, tool schemas) the caller already knows.
 */
export function messageBudget(options: {
  contextWindow: number;
  maxOutputTokens?: number;
  fixedTokens?: number;
}): number {
  const { contextWindow } = options;
  const reply = options.maxOutputTokens ?? Math.min(8_192, Math.floor(contextWindow * 0.2));
  // A tenth held back for estimation error: the heuristic is not a tokenizer.
  return Math.max(0, Math.floor((contextWindow - reply) * 0.9) - (options.fixedTokens ?? 0));
}

export interface FitResult {
  messages: ChatMessage[];
  /** Tool outputs replaced by a placeholder. */
  elidedToolResults: number;
  /** Messages left out of the request entirely. */
  droppedMessages: number;
  /** Estimated message tokens after fitting. */
  tokens: number;
}

/**
 * Fit `messages` into `budget` estimated tokens. Returns the input untouched
 * (same array) when it already fits. Modified messages are copies; the rest
 * are shared with the input, so callers must clone before mutating.
 */
export function fitToContext(messages: ChatMessage[], budget: number): FitResult {
  const total = estimateTokens(messages);
  if (total <= budget) {
    return { messages, elidedToolResults: 0, droppedMessages: 0, tokens: total };
  }
  const page = Math.max(1, Math.floor(budget * PAGE_FRACTION));

  // 1. Elide tool outputs, oldest first. The latest round of results (every
  //    tool message after the last assistant one) is exempt: it is what the
  //    model is about to act on, parallel calls included.
  const lastRound = findLastIndex(messages, (m) => m.role === "assistant");
  const target = Math.ceil((total - budget) / page) * page;
  let saved = 0;
  let elided = 0;
  let working = messages.slice();
  for (let i = 0; i < working.length && saved < target; i++) {
    const message = working[i];
    if (message.role !== "tool" || i > lastRound) continue;
    let changed = false;
    const parts = message.parts.map((part) => {
      if (saved >= target || part.type !== "tool_result") return part;
      const size = resultChars(part.content);
      if (size < MIN_ELIDE_CHARS) return part;
      const before = partTokens(part);
      const replaced: Part = {
        ...part,
        content: [
          {
            type: "text",
            text: `[output elided to fit the context window: ${size} characters. Re-run the tool if you need it again.]`,
          },
        ],
      };
      saved += before - partTokens(replaced);
      elided += 1;
      changed = true;
      return replaced;
    });
    if (changed) working[i] = { ...message, parts };
  }

  let tokens = total - saved;
  if (tokens <= budget) {
    return { messages: working, elidedToolResults: elided, droppedMessages: 0, tokens };
  }

  // 2. Drop whole exchanges (a user message and everything up to the next),
  //    oldest first, never the last one. Leading system messages stay. A
  //    synthetic user message (Continue, the closing nudge) belongs to the
  //    exchange before it: starting one would let the reply it refers to go.
  const head = working.findIndex((m) => m.role !== "system");
  if (head === -1) return { messages: working, elidedToolResults: elided, droppedMessages: 0, tokens };
  const starts: number[] = [];
  for (let i = head; i < working.length; i++) {
    const message = working[i];
    if (message.role === "user" && !message.meta?.synthetic && (i === head || working[i - 1]?.role !== "user")) {
      starts.push(i);
    }
  }
  if (starts[0] !== head) starts.unshift(head);
  const dropTarget = Math.ceil((tokens - budget) / page) * page;
  let dropped = 0;
  let cut = head;
  for (let s = 1; s < starts.length && dropped < dropTarget; s++) {
    for (let i = starts[s - 1]; i < starts[s]; i++) dropped += estimateMessageTokens(working[i]);
    cut = starts[s];
  }
  if (cut === head) {
    return { messages: working, elidedToolResults: elided, droppedMessages: 0, tokens };
  }

  const kept = working.slice(cut);
  const note = `[${cut - head} earlier messages were left out to fit the context window.]`;
  const first = kept[0];
  kept[0] =
    first.role === "user"
      ? { ...first, parts: [{ type: "text", text: `${note}\n\n` }, ...first.parts] }
      : first;
  working = [...working.slice(0, head), ...(first.role === "user" ? [] : [noteMessage(note)]), ...kept];
  tokens = estimateTokens(working);
  return { messages: working, elidedToolResults: elided, droppedMessages: cut - head, tokens };
}

function noteMessage(text: string): ChatMessage {
  return { id: "context-note", role: "user", parts: [{ type: "text", text }], createdAt: 0 };
}

function resultChars(parts: Part[]): number {
  return parts.reduce((sum, p) => sum + (p.type === "text" ? p.text.length : 0), 0);
}

function findLastIndex<T>(list: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i])) return i;
  return -1;
}
