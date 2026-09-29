import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger, Part, ToolContext } from "@hat/core";
import type { BrowserController, PageSnapshot } from "./browser.js";
import { createBrowserTool, formatSnapshot } from "./index.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function toolContext(): ToolContext {
  return {
    sessionId: "s1",
    host: {} as ToolContext["host"],
    secrets: { get: async () => undefined },
    approval: { request: async () => "approve" },
    audit: { record() {} },
    logger,
    signal: new AbortController().signal,
  };
}

function textOf(parts: Part[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

const snapshot = (url = "https://example.com"): PageSnapshot => ({
  title: "Example",
  url,
  text: "Hello world",
  links: [{ text: "More", href: "https://example.com/more" }],
});

class FakeController implements BrowserController {
  calls: string[] = [];
  async open(_s: string, url: string): Promise<PageSnapshot> {
    this.calls.push(`open:${url}`);
    return snapshot(url);
  }
  async read(): Promise<PageSnapshot> {
    this.calls.push("read");
    return snapshot();
  }
  async click(_s: string, selector: string): Promise<PageSnapshot> {
    this.calls.push(`click:${selector}`);
    return snapshot();
  }
  async type(_s: string, selector: string, text: string): Promise<PageSnapshot> {
    this.calls.push(`type:${selector}:${text}`);
    return snapshot();
  }
  async press(_s: string, key: string, selector?: string): Promise<PageSnapshot> {
    this.calls.push(`press:${key}:${selector ?? ""}`);
    return snapshot();
  }
  async screenshot(): Promise<Buffer> {
    this.calls.push("screenshot");
    return Buffer.from("png-bytes");
  }
  async back(): Promise<PageSnapshot> {
    this.calls.push("back");
    return snapshot();
  }
  async close(): Promise<void> {
    this.calls.push("close");
  }
  async dispose(): Promise<void> {}
}

test("formatSnapshot includes title, url, text and numbered links", () => {
  const parts = formatSnapshot(snapshot(), "Opened");
  const text = textOf(parts);
  assert.match(text, /Opened/);
  assert.match(text, /Title: Example/);
  assert.match(text, /URL: https:\/\/example\.com/);
  assert.match(text, /Hello world/);
  assert.match(text, /1\. More — https:\/\/example\.com\/more/);
});

test("browser tool requires approval only for mutating actions", () => {
  const tool = createBrowserTool({ controller: new FakeController() });
  const needs = tool.requiresApproval as (args: unknown) => boolean;
  assert.equal(needs({ action: "open" }), false);
  assert.equal(needs({ action: "read" }), false);
  assert.equal(needs({ action: "screenshot" }), false);
  assert.equal(needs({ action: "click" }), true);
  assert.equal(needs({ action: "type" }), true);
  assert.equal(needs({ action: "press" }), true);
});

test("browser tool approval can be overridden by config", () => {
  const always = createBrowserTool({ controller: new FakeController(), requireApproval: true });
  const never = createBrowserTool({ controller: new FakeController(), requireApproval: false });
  assert.equal((always.requiresApproval as (a: unknown) => boolean)({ action: "read" }), true);
  assert.equal((never.requiresApproval as (a: unknown) => boolean)({ action: "click" }), false);
});

test("browser tool dispatches actions and formats results", async () => {
  const controller = new FakeController();
  const tool = createBrowserTool({ controller });
  const opened = await tool.execute({ action: "open", url: "https://site.test/page" }, toolContext());
  assert.match(textOf(opened), /Opened https:\/\/site\.test\/page/);
  await tool.execute({ action: "click", selector: "#go" }, toolContext());
  await tool.execute({ action: "type", selector: "input", text: "hi" }, toolContext());
  await tool.execute({ action: "press", key: "Enter", selector: "input" }, toolContext());
  await tool.execute({ action: "close" }, toolContext());
  assert.deepEqual(controller.calls, [
    "open:https://site.test/page",
    "click:#go",
    "type:input:hi",
    "press:Enter:input",
    "close",
  ]);
});

test("browser screenshot returns an image part", async () => {
  const tool = createBrowserTool({ controller: new FakeController() });
  const parts = await tool.execute({ action: "screenshot" }, toolContext());
  const image = parts.find((part) => part.type === "image");
  assert.ok(image && image.type === "image");
  if (image.type === "image") {
    assert.equal(image.source.kind, "data");
    if (image.source.kind === "data") {
      assert.equal(image.source.mime, "image/png");
      assert.equal(Buffer.from(image.source.data, "base64").toString(), "png-bytes");
    }
  }
});

test("browser tool rejects non-http URLs and missing arguments as text", async () => {
  const controller = new FakeController();
  const tool = createBrowserTool({ controller });
  const file = await tool.execute({ action: "open", url: "file:///etc/passwd" }, toolContext());
  assert.match(textOf(file), /only http\(s\) URLs are supported/);
  const missing = await tool.execute({ action: "click" }, toolContext());
  assert.match(textOf(missing), /requires a selector/);
  assert.deepEqual(controller.calls, []);
});
