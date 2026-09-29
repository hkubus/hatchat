import type { Part, Plugin, Tool } from "@hat/core";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { z } from "zod";

const DEFAULT_MAX_CHARS = 15_000;

const schema = z.object({
  url: z.string().describe("Absolute http(s) URL to fetch."),
  max_chars: z
    .number()
    .int()
    .positive()
    .max(19_000)
    .optional()
    .describe(`Maximum characters of content to return (default ${DEFAULT_MAX_CHARS}).`),
  start_index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Character offset to start from, to page through a long document."),
  raw: z
    .boolean()
    .optional()
    .describe("Return the whole page as markdown instead of just the main article content."),
});

export interface ConvertedPage {
  title?: string;
  markdown: string;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
const DROPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "SVG", "FORM", "BUTTON"]);
turndown.remove((node) => DROPPED_TAGS.has(node.nodeName.toUpperCase()));

/**
 * Turn an HTML page into markdown. By default Readability extracts the main
 * article (dropping nav, ads and footers); pages it can't parse, or `raw`
 * requests, convert the whole body instead.
 */
export function htmlToMarkdown(html: string, url: string, raw = false): ConvertedPage {
  const { document } = parseHTML(html);
  const title = document.querySelector("title")?.textContent?.trim() || undefined;

  // Resolve relative links so the model can follow them.
  for (const anchor of document.querySelectorAll("a[href]")) {
    try {
      anchor.setAttribute("href", new URL(anchor.getAttribute("href") ?? "", url).href);
    } catch {
      /* leave malformed hrefs alone */
    }
  }

  if (!raw) {
    try {
      const article = new Readability(document as unknown as Document).parse();
      if (article?.content && (article.textContent?.trim().length ?? 0) > 200) {
        return { title: article.title || title, markdown: tidy(turndown.turndown(article.content)) };
      }
    } catch {
      /* fall back to the whole body */
    }
  }
  const body = document.querySelector("body")?.innerHTML ?? html;
  return { title, markdown: tidy(turndown.turndown(body)) };
}

function tidy(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

export function createWebFetchTool(): Tool {
  return {
    name: "web_fetch",
    description:
      "Fetch a web page or text resource and return it as markdown (main article content by " +
      "default). Use it to read a URL from search results or the user. Cheaper and faster than " +
      "the browser; use the browser only for pages that need JavaScript or interaction.",
    schema,
    requiresApproval: false,
    async execute(raw, ctx): Promise<Part[]> {
      const args = schema.parse(raw);
      let parsed: URL;
      try {
        parsed = new URL(args.url);
      } catch {
        throw new Error(`"${args.url}" is not a valid absolute URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`only http(s) URLs are supported, got "${parsed.protocol}"`);
      }

      const response = await ctx.host.net.fetch(parsed.href, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; hat-web-fetch/0.1)",
          accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
        },
      });
      const contentType = (response.headers["content-type"] ?? "").toLowerCase();
      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status} fetching ${parsed.href}`);
      }
      if (/^(image|audio|video)\/|application\/(pdf|zip|octet-stream)/.test(contentType)) {
        throw new Error(
          `${parsed.href} is ${contentType}, not text. Download it with shell_exec (curl) to work with it.`,
        );
      }

      let title: string | undefined;
      let content: string;
      if (contentType.includes("html") || (!contentType && /^\s*<(!doctype|html)/i.test(response.body))) {
        ({ title, markdown: content } = htmlToMarkdown(response.body, parsed.href, args.raw));
      } else if (contentType.includes("json")) {
        try {
          content = JSON.stringify(JSON.parse(response.body), null, 2);
        } catch {
          content = response.body;
        }
      } else {
        content = response.body;
      }

      const start = args.start_index ?? 0;
      const max = args.max_chars ?? DEFAULT_MAX_CHARS;
      const slice = content.slice(start, start + max);
      const header = [`URL: ${parsed.href}`, title ? `Title: ${title}` : undefined]
        .filter(Boolean)
        .join("\n");
      const parts: Part[] = [{ type: "text", text: `${header}\n\n${slice || "(no content)"}` }];
      if (start + max < content.length) {
        parts.push({
          type: "text",
          text: `\n\n[showing ${start}-${start + slice.length} of ${content.length} chars; continue with start_index=${start + slice.length}]`,
        });
      }
      return parts;
    },
  };
}

export function createWebFetchPlugin(): Plugin {
  return {
    id: "web-fetch",
    name: "Web fetch",
    version: "0.1.0",
    description: "Fetch a URL through the runner and return it as readable markdown.",
    permissions: ["runner:net"],
    activate(ctx) {
      ctx.register.tool(createWebFetchTool());
    },
  };
}
