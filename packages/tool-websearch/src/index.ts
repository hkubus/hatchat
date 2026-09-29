import type { Part, Plugin, Tool } from "@hat/core";
import { z } from "zod";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type SearchBackend = "duckduckgo" | "searxng";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export const webSearchConfigSchema = z.object({
  backend: z
    .enum(["duckduckgo", "searxng"])
    .optional()
    .describe(
      "Search backend. duckduckgo is keyless; searxng points at your own instance.",
    ),
  searxngUrl: z
    .string()
    .optional()
    .describe(
      'Base URL of a SearXNG instance with the JSON output format enabled, e.g. "https://searx.example.com" (required for the searxng backend).',
    ),
  maxResults: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Maximum results returned when the model does not ask for a limit (default 5)."),
  requireApproval: z
    .boolean()
    .optional()
    .describe("Ask before each search (searches are read-only; default is no)."),
});

const searchSchema = z.object({
  query: z.string().min(1).describe("Search query."),
  limit: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Maximum number of results to return (default 5, max 20)."),
});

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  divide: "÷",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code =
        entity.startsWith("#x") || entity.startsWith("#X")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** DDG wraps result links as //duckduckgo.com/l/?uddg=<encoded>&rut=... */
export function unwrapDuckDuckGoUrl(href: string): string {
  const withScheme = href.startsWith("//")
    ? `https:${href}`
    : href.startsWith("/")
      ? `https://duckduckgo.com${href}`
      : href;
  try {
    const url = new URL(withScheme);
    if (url.hostname.endsWith("duckduckgo.com") && url.pathname === "/l/") {
      const target = url.searchParams.get("uddg");
      if (target) return target;
    }
    return withScheme;
  } catch {
    return href;
  }
}

