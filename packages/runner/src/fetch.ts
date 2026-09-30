import type { LookupAddress, LookupAllOptions, LookupOneOptions } from "node:dns";
import { isIP } from "node:net";
import { BlockedUrlError, allowedPrivateHosts, assertPublicUrl, resolvePublicAddresses } from "@hat/net-guard";
import { Agent, fetch } from "undici";

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
  /** Resolve a host name to every address it has (tests replace this). */
  resolve?: (hostname: string) => Promise<string[]>;
}

const MAX_REDIRECTS = 5;

/**
 * Headers that carry the caller's credentials. Like `fetch` itself, they are
 * not sent on to another origin a redirect points at: a token meant for one
 * API must not reach whichever site that API (or a page) redirects to.
 */
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
/** Headers that describe a request body, dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = new Set(["content-type", "content-length", "content-encoding", "content-language", "content-location"]);

/**
 * `net.fetch` for the server (`web_fetch`, and plugins with `runner:net`).
 * The URL comes from a model, so every hop has to be public (see
 * `@hat/net-guard`): redirects are followed here, one checked URL at a time,
 * rather than by `fetch`, which would follow one straight into the metadata
 * service or a local port. The connection resolves the host name through the
 * same check, so a DNS answer that changes between the check and the connect
 * (DNS rebinding) can't steer it to a private address either.
 */
export async function runFetch(
  url: string,
  method: string | undefined,
  headers: Record<string, string> | undefined,
  body: string | undefined,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const allowHosts = options.allowHosts ?? allowedPrivateHosts();
  const guard = { allowHosts, resolve: options.resolve };
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(guard) } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  let current = url;
  let currentMethod = method ?? "GET";
  let currentBody = body;
  let currentHeaders = { ...headers };
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        await assertPublicUrl(current, guard);
      } catch (error) {
        throw new Error(`fetch blocked: ${(error as Error).message}`);
      }
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetch(current, {
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          signal: controller.signal,
          redirect: "manual",
          dispatcher,
        });
      } catch (error) {
        const blocked = blockedCause(error);
        if (blocked) throw new Error(`fetch blocked: ${blocked.message}`);
        throw error;
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        const next = new URL(location, current);
        if (next.origin !== new URL(current).origin) {
          currentHeaders = without(currentHeaders, CREDENTIAL_HEADERS);
        }
        current = next.href;
        // As browsers do: a 303, or a 301/302 after a POST, continues as a GET.
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
          currentMethod = "GET";
          currentBody = undefined;
          currentHeaders = without(currentHeaders, BODY_HEADERS);
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
    void dispatcher.destroy().catch(() => undefined);
  }
}

type LookupCallback = (error: Error | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A `dns.lookup` for the connection: it resolves through the public-address
 * check and hands the connection only the addresses that passed.
 */
function guardedLookup(guard: { allowHosts: readonly string[]; resolve?: (hostname: string) => Promise<string[]> }) {
  return (hostname: string, options: LookupOneOptions | LookupAllOptions, callback: LookupCallback): void => {
    resolvePublicAddresses(hostname, guard).then(
      (addresses) => {
        let entries = addresses.map((address) => ({ address, family: isIP(address) }));
        const family = typeof options.family === "number" ? options.family : 0;
        if (family === 4 || family === 6) {
          const matching = entries.filter((entry) => entry.family === family);
          if (matching.length > 0) entries = matching;
        }
        if (options.all) callback(null, entries);
        else callback(null, entries[0].address, entries[0].family);
      },
      (error: Error) => callback(error, ""),
    );
  };
}

/** The `BlockedUrlError` somewhere in an error's `cause` chain, if any. */
function blockedCause(error: unknown): BlockedUrlError | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof BlockedUrlError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function without(headers: Record<string, string>, names: ReadonlySet<string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !names.has(name.toLowerCase())));
}

async function readCapped(response: Awaited<ReturnType<typeof fetch>>, maxBytes: number): Promise<string> {
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
