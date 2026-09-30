import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type net from "node:net";
import { test, type TestContext } from "node:test";
import { CHROMIUM_ARGS } from "./browser.js";
import { startEgressProxy } from "./egress.js";

/** A site that answers plain HTTP and echoes over an upgraded (WebSocket-like) connection. */
async function site(t: TestContext) {
  const seen: Array<{ url?: string; host?: string; upgrade?: string; connection?: string }> = [];
  const upgraded = new Set<net.Socket>();
  const server = http.createServer((req, res) => res.end(`page ${req.url}`));
  server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
    upgraded.add(socket);
    seen.push({ url: req.url, host: req.headers.host, upgrade: req.headers.upgrade, connection: req.headers.connection });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(`echo:${data.toString()}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of upgraded) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, seen, server };
}

/** Hosts named `public.test` go to the local site; everything else is blocked. */
async function proxy(t: TestContext) {
  const egress = await startEgressProxy(async (host) => {
    if (host === "public.test") return "127.0.0.1";
    throw new Error(`${host} is a private or internal address`);
  });
  t.after(() => egress.close());
  return new URL(egress.url);
}

/** Ask the proxy to upgrade `url`; resolves with the socket and status, or the refusal. */
function upgrade(proxyUrl: URL, url: string): Promise<{ status: number; socket?: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port,
      path: url,
      headers: { host: new URL(url).host, connection: "Upgrade", upgrade: "websocket", "proxy-authorization": "x" },
    });
    req.on("upgrade", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}

test("Chromium is launched with WebRTC kept off non-proxied UDP", () => {
  assert.ok(CHROMIUM_ARGS.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(CHROMIUM_ARGS.includes("--webrtc-ip-handling-policy=disable_non_proxied_udp"));
});

test("plain HTTP reaches a public host and is refused for a private one", async (t) => {
  const { port } = await site(t);
  const proxyUrl = await proxy(t);
  const get = (url: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: proxyUrl.hostname, port: proxyUrl.port, path: url, headers: { host: new URL(url).host } }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on("error", reject);
    });
  assert.deepEqual(await get(`http://public.test:${port}/a`), { status: 200, body: "page /a" });
  const blocked = await get(`http://internal.test:${port}/a`);
  assert.equal(blocked.status, 403);
  assert.match(blocked.body, /private or internal/);
});

test("a ws:// WebSocket reaches a public host through the proxy", async (t) => {
  const { port, seen } = await site(t);
  const proxyUrl = await proxy(t);
  const { status, socket } = await upgrade(proxyUrl, `http://public.test:${port}/socket?x=1`);
  assert.equal(status, 101);
  t.after(() => socket?.destroy());
  const reply = new Promise<string>((resolve) => socket!.once("data", (data) => resolve(data.toString())));
  socket!.write("ping");
  assert.equal(await reply, "echo:ping");
  assert.deepEqual(seen, [{ url: "/socket?x=1", host: `public.test:${port}`, upgrade: "websocket", connection: "Upgrade" }]);
});

test("a ws:// WebSocket to a private host is refused before connecting", async (t) => {
  const { port, seen } = await site(t);
  const proxyUrl = await proxy(t);
  const { status } = await upgrade(proxyUrl, `http://internal.test:${port}/socket`);
  assert.equal(status, 403);
  assert.deepEqual(seen, []);
});
