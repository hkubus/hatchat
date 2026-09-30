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
    } else if (req.url === "/echo") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.headers));
    } else if (req.url === "/to-echo") {
      res.writeHead(302, { location: "/echo" }).end();
    } else if (req.url === "/to-other-origin") {
      res.writeHead(307, { location: `http://other.test:${port}/echo` }).end();
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

test("the connection goes to the addresses that were checked, not a second DNS answer", async (t) => {
  const site = await sites(t);
  const port = new URL(site.public).port;
  // DNS rebinding: public when checked, loopback when connecting.
  let answers = 0;
  const resolve = async (): Promise<string[]> => (answers++ === 0 ? ["93.184.215.14"] : ["127.0.0.1"]);
  await assert.rejects(
    runFetch(`http://rebind.test:${port}/secret`, undefined, undefined, undefined, { allowHosts: [], resolve }),
    /fetch blocked: rebind\.test is a private or internal address/,
  );
  assert.ok(answers >= 2, "the connection resolved the name through the check");
  assert.equal(site.hits.secret, 0);
});

test("a name is connected to by its checked address, with its own Host header", async (t) => {
  const site = await sites(t);
  const port = new URL(site.public).port;
  const resolve = async (): Promise<string[]> => ["127.0.0.1"];
  const result = await runFetch(`http://named.test:${port}/echo`, undefined, undefined, undefined, {
    allowHosts: ["named.test"],
    resolve,
  });
  assert.equal(JSON.parse(result.body).host, `named.test:${port}`);
});

test("credentials are not forwarded to another origin a redirect points at", async (t) => {
  const site = await sites(t);
  const resolve = async (): Promise<string[]> => ["127.0.0.1"];
  const options = { allowHosts: ["127.0.0.1", "other.test"], resolve };
  const headers = { Authorization: "Bearer secret", cookie: "s=1", "Proxy-Authorization": "Basic x", "x-keep": "yes" };

  const same = JSON.parse((await runFetch(`${site.public}/to-echo`, undefined, headers, undefined, options)).body);
  assert.equal(same.authorization, "Bearer secret", "a same-origin redirect keeps them");
  assert.equal(same.cookie, "s=1");

  const other = JSON.parse((await runFetch(`${site.public}/to-other-origin`, undefined, headers, undefined, options)).body);
  assert.equal(other.host, `other.test:${new URL(site.public).port}`);
  assert.equal(other.authorization, undefined);
  assert.equal(other.cookie, undefined);
  assert.equal(other["proxy-authorization"], undefined);
  assert.equal(other["x-keep"], "yes");
});
