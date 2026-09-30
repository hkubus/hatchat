import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import { hashPassword } from "@hat/auth";
import { SseFrameParser, decodeFrame, type KernelEvent } from "@hat/core";
import { serve } from "@hono/node-server";
import { createServer, type ServerRuntime } from "./app.js";
import type { ServerConfig } from "./config.js";

/** Long enough that the fake provider is still streaming the reply for about a second. */
const LONG = "x".repeat(1_000);

interface PathNode {
  message: { id: string; role: string; parts: Array<{ type: string; text?: string }> };
}

/** A real server on temporary storage, with the fake provider and no runner. */
async function boot(t: TestContext, overrides: Partial<ServerConfig> = {}): Promise<ServerRuntime["app"]> {
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
    trustedProxies: [],
    sseKeepaliveMs: 0,
    enableExternalPlugins: false,
    approvalTimeoutMs: 0,
    providerRetries: 0,
    pluginIsolation: true,
    ...overrides,
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

/** Read a turn's event stream to the end, telling `onEvent` about each event as it arrives. */
async function events(res: Response, onEvent?: (event: KernelEvent) => void): Promise<KernelEvent[]> {
  assert.equal(res.status, 200);
  const parser = new SseFrameParser();
  const decoder = new TextDecoder();
  const out: KernelEvent[] = [];
  const take = (payloads: string[]): void => {
    for (const payload of payloads) {
      const event = decodeFrame<KernelEvent>(payload);
      if (event) {
        out.push(event);
        onEvent?.(event);
      }
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

  // The stopped turn keeps only what streamed before the stop, possibly
  // nothing, and the new turn follows it instead of interleaving with it.
  const path = await pathOf(app, id);
  assert.equal(path[0].message.parts[0]?.text, LONG);
  assert.deepEqual(path.slice(-2).map((node) => node.message.role), ["user", "assistant"]);
  assert.equal(path.at(-2)?.message.parts[0]?.text, "after stop");
  assert.ok(path.every((node) => node.message.parts.length > 0), "no empty reply is stored");
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

/** Serve the app on a real socket: client addresses only exist there. */
async function listen(t: TestContext, app: ServerRuntime["app"]): Promise<string> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function loginAttempts(base: string, count: number, forwardedFor: (i: number) => string | undefined): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const address = forwardedFor(i);
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(address ? { "x-forwarded-for": address } : {}) },
      body: JSON.stringify({ password: `guess ${i}` }),
    });
    statuses.push(res.status);
  }
  return statuses;
}

test("a forged X-Forwarded-For does not escape the login rate limit", async (t) => {
  const base = await listen(t, await boot(t, { authPasswordHash: hashPassword("right") }));
  const statuses = await loginAttempts(base, 12, (i) => `10.0.0.${i}`);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(statuses.slice(10), [429, 429]);
});

test("behind a trusted proxy, each client has its own login limit", async (t) => {
  const base = await listen(t, await boot(t, { authPasswordHash: hashPassword("right"), trustedProxies: ["127.0.0.1"] }));
  // Twelve clients, one attempt each, all arriving through the proxy.
  assert.deepEqual(await loginAttempts(base, 12, (i) => `203.0.113.${i}`), Array(12).fill(401));
  // One client past its limit is refused, whatever it claims upstream.
  const same = await loginAttempts(base, 11, () => "198.51.100.7, 203.0.113.99");
  assert.equal(same.at(-1), 429);
});

test("signing out a live session takes its CSRF token: a cross-site form can't do it", async (t) => {
  const app = await boot(t, { authPasswordHash: hashPassword("right") });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "right" }),
  });
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const forged = await app.request("/api/auth/logout", { method: "POST", headers: { cookie, origin: "https://evil.example" } });
  assert.equal(forged.status, 403);
  assert.equal(forged.headers.getSetCookie().length, 0);

  const real = await app.request("/api/auth/logout", { method: "POST", headers: { cookie, "x-csrf-token": csrfToken } });
  assert.equal(real.status, 200);
  assert.equal(real.headers.getSetCookie().length, 2);
});

test("signing out with an expired session still clears the cookies", async (t) => {
  const app = await boot(t, { authPasswordHash: hashPassword("right") });
  const res = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { cookie: "hat_session=expired.or.forged; hat_csrf=stale" },
  });
  assert.equal(res.status, 200);
  const cleared = res.headers.getSetCookie();
  assert.equal(cleared.length, 2);
  assert.ok(cleared.every((c) => /Max-Age=0/i.test(c)));
});

test("an oversized login body is refused before it is read", async (t) => {
  const base = await listen(t, await boot(t, { authPasswordHash: hashPassword("right") }));
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "x".repeat(100_000) }),
  });
  assert.equal(res.status, 413);
});

test("deleting a conversation stops its reply and removes the attachments only it used", async (t) => {
  const app = await boot(t);
  const id = await newSession(app);
  const form = new FormData();
  form.append("file", new Blob(["private notes"], { type: "text/plain" }), "notes.txt");
  const upload = (await (await app.request("/api/attachments", { method: "POST", body: form })).json()) as {
    attachment: { id: string };
  };
  await events(await call(app, "POST", `/api/sessions/${id}/turn`, { text: "read this", attachmentIds: [upload.attachment.id] }));
  // A fresh upload is kept for drafts that may still send it; this one is two days old.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 24 * 60 * 60 * 1000 });

  const running = await call(app, "POST", `/api/sessions/${id}/turn`, { text: LONG });
  const started = performance.now();
  // Delete once the reply has words to store, so its stopping has something to save.
  let deleted: Promise<unknown> | undefined;
  const tail = await events(running, (event) => {
    if (event.type === "text.delta" && !deleted) {
      deleted = call(app, "DELETE", `/api/sessions/${id}`).then((res) => res.json());
    }
  });
  assert.deepEqual(await deleted, { ok: true });
  // The delete waited for the reply to end, so it stored its last words
  // before the conversation went, instead of failing on a missing one.
  assert.deepEqual(tail.filter((event) => event.type === "error"), []);
  assert.ok(performance.now() - started < 800, "the reply stopped instead of streaming to the end");
  assert.equal((await call(app, "GET", `/api/attachments/${upload.attachment.id}`)).status, 404);
  assert.equal((await call(app, "GET", `/api/sessions/${id}`)).status, 404);
});
