import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { test } from "node:test";
import { AddressInfo } from "node:net";
import { PROTOCOL_VERSION } from "@hat/runner-protocol";
import WebSocket from "ws";
import { RunnerRegistry, selectRunner, type LinkTimings, type RunnerCandidate } from "./link.js";

function runner(id: string, tags: string[], load: number, os = "linux"): RunnerCandidate {
  return { id, load, capabilities: { os, arch: "x64", runtimes: ["node v22"], tags } };
}

test("picks the least busy runner by default", () => {
  const runners = [runner("a", ["local"], 3), runner("b", ["gpu"], 1), runner("c", ["local"], 2)];
  assert.equal(selectRunner(runners)?.id, "b");
  assert.equal(selectRunner([]), undefined);
});

test("filters by tags before load", () => {
  const runners = [runner("a", ["local"], 1), runner("b", ["gpu"], 9), runner("c", ["gpu"], 8)];
  assert.equal(selectRunner(runners, { tags: ["gpu"] })?.id, "c");
  assert.equal(selectRunner(runners, { tags: ["missing"] }), undefined);
});

test("filters by os and runtime", () => {
  const runners = [
    runner("a", [], 1, "linux"),
    runner("b", [], 1, "darwin"),
  ];
  assert.equal(selectRunner(runners, { os: "darwin" })?.id, "b");
  assert.equal(selectRunner(runners, { runtimes: ["python3"] }), undefined);
});

/** Stand up a registry on an ephemeral port and return a runner-side connector. */
async function withRegistry(
  onAvailability: (available: boolean) => void,
  timings?: LinkTimings,
): Promise<{
  registry: RunnerRegistry;
  connect: (runnerId: string, options?: WebSocket.ClientOptions) => Promise<WebSocket>;
  close: () => Promise<void>;
}> {
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const registry = new RunnerRegistry(silent, "", onAvailability, timings);
  const http: Server = createHttpServer();
  registry.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const sockets: WebSocket[] = [];

  return {
    registry,
    connect: (runnerId, options) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/link`, options);
        sockets.push(ws);
        ws.once("error", reject);
        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              t: "hello",
              v: PROTOCOL_VERSION,
              runnerId,
              caps: { os: "linux", arch: "x64", runtimes: ["node"], tags: ["local"] },
            }),
          );
        });
        ws.on("message", (data: Buffer) => {
          if ((JSON.parse(data.toString()) as { t: string }).t === "hello.ok") resolve(ws);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        // The handshake keeps a keepalive timer alive, so the sockets have to
        // be torn down explicitly or the test runner never exits.
        for (const ws of sockets) ws.terminate();
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

test("notifies when a runner arrives and leaves", async () => {
  const events: boolean[] = [];
  const { connect, close } = await withRegistry((available) => events.push(available));

  const ws = await connect("r1");
  await settled();
  assert.deepEqual(events, [true]);

  ws.close();
  await settled();
  assert.deepEqual(events, [true, false]);
  await close();
});

/**
 * A runner that reconnects under the same id is the common case, and the old
 * socket's close must not read as "the fleet is now empty" — that would tear
 * down the MCP plugin's tools in between two turns.
 */
test("a same-id reconnect does not report the fleet as empty", async () => {
  const events: boolean[] = [];
  const { connect, close } = await withRegistry((available) => events.push(available));

  const first = await connect("r1");
  await settled();
  assert.deepEqual(events, [true]);

  const second = await connect("r1");
  await settled();
  first.close();
  await settled();
  // Still exactly one "became available", and no spurious "gone".
  assert.deepEqual(events, [true]);

  second.close();
  await settled();
  assert.deepEqual(events, [true, false]);
  await close();
});

/** Drain an exec stream; rejects with the stream's error, if it fails. */
async function drainExec(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of events) {
    /* nothing is expected */
  }
}

/**
 * Whatever still holds a superseded connection (a cached execution host) has
 * to get an error back. A request on a closed link used to wait forever.
 */
test("a superseded connection fails new requests instead of hanging", async () => {
  const { registry, connect, close } = await withRegistry(() => {});
  await connect("r1");
  await settled();
  const old = registry.get("r1")!;
  await connect("r1");
  await settled();

  assert.equal(old.closed, true);
  assert.equal(registry.get("r1")?.closed, false);
  assert.notEqual(registry.get("r1"), old);
  await assert.rejects(old.ensureWorkspace("s1"), /superseded/);
  await assert.rejects(old.fsRead("s1", "notes.txt"), /superseded/);
  await assert.rejects(old.spawn({ command: "sleep 1", shell: true }), /superseded/);
  await assert.rejects(drainExec(old.exec("s1", { command: "echo hi" }, new AbortController().signal)), /superseded/);
  await close();
});

test("an exec for a turn that was already cancelled is never started", async () => {
  const { registry, connect, close } = await withRegistry(() => {});
  const ws = await connect("r1");
  const received: string[] = [];
  ws.on("message", (data: Buffer) => received.push((JSON.parse(data.toString()) as { t: string }).t));
  const stopped = new AbortController();
  stopped.abort();

  await assert.rejects(drainExec(registry.get("r1")!.exec("s1", { command: "rm -rf build" }, stopped.signal)), /cancelled/);
  await settled();
  assert.deepEqual(received.filter((type) => type.startsWith("exec.")), []);
  await close();
});

test("a request the runner never answers fails instead of waiting forever", async () => {
  const { registry, connect, close } = await withRegistry(() => {}, { rpcTimeoutMs: 50 });
  await connect("r1"); // never replies to anything
  await assert.rejects(registry.get("r1")!.fsRead("s1", "notes.txt"), /did not answer within/);
  await close();
});

test("a runner that stops answering pings is dropped, failing its requests", async () => {
  const events: boolean[] = [];
  const { registry, connect, close } = await withRegistry((available) => events.push(available), {
    pingIntervalMs: 30,
  });
  // A socket that no longer answers pings: the runner's machine went away.
  await connect("r1", { autoPong: false });
  const pending = registry.get("r1")!.fsRead("s1", "notes.txt");
  await assert.rejects(pending, /link closed/);
  assert.equal(registry.get("r1"), undefined);
  assert.deepEqual(events, [true, false]);
  await close();
});
