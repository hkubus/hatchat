import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

/** Resolve a host to the address to connect to, or throw when it may not be reached. */
export type HostVetter = (hostname: string) => Promise<string>;

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, for the browser's proxy setting. */
  url: string;
  close(): Promise<void>;
}

/** Hop-by-hop headers of the browser-to-proxy leg, not to be forwarded. */
const PROXY_HEADERS = ["proxy-connection", "proxy-authorization", "connection", "keep-alive"];
/** The same for a WebSocket handshake, which must keep its `Connection: Upgrade`. */
const UPGRADE_DROPPED_HEADERS = ["proxy-connection", "proxy-authorization", "keep-alive"];

/**
 * A forward proxy that only lets the browser reach public hosts.
 *
 * Chromium runs in the server's own network, so a page (or a model steered by
 * one) could otherwise read cloud metadata, hat's own API or anything else on
 * the private network. Request interception can't close that: Chromium
 * follows redirects on its own, without asking again. A proxy sees every
 * connection instead (navigations, each redirect hop, subresources, fetches,
 * WebSockets), checks where it goes, and connects to the address it checked,
 * so the host's DNS can't answer differently in between.
 *
 * Plain HTTP to a blocked host gets a 403 page saying why; HTTPS and
 * WebSockets get the tunnel or upgrade refused, which the browser reports as
 * a failed navigation or connection.
 */
export async function startEgressProxy(vet: HostVetter): Promise<EgressProxy> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    void (async () => {
      let target: URL;
      try {
        target = new URL(req.url ?? "");
        if (target.protocol !== "http:") throw new Error("not an http URL");
      } catch {
        res.writeHead(400).end();
        return;
      }
      let address: string;
      try {
        address = await vet(target.hostname);
      } catch (error) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end(`Blocked by hat: ${(error as Error).message}`);
        return;
      }
      const headers = { ...req.headers };
      for (const name of PROXY_HEADERS) delete headers[name];
      const upstream = http.request({
        host: address,
        port: target.port || 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      });
      upstream.on("response", (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      });
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    })();
  });

  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    void (async () => {
      client.on("error", () => client.destroy());
      let hostname: string;
      let port: number;
      try {
        const target = new URL(`http://${req.url ?? ""}`);
        hostname = target.hostname;
        port = Number(target.port) || 443;
      } catch {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      let address: string;
      try {
        address = await vet(hostname);
      } catch {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = net.connect(port, address, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    })();
  });

  // A WebSocket over plain HTTP (ws://) asks to upgrade instead of
  // tunnelling: checked like any HTTP request, then the handshake is passed
  // on to the address checked and the two sockets joined.
  server.on("upgrade", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    void (async () => {
      client.on("error", () => client.destroy());
      let target: URL;
      try {
        target = new URL(req.url ?? "");
        if (target.protocol !== "http:" && target.protocol !== "ws:") throw new Error("not an http URL");
      } catch {
        client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }
      let address: string;
      try {
        address = await vet(target.hostname);
      } catch {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      // The handshake needs its Connection: Upgrade; only the proxy's own headers go.
      const lines = [`${req.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        if (UPGRADE_DROPPED_HEADERS.includes(name.toLowerCase())) continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      const upstream = net.connect(Number(target.port) || 80, address, () => {
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
    })();
  });

  server.on("connection", (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
