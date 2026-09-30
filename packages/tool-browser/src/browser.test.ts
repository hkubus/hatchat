import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { chromium } from "playwright-core";
import { BrowserManager } from "./browser.js";

// These drive a real Chromium; without the Playwright browser cache (CI) they skip.
const haveChromium = fs.existsSync(chromium.executablePath());

/**
 * One local server plays both parts: as 127.0.0.1 it is a "public" site
 * (allow-listed below), as localhost it is an internal service that must
 * never see a request.
 */
async function setup(t: TestContext) {
  const hits = { internal: 0 };
  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    const internal = `http://localhost:${port}`;
    if (req.headers.host?.startsWith("localhost")) {
      hits.internal += 1;
      res.end("SECRET");
    } else if (req.url === "/") {
      res.setHeader("content-type", "text/html");
      res.end(
        `<title>Public</title><body>public page <a id="leak" href="${internal}/secret">more</a>` +
          `<img src="${internal}/pixel.png"></body>`,
      );
    } else if (req.url === "/hop") {
      res.writeHead(302, { location: "/" }).end();
    } else if (req.url === "/redirect") {
      res.writeHead(302, { location: `${internal}/latest/meta-data/` }).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const browser = new BrowserManager({
    headless: true,
    idleTimeoutMs: 60_000,
    navigationTimeoutMs: 10_000,
    maxTextChars: 2_000,
    maxLinks: 10,
    allowPrivateHosts: ["127.0.0.1"],
  });
  t.after(async () => {
    await browser.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { browser, hits, public: `http://127.0.0.1:${port}`, internal: `http://localhost:${port}` };
}

test("opens a public page, following a redirect that stays public", { skip: !haveChromium }, async (t) => {
  const site = await setup(t);
  const page = await site.browser.open("s1", `${site.public}/hop`);
  assert.match(page.text, /public page/);
  assert.equal(page.url, `${site.public}/`);
});

test("refuses to open a private address", { skip: !haveChromium }, async (t) => {
  const site = await setup(t);
  await assert.rejects(site.browser.open("s1", `${site.internal}/secret`), /refusing to open .*private or internal/);
  assert.equal(site.hits.internal, 0);
});

test("a redirect into a private address is blocked before it is followed", { skip: !haveChromium }, async (t) => {
  const site = await setup(t);
  // Over plain HTTP the proxy answers with a page saying why; HTTPS fails outright.
  const page = await site.browser.open("s1", `${site.public}/redirect`).catch((error: Error) => ({ text: error.message }));
  assert.match(page.text, /Blocked by hat: localhost is a private or internal address/);
  assert.equal(site.hits.internal, 0);
});

test("a page can't reach a private address with a link or a subresource", { skip: !haveChromium }, async (t) => {
  const site = await setup(t);
  await site.browser.open("s1", `${site.public}/`);
  await site.browser.click("s1", "#leak").catch(() => undefined);
  const after = await site.browser.read("s1");
  assert.doesNotMatch(after.text, /SECRET/);
  assert.equal(site.hits.internal, 0);
});
