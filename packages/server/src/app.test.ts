import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SseFrameParser, decodeFrame, type KernelEvent } from "@hat/core";
import { createServer, type ServerRuntime } from "./app.js";
import type { ServerConfig } from "./config.js";

/** Long enough that the fake provider is still streaming the reply for about a second. */
const LONG = "x".repeat(1_000);

interface PathNode {
  message: { id: string; role: string; parts: Array<{ type: string; text?: string }> };
}

/** A real server on temporary storage, with the fake provider and no runner. */
async function boot(t: TestContext): Promise<ServerRuntime["app"]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hat-app-"));
  // The server narrates every plugin and turn on the console.
  for (const method of ["log", "warn", "error"] as const) t.mock.method(console, method, () => {});
  const config: ServerConfig = {
    port: 0,
    host: "127.0.0.1",
    enrollToken: "test",
    maxToolIterations: 10,
    workspaceHint: dir,
    dbPath: path.join(dir, "hat.db"),
    masterKeyPath: path.join(dir, "master.key"),
    uploadDir: path.join(dir, "uploads"),
    pluginsDir: path.join(dir, "plugins"),
    appTitle: "hat",
    systemPrompt: "test",
    cookieSecure: false,
    sessionTtlMs: 3_600_000,
    corsOrigins: [],
    sseKeepaliveMs: 0,
    enableExternalPlugins: false,
    approvalTimeoutMs: 0,
    providerRetries: 0,
    pluginIsolation: true,
  };
  const runtime = await createServer(config);
  t.after(() => {
    runtime.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return runtime.app;
}

function call(app: ServerRuntime["app"], method: string, url: string, body?: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** Read a turn's event stream to the end. */
async function events(res: Response): Promise<KernelEvent[]> {
  assert.equal(res.status, 200);
  const parser = new SseFrameParser();
  const decoder = new TextDecoder();
  const out: KernelEvent[] = [];
  const take = (payloads: string[]): void => {
    for (const payload of payloads) {
      const event = decodeFrame<KernelEvent>(payload);
      if (event) out.push(event);
    }
  };
  const reader = res.body!.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    take(parser.push(decoder.decode(value, { stream: true })));
  }
  take(parser.flush());
  return out;
}

async function newSession(app: ServerRuntime["app"]): Promise<string> {
  const payload = (await (await call(app, "POST", "/api/sessions", {})).json()) as { session: { id: string } };
  return payload.session.id;
}

async function pathOf(app: ServerRuntime["app"], sessionId: string): Promise<PathNode[]> {
  return ((await (await call(app, "GET", `/api/sessions/${sessionId}`)).json()) as { path: PathNode[] }).path;
}

test("a second turn is refused while a reply is still running", async (t) => {
  const app = await boot(t);
  const id = await newSession(app);
  const first = await call(app, "POST", `/api/sessions/${id}/turn`, { text: LONG });

  // Another tab or device sends while the first reply is still streaming.
  const second = await call(app, "POST", `/api/sessions/${id}/turn`, { text: "second" });
  assert.equal(second.status, 409);
  assert.match(((await second.json()) as { error: string }).error, /stop it first/);
  assert.equal((await call(app, "POST", `/api/sessions/${id}/continue`)).status, 409);

  await events(first);
  await events(await call(app, "POST", `/api/sessions/${id}/turn`, { text: "second" }));
  const roles = (await pathOf(app, id)).map((node) => node.message.role);
  assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);
});

test("a message sent right after Stop waits for the stopped turn to finish", async (t) => {
  const app = await boot(t);
  const id = await newSession(app);
  const first = await call(app, "POST", `/api/sessions/${id}/turn`, { text: LONG });
  await call(app, "POST", `/api/sessions/${id}/turn/cancel`);

  const next = await call(app, "POST", `/api/sessions/${id}/turn`, { text: "after stop" });
  assert.equal(next.status, 200);
  await Promise.all([events(first), events(next)]);

  const path = await pathOf(app, id);
  assert.deepEqual(path.map((node) => node.message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(path[2].message.parts[0]?.text, "after stop");
});

test("switching branches mid-turn keeps the reply under the turn's own question", async (t) => {
  const app = await boot(t);
  const id = await newSession(app);
  await events(await call(app, "POST", `/api/sessions/${id}/turn`, { text: "first" }));
  const original = (await pathOf(app, id))[0].message.id;
  await events(await call(app, "POST", `/api/sessions/${id}/edit`, { messageId: original, text: "first, edited" }));
  const edited = (await pathOf(app, id))[0].message.id;

  const running = await call(app, "POST", `/api/sessions/${id}/turn`, { text: LONG });
  assert.equal((await call(app, "POST", `/api/sessions/${id}/select`, { messageId: original })).status, 200);
  await events(running);

  // The user stays on the branch they switched to...
  const viewed = await pathOf(app, id);
  assert.deepEqual(viewed.map((node) => node.message.parts[0]?.text?.slice(0, 5)), ["first", "You s"]);
  // ...and the turn's reply is where it belongs, on the edited branch.
  await call(app, "POST", `/api/sessions/${id}/select`, { messageId: edited });
  const branch = await pathOf(app, id);
  assert.deepEqual(branch.map((node) => node.message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(branch[2].message.parts[0]?.text, LONG);
  assert.match(branch[3].message.parts[0]?.text ?? "", /^You said: "x+/);
});
