import type { Part, Plugin, Tool } from "@hat/core";
import { z } from "zod";
import { BrowserManager, type BrowserController, type PageSnapshot } from "./browser.js";

const MUTATING_ACTIONS = ["click", "type", "press"] as const;

export const browserConfigSchema = z.object({
  executablePath: z
    .string()
    .optional()
    .describe(
      "Path to a Chromium/Chrome binary. Leave blank to use the Playwright browser cache. Can also be set with HAT_BROWSER_PATH.",
    ),
  headless: z.boolean().optional().describe("Run without a visible window (default true)."),
  maxTextChars: z
    .number()
    .int()
    .positive()
    .max(50_000)
    .optional()
    .describe("Maximum characters of page text returned per action (default 8000)."),
  maxLinks: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Maximum links returned per action (default 50)."),
  idleTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(3_600_000)
    .optional()
    .describe("Close a conversation's browser page after this idle time (default 300000 = 5 min)."),
  navigationTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe("Per-action timeout (default 30000)."),
  requireApproval: z
    .boolean()
    .optional()
    .describe(
      "Override approval: true for every action, false for none. Default asks only for click/type/press.",
    ),
});

const browserSchema = z.object({
  action: z
    .enum(["open", "read", "click", "type", "press", "screenshot", "back", "close"])
    .describe(
      "open: navigate to url. read: re-read the current page (after a click). click: click selector. " +
        "type: fill selector with text. press: press key (optionally focused on selector). " +
        "screenshot: full-page PNG. back: history back. close: end the browser session.",
    ),
  url: z.string().optional().describe("Absolute http(s) URL to open (required for action=open)."),
  selector: z
    .string()
    .optional()
    .describe(
      'Playwright selector: CSS ("#id", "button.submit") or text ("text=Sign in", "role=button[name=Next]"). Required for click/type.',
    ),
  text: z.string().optional().describe("Text to enter (required for action=type)."),
  key: z
    .string()
    .optional()
    .describe('Key to press, e.g. "Enter", "Tab", "ArrowDown" (required for action=press).'),
});

export interface BrowserToolOptions {
  controller: BrowserController;
  requireApproval?: boolean;
}

function textPart(text: string): Part {
  return { type: "text", text };
}

export function formatSnapshot(snapshot: PageSnapshot, note?: string): Part[] {
  const lines: string[] = [];
  if (note) lines.push(note);
  lines.push(`Title: ${snapshot.title || "(untitled)"}`);
  lines.push(`URL: ${snapshot.url}`);
  if (snapshot.text) {
    lines.push("");
    lines.push(snapshot.text);
  }
  if (snapshot.links.length > 0) {
    lines.push("");
    lines.push("Links:");
    for (const [index, link] of snapshot.links.entries()) {
      lines.push(`${index + 1}. ${link.text} — ${link.href}`);
    }
  }
  return [textPart(lines.join("\n"))];
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a valid absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`only http(s) URLs are supported, got "${parsed.protocol}"`);
  }
}

export function createBrowserTool(options: BrowserToolOptions): Tool {
  return {
    name: "browser",
    description:
      "Drive a headless web browser. Use it to read pages that need JavaScript, follow links, " +
      "and fill forms. Start with action=open, then interact with click/type/press and re-read " +
      "with action=read. Returns the page title, URL, visible text and links; screenshot returns an image.",
    schema: browserSchema,
    requiresApproval: (args) => {
      if (options.requireApproval !== undefined) return options.requireApproval;
      const action = (args as { action?: string } | null)?.action;
      return action !== undefined && (MUTATING_ACTIONS as readonly string[]).includes(action);
    },
    async execute(raw, ctx): Promise<Part[]> {
      const args = browserSchema.parse(raw);
      try {
        switch (args.action) {
          case "open": {
            if (!args.url) throw new Error('action "open" requires a url');
            assertHttpUrl(args.url);
            return formatSnapshot(await options.controller.open(ctx.sessionId, args.url), `Opened ${args.url}`);
          }
          case "read":
            return formatSnapshot(await options.controller.read(ctx.sessionId));
          case "click": {
            if (!args.selector) throw new Error('action "click" requires a selector');
            return formatSnapshot(
              await options.controller.click(ctx.sessionId, args.selector),
              `Clicked ${args.selector}`,
            );
          }
          case "type": {
            if (!args.selector) throw new Error('action "type" requires a selector');
            if (args.text === undefined) throw new Error('action "type" requires text');
            return formatSnapshot(
              await options.controller.type(ctx.sessionId, args.selector, args.text),
              `Typed into ${args.selector}`,
            );
          }
          case "press": {
            if (!args.key) throw new Error('action "press" requires a key');
            return formatSnapshot(
              await options.controller.press(ctx.sessionId, args.key, args.selector),
              `Pressed ${args.key}${args.selector ? ` on ${args.selector}` : ""}`,
            );
          }
          case "screenshot": {
            const image = await options.controller.screenshot(ctx.sessionId);
            return [
              textPart("Screenshot of the current page:"),
              { type: "image", source: { kind: "data", data: image.toString("base64"), mime: "image/png" } },
            ];
          }
          case "back":
            return formatSnapshot(await options.controller.back(ctx.sessionId), "Went back");
          case "close":
            await options.controller.close(ctx.sessionId);
            return [textPart("Browser session closed.")];
        }
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`browser ${args.action} failed`, message);
        return [textPart(`Browser action "${args.action}" failed: ${message}`)];
      }
    },
  };
}

export function createBrowserPlugin(): Plugin {
  let manager: BrowserManager | undefined;

  return {
    id: "browser",
    name: "Browser",
    version: "0.1.0",
    description:
      "Drive a headless Chromium via Playwright to open, read, click, type and screenshot web pages.",
    permissions: ["net:https", "browser:playwright"],
    configSchema: browserConfigSchema,
    activate(ctx) {
      const config = ctx.getConfig<z.infer<typeof browserConfigSchema>>();
      manager = new BrowserManager({
        executablePath: config.executablePath?.trim() || process.env.HAT_BROWSER_PATH || undefined,
        headless: config.headless ?? true,
        idleTimeoutMs: config.idleTimeoutMs ?? 300_000,
        navigationTimeoutMs: config.navigationTimeoutMs ?? 30_000,
        maxTextChars: config.maxTextChars ?? 8_000,
        maxLinks: config.maxLinks ?? 50,
      });
      ctx.register.tool(
        createBrowserTool({ controller: manager, requireApproval: config.requireApproval }),
      );
    },
    async deactivate() {
      await manager?.dispose();
      manager = undefined;
    },
    async sessionDeleted(sessionId) {
      await manager?.close(sessionId);
    },
  };
}

export { BrowserManager } from "./browser.js";
export type { PageSnapshot } from "./browser.js";
