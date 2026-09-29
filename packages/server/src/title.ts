import type { ChatMessage, Logger } from "@hat/core";
import { newId, normalizeError } from "@hat/core";
import type { ProviderRegistry } from "@hat/kernel";

/**
 * The instruction sent for a titling call. Exported so `FakeProvider` can spot
 * a titling request and answer it without an API key.
 */
export const TITLE_SYSTEM_PROMPT =
  "You name conversations. Reply with a title of at most six words for the " +
  "message below. No quotes, no trailing punctuation, no explanation.";

const MAX_TITLE_LENGTH = 80;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface TitleOptions {
  providers: ProviderRegistry;
  /** The session's model; its provider makes the call. */
  model: string;
  /** The text to name — normally the first user message. */
  subject: string;
  logger: Logger;
  timeoutMs?: number;
}

function chatMessage(role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id: newId("msg"),
    role,
    parts: [{ type: "text", text }],
    createdAt: Date.now(),
  };
}

/**
 * Models like to wrap a title in quotes, prefix it with "Title:", or trail off
 * into commentary. Keep the first line and strip the decoration.
 */
function tidy(raw: string): string | undefined {
  const firstLine = raw.split("\n")[0] ?? "";
  const cleaned = firstLine
    .replace(/^\s*(?:title|conversation)\s*:\s*/i, "")
    .replace(/^["'`*_\s]+|["'`*_.,:;!?\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Ask the session's own model for a short title. Returns undefined on any
 * failure: a missing title is a cosmetic problem and must never surface as an
 * error on the turn, so every throw is swallowed and logged.
 */
export async function generateTitle(options: TitleOptions): Promise<string | undefined> {
  const { providers, model, subject, logger } = options;
  const trimmedSubject = subject.trim();
  if (!trimmedSubject) return undefined;

  // Mirrors capabilitiesFor(): a session can name a model whose provider
  // plugin has since been disabled.
  let provider;
  let bareModel: string;
  try {
    ({ provider, model: bareModel } = providers.resolve(model));
  } catch {
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let text = "";

  try {
    for await (const event of provider.chat(
      {
        model: bareModel,
        messages: [
          chatMessage("system", TITLE_SYSTEM_PROMPT),
          // The raw subject, not an instruction wrapping it: providers that
          // quote their input verbatim produce a far better title. Capped
          // short — a title never needs 4k of context.
          chatMessage("user", trimmedSubject.slice(0, 500)),
        ],
        maxTokens: 24,
        temperature: 0,
      },
      controller.signal,
    )) {
      if (event.type === "text.delta") text += event.text;
      if (event.type === "error") return undefined;
    }
  } catch (error) {
    logger.warn("title generation failed", normalizeError(error, "title_error"));
    return undefined;
  } finally {
    clearTimeout(timer);
  }

  const title = tidy(text);
  if (!title) logger.warn("title generation produced no usable title");
  return title;
}
