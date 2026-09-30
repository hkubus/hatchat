import { allowedPrivateHosts, assertPublicUrl } from "@hat/net-guard";

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FetchOptions {
  /** Host names that may be private (`HAT_ALLOW_PRIVATE_HOSTS`). */
  allowHosts?: readonly string[];
  timeoutMs?: number;
  /** Bytes of body kept; the rest is not read at all. */
  maxBytes?: number;
}

const MAX_REDIRECTS = 5;

/**
 * `net.fetch` for the server (`web_fetch`, and plugins with `runner:net`).
 * The URL comes from a model, so every hop has to be public (see
 * `@hat/net-guard`): redirects are followed here, one checked URL at a time,
 * rather than by `fetch`, which would follow one straight into the metadata
 * service or a local port.
 */
export async function runFetch(
  url: string,
  method: string | undefined,
  headers: Record<string, string> | undefined,
  body: string | undefined,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const allowHosts = options.allowHosts ?? allowedPrivateHosts();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  let current = url;
  let currentMethod = method ?? "GET";
  let currentBody = body;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        await assertPublicUrl(current, { allowHosts });
      } catch (error) {
        throw new Error(`fetch blocked: ${(error as Error).message}`);
      }
      const response = await fetch(current, {
        method: currentMethod,
        headers,
        body: currentBody,
        signal: controller.signal,
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        current = new URL(location, current).href;
        // As browsers do: a 303, or a 301/302 after a POST, continues as a GET.
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
          currentMethod = "GET";
          currentBody = undefined;
        }
        continue;
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      // Capped while reading, so a huge body neither fills memory nor the link.
      const text = await readCapped(response, options.maxBytes ?? 2_000_000);
      return { status: response.status, headers: responseHeaders, body: text };
    }
    throw new Error(`fetch blocked: more than ${MAX_REDIRECTS} redirects`);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const room = maxBytes - size;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    size += Math.min(value.byteLength, room);
    if (size >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