/**
 * Best-effort parse of DuckDuckGo's keyless endpoints. It is intentionally
 * dependency-free: find each result anchor (`result__a` on the html endpoint,
 * `result-link` on lite) and take the nearest following snippet. DDG can change
 * its markup, so callers should treat an empty result as "no answer" rather
 * than a hard failure.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  interface Anchor {
    attrs: string;
    inner: string;
    index: number;
    end: number;
  }
  const anchors: Anchor[] = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html))) {
    if (/class="[^"]*(?:result__a|result-link)/i.test(match[1])) {
      anchors.push({
        attrs: match[1],
        inner: match[2],
        index: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  const results: SearchResult[] = [];
  for (let i = 0; i < anchors.length && results.length < limit; i++) {
    const anchor = anchors[i];
    const href = /\bhref="([^"]*)"/i.exec(anchor.attrs)?.[1];
    const title = stripTags(anchor.inner);
    if (!href || !title) continue;
    const segment = html.slice(anchor.end, anchors[i + 1]?.index ?? html.length);
    const snippetHtml =
      /<(?:a|div|span|td)\b[^>]*class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i.exec(
        segment,
      )?.[1];
    results.push({
      title,
      url: unwrapDuckDuckGoUrl(decodeEntities(href)),
      snippet: snippetHtml ? stripTags(snippetHtml) : undefined,
    });
  }
  return results;
}

export function mapSearxngResults(payload: unknown, limit: number): SearchResult[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  for (const item of results) {
    const record = item as { title?: unknown; url?: unknown; content?: unknown };
    if (typeof record.title !== "string" || typeof record.url !== "string") continue;
    const snippet = typeof record.content === "string" ? record.content.trim() : "";
    out.push({ title: record.title, url: record.url, snippet: snippet || undefined });
    if (out.length >= limit) break;
  }
  return out;
}

export function formatResults(query: string, results: SearchResult[]): Part[] {
  if (results.length === 0) {
    return [{ type: "text", text: `No web results found for "${query}".` }];
  }
  const lines = results.map((result, index) => {
    const snippet = result.snippet ? `\n   ${result.snippet}` : "";
    return `${index + 1}. ${result.title}\n   ${result.url}${snippet}`;
  });
  return [{ type: "text", text: `Web results for "${query}":\n\n${lines.join("\n\n")}` }];
}

const DDG_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/x-www-form-urlencoded",
  origin: "https://duckduckgo.com",
  referer: "https://duckduckgo.com/",
  "user-agent": USER_AGENT,
};

async function fetchDuckDuckGoPage(
  endpoint: string,
  query: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: DDG_HEADERS,
    body: new URLSearchParams({ q: query, kl: "wt-wt" }).toString(),
    signal,
  });
  // DDG answers scripted traffic with `202 Accepted` and an anomaly page instead
  // of results, even though it is a 2xx status.
  if (!response.ok || response.status === 202) {
    throw new Error(`DuckDuckGo returned HTTP ${response.status}`);
  }
  return response.text();
}

async function duckduckgoSearch(
  query: string,
  limit: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  // The html endpoint is richer but blocked more aggressively; lite is the
  // fallback when it returns an empty or challenge page.
  const endpoints = ["https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"];
  let lastError: Error | undefined;
  for (const endpoint of endpoints) {
    try {
      const results = parseDuckDuckGoHtml(
        await fetchDuckDuckGoPage(endpoint, query, fetchImpl, signal),
        limit,
      );
      if (results.length > 0) return results;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  if (lastError) throw lastError;
  return [];
}

async function searxngSearch(
  baseUrl: string,
  query: string,
  limit: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<SearchResult[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/search?${new URLSearchParams({
    q: query,
    format: "json",
  }).toString()}`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal,
  });
  if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
  return mapSearxngResults(await response.json(), limit);
}

export interface WebSearchToolOptions {
  backend?: SearchBackend;
  searxngUrl?: string;
  maxResults?: number;
  requireApproval?: boolean;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export function createWebSearchTool(options: WebSearchToolOptions = {}): Tool {
  const backend = options.backend ?? "duckduckgo";
  const fetchImpl = options.fetch ?? fetch;
  const defaultLimit = options.maxResults ?? 5;

  return {
    name: "web_search",
    description:
      "Search the web and return ranked results (title, URL, snippet). Use for current " +
      "events, documentation, and facts not in the conversation. Follow up with another " +
      "tool or fetch to read a result in full.",
    schema: searchSchema,
    requiresApproval: options.requireApproval ?? false,
    async execute(raw, ctx): Promise<Part[]> {
      const args = searchSchema.parse(raw);
      const limit = args.limit ?? defaultLimit;
      try {
        const results =
          backend === "searxng"
            ? await searxngSearch(
                options.searxngUrl ?? "",
                args.query,
                limit,
                fetchImpl,
                ctx.signal,
              )
            : await duckduckgoSearch(args.query, limit, fetchImpl, ctx.signal);
        ctx.logger.debug(`web_search "${args.query}" (${backend}): ${results.length} result(s)`);
        return formatResults(args.query, results);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`web_search failed (${backend})`, message);
        return [{ type: "text", text: `Web search failed: ${message}` }];
      }
    },
  };
}

export function createWebSearchPlugin(): Plugin {
  return {
    id: "websearch",
    name: "Web search",
    version: "0.1.0",
    description:
      "Add a web_search tool backed by keyless DuckDuckGo or a self-hosted SearXNG instance.",
    permissions: ["net:https"],
    configSchema: webSearchConfigSchema,
    activate(ctx) {
      const config = ctx.getConfig<z.infer<typeof webSearchConfigSchema>>();
      const backend = config.backend ?? "duckduckgo";
      if (backend === "searxng" && !config.searxngUrl?.trim()) {
        throw new Error('config: searxngUrl is required when backend is "searxng"');
      }
      ctx.register.tool(
        createWebSearchTool({
          backend,
          searxngUrl: config.searxngUrl,
          maxResults: config.maxResults,
          requireApproval: config.requireApproval,
        }),
      );
    },
  };
}
