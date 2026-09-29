/**
 * Incremental parser for the `text/event-stream` frames the kernel endpoints
 * emit. The whole thing is pure string-in/array-out so it can be tested
 * without a DOM, a fetch, or a running server — see `sse.test.ts`.
 *
 * It lives here rather than in any one client because the web, desktop, and
 * mobile shells all decode the same stream, and they have to agree on the
 * awkward parts:
 *   - a frame split across two network chunks (or several frames in one chunk)
 *   - multi-byte UTF-8 split mid-character between chunks
 *   - `: keepalive` comment frames, which carry no data. The server emits one
 *     every `HAT_SSE_KEEPALIVE_MS` of silence so that a turn paused on an
 *     approval still looks alive, and so proxies do not close an idle stream.
 *   - a stream that ends mid-frame, with a pending decoder flush
 */

/** One decoded SSE frame: the joined `data:` lines, or null for a comment. */
export type SseData = string | null;

/** Byte offset just past the frame terminator, or -1 when no frame is complete. */
function frameEnd(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf === -1 ? -1 : crlf + 4;
  if (crlf === -1) return lf + 2;
  return Math.min(lf + 2, crlf + 4);
}

/**
 * Extract the payload of a single frame. Per the SSE grammar only `data:`
 * fields carry a payload, and they join with newlines; everything else —
 * comments, `event:`, `id:`, `retry:` — is ignored. Returns null for frames
 * that carry no data at all.
 */
export function frameData(frame: string): SseData {
  const lines: string[] = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      if (line === "data") lines.push("");
      continue;
    }
    if (line.slice(0, colon) !== "data") continue;
    // A single leading space after the colon is part of the framing, not the value.
    const value = line.slice(colon + 1);
    lines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

export class SseFrameParser {
  private buffer = "";

  /** Feed the next chunk of decoded text; returns the payloads it completed. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    for (;;) {
      const end = frameEnd(this.buffer);
      if (end === -1) break;
      const data = frameData(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
      if (data !== null) out.push(data);
    }
    return out;
  }

  /**
   * Consume whatever is left when the stream ends. A frame still missing its
   * terminator is kept — the last event of a turn is frequently flushed
   * without one — but an empty or comment-only tail yields nothing.
   */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest.trim()) return [];
    const data = frameData(rest);
    return data === null ? [] : [data];
  }
}

/**
 * Parse a frame payload as JSON, or return null when it is not usable. A
 * truncated or non-JSON frame must not take the turn down with it.
 */
export function decodeFrame<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
