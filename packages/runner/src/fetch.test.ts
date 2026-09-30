import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { runFetch } from "./fetch.js";

/**
 * One local server plays both parts: reached as 127.0.0.1 it is a "public"
 * site (allow-listed), reached as localhost it is an internal service.
 */
async function sites(t: TestContext) {
  const hits = { secret: 0, methods: [] as string[] };
  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    if (req.url === "/page") {
      hits.methods.push(req.method ?? "");
      res.end("hello");
    } else if (req.url === "/hop") {
      res.writeHead(302, { location: "/page" }).end();
    } else if (req.url === "/form") {
      res.writeHead(303, { location: "/page" }).end();
    } else if (req.url === "/to-internal") {
      res.writeHead(302, { location: `http://localhost:${port}/secret` }).end();
    } else if (req.url === "/secret") {
      hits.secret += 1;
      res.end("SECRET");
    } else if (req.url === "/big") {
      res.end("x".repeat(100_000));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  return { hits, public: `http://127.0.0.1:${port}`, internal: `http://localhost:${port}`, allowHosts: ["127.0.0.1"] };
}

test("follows redirects that stay public", async (t) => {
  const site = await sites(t);
  const result = await runFetch(`${site.public}/hop`, undefined, undefined, undefined, { allowHosts: site.allowHosts });
  assert.equal(result.status, 200);
  assert.equal(result.body, "hello");
});

test("refuses a private address, and a redirect into one, before any request is made", async (t) => {
  const site = await sites(t);
  const options = { allowHosts: site.allowHosts };
  await assert.rejects(runFetch(`${site.internal}/secret`, undefined, undefined, undefined, options), /fetch blocked: .*private or internal/);
  await assert.rejects(runFetch(`${site.public}/to-internal`, undefined, undefined, undefined, options), /fetch blocked: .*private or internal/);
  await assert.rejects(runFetch("http://169.254.169.254/latest/meta-data/", undefined, undefined, undefined, options), /fetch blocked/);
  assert.equal(site.hits.secret, 0);
});

test("a 303 after a POST continues as a GET", async (t) => {
  const site = await sites(t);
  await runFetch(`${site.public}/form`, "POST", { "content-type": "text/plain" }, "data", { allowHosts: site.allowHosts });
  assert.deepEqual(site.hits.methods, ["GET"]);
});

test("a large body is cut at the cap while reading", async (t) => {
  const site = await sites(t);
  const result = await runFetch(`${site.public}/big`, undefined, undefined, undefined, { allowHosts: site.allowHosts, maxBytes: 1_000 });
  assert.equal(result.body.length, 1_000);
});
