import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchResponse, Part, ToolContext } from "@hat/core";
import { createWebFetchTool, htmlToMarkdown } from "./index.js";

const ARTICLE = `<!doctype html><html><head><title>Bread Guide</title></head><body>
<nav><a href="/">Home</a> <a href="/shop">Shop</a></nav>
<article><h1>How to proof sourdough</h1>
${"<p>Proofing lets the dough rise slowly so the crumb opens up and the flavour deepens. </p>".repeat(6)}
<p>See the <a href="/timing">timing chart</a> for details.</p>
<script>alert("x")</script></article>
<footer>© Bakery</footer></body></html>`;

function ctxFor(response: FetchResponse): { ctx: ToolContext; urls: string[] } {
  const urls: string[] = [];
  const ctx = {
    sessionId: "s",
    signal: new AbortController().signal,
    host: {
      net: {
        fetch: async (url: string) => {
          urls.push(url);
          return response;
        },
      },
    },
  } as unknown as ToolContext;
  return { ctx, urls };
}

const textOf = (parts: Part[]): string => parts.map((p) => (p.type === "text" ? p.text : "")).join("");

test("extracts the article as markdown with absolute links", () => {
  const page = htmlToMarkdown(ARTICLE, "https://bread.example/guide/proof");
  assert.equal(page.title, "Bread Guide");
  assert.match(page.markdown, /Proofing lets the dough rise/);
  assert.match(page.markdown, /\[timing chart\]\(https:\/\/bread\.example\/timing\)/);
  assert.doesNotMatch(page.markdown, /alert|Shop|Bakery/);
});

test("raw mode keeps the whole page", () => {
  const page = htmlToMarkdown(ARTICLE, "https://bread.example/", true);
  assert.match(page.markdown, /Shop/);
  assert.doesNotMatch(page.markdown, /alert/);
});

test("web_fetch pages through long content", async () => {
  const body = "x".repeat(50);
  const { ctx } = ctxFor({ status: 200, headers: { "content-type": "text/plain" }, body });
  const tool = createWebFetchTool();
  const first = textOf(await tool.execute({ url: "https://a.example/f.txt", max_chars: 20 }, ctx));
  assert.match(first, /start_index=20/);
  const last = textOf(await tool.execute({ url: "https://a.example/f.txt", start_index: 40, max_chars: 20 }, ctx));
  assert.doesNotMatch(last, /start_index/);
});

test("web_fetch pretty-prints JSON and rejects binaries, errors and bad URLs", async () => {
  const tool = createWebFetchTool();
  const json = ctxFor({ status: 200, headers: { "content-type": "application/json" }, body: '{"a":1}' });
  assert.match(textOf(await tool.execute({ url: "https://a.example/x" }, json.ctx)), /\{\n {2}"a": 1\n\}/);

  const pdf = ctxFor({ status: 200, headers: { "content-type": "application/pdf" }, body: "%PDF" });
  await assert.rejects(() => tool.execute({ url: "https://a.example/x.pdf" }, pdf.ctx), /not text/);

  const missing = ctxFor({ status: 404, headers: {}, body: "" });
  await assert.rejects(() => tool.execute({ url: "https://a.example/nope" }, missing.ctx), /HTTP 404/);

  await assert.rejects(() => tool.execute({ url: "file:///etc/passwd" }, missing.ctx), /http\(s\)/);
});
