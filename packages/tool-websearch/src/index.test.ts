import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger, Part, PluginContext, ToolContext } from "@hat/core";
import {
  createWebSearchPlugin,
  createWebSearchTool,
  decodeEntities,
  mapSearxngResults,
  parseDuckDuckGoHtml,
  unwrapDuckDuckGoUrl,
} from "./index.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function toolContext(signal = new AbortController().signal): ToolContext {
  return {
    sessionId: "s1",
    host: {} as ToolContext["host"],
    secrets: { get: async () => undefined },
    approval: { request: async () => "approve" },
    audit: { record() {} },
    logger,
    signal,
  };
}

function textOf(parts: Part[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function pluginContext(config: unknown, registered: string[]): PluginContext {
  return {
    pluginId: "websearch",
    register: { provider() {}, tool: (tool) => registered.push(tool.name) },
    getConfig: <T,>() => config as T,
    secrets: { get: async () => undefined },
    logger,
  };
}

const DDG_HTML = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha&amp;rut=abc">Alpha &amp; Omega</a>
  <a class="result__snippet" href="https://example.com/alpha">The <b>first</b> result &mdash; useful.</a>
</div>
<div class="result">
  <a class="result__a" href="https://example.org/beta">Beta</a>
</div>
`;

test("decodeEntities handles named, decimal and hex entities", () => {
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &#65; &#x42;"), "a & b <c> A B");
});

test("unwrapDuckDuckGoUrl decodes redirects and leaves direct URLs", () => {
  assert.equal(
    unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx&rut=1"),
    "https://example.com/x",
  );
  assert.equal(unwrapDuckDuckGoUrl("https://example.org/beta"), "https://example.org/beta");
  assert.equal(unwrapDuckDuckGoUrl("//example.net/rel"), "https://example.net/rel");
});

test("parseDuckDuckGoHtml pairs titles with the nearest snippet", () => {
  const results = parseDuckDuckGoHtml(DDG_HTML, 10);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Alpha & Omega");
  assert.equal(results[0].url, "https://example.com/alpha");
  assert.equal(results[0].snippet, "The first result — useful.");
  assert.equal(results[1].title, "Beta");
  assert.equal(results[1].url, "https://example.org/beta");
  assert.equal(results[1].snippet, undefined);
});

test("parseDuckDuckGoHtml respects the limit", () => {
  assert.equal(parseDuckDuckGoHtml(DDG_HTML, 1).length, 1);
});

test("mapSearxngResults normalizes fields and drops malformed rows", () => {
  const results = mapSearxngResults(
    {
      results: [
        { title: "One", url: "https://one.example", content: "  snippet one  " },
        { title: "No URL" },
        { url: "https://no-title.example" },
        { title: "Two", url: "https://two.example" },
      ],
    },
    5,
  );
  assert.deepEqual(results, [
    { title: "One", url: "https://one.example", snippet: "snippet one" },
    { title: "Two", url: "https://two.example", snippet: undefined },
  ]);
});

test("web_search tool searches via DuckDuckGo by default", async () => {
  let requestedUrl = "";
  const fetchStub = (async (input: string | URL) => {
    requestedUrl = String(input);
    return new Response(DDG_HTML, { status: 200 });
  }) as unknown as typeof fetch;

  const tool = createWebSearchTool({ fetch: fetchStub });
  const parts = await tool.execute({ query: "alpha" }, toolContext());
  assert.equal(requestedUrl, "https://html.duckduckgo.com/html/");
  assert.match(textOf(parts), /Web results for "alpha"/);
  assert.match(textOf(parts), /1\. Alpha & Omega/);
  assert.match(textOf(parts), /https:\/\/example\.com\/alpha/);
});

test("web_search tool queries SearXNG with the JSON format", async () => {
  let requestedUrl = "";
  const fetchStub = (async (input: string | URL) => {
    requestedUrl = String(input);
    return new Response(
      JSON.stringify({ results: [{ title: "Hit", url: "https://hit.example", content: "body" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const tool = createWebSearchTool({
    backend: "searxng",
    searxngUrl: "https://searx.example.com/",
    fetch: fetchStub,
  });
  const parts = await tool.execute({ query: "hello world", limit: 3 }, toolContext());
  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, "https://searx.example.com/search");
  assert.equal(url.searchParams.get("q"), "hello world");
  assert.equal(url.searchParams.get("format"), "json");
  assert.match(textOf(parts), /Hit/);
});

test("web_search tool reports failures as text instead of throwing", async () => {
  const fetchStub = (async () =>
    new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const tool = createWebSearchTool({ fetch: fetchStub });
  const parts = await tool.execute({ query: "x" }, toolContext());
  assert.match(textOf(parts), /Web search failed: DuckDuckGo returned HTTP 503/);
});

test("web_search falls back to the lite endpoint when html is challenged", async () => {
  const calls: string[] = [];
  const fetchStub = (async (input: string | URL) => {
    calls.push(String(input));
    if (String(input).includes("/html/")) {
      return new Response("<html>anomaly</html>", { status: 202 });
    }
    return new Response(
      `<a class="result-link" href="https://lite.example">Lite hit</a>` +
        `<td class="result-snippet">from lite</td>`,
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const tool = createWebSearchTool({ fetch: fetchStub });
  const parts = await tool.execute({ query: "fallback" }, toolContext());
  assert.deepEqual(calls, [
    "https://html.duckduckgo.com/html/",
    "https://lite.duckduckgo.com/lite/",
  ]);
  assert.match(textOf(parts), /Lite hit/);
  assert.match(textOf(parts), /from lite/);
});

test("web_search plugin requires a URL for the searxng backend", () => {
  const plugin = createWebSearchPlugin();
  const registered: string[] = [];
  assert.throws(() => plugin.activate(pluginContext({ backend: "searxng" }, registered)));
  assert.equal(registered.length, 0);
});

test("web_search plugin registers the tool when configured", () => {
  const plugin = createWebSearchPlugin();
  const registered: string[] = [];
  plugin.activate(
    pluginContext({ backend: "searxng", searxngUrl: "https://searx.example.com" }, registered),
  );
  assert.deepEqual(registered, ["web_search"]);
});
