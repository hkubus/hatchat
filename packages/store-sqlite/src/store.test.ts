import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, Usage } from "@hat/core";
import { usageTotal } from "@hat/core";
import { Store } from "./store.js";

function message(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, parts: [{ type: "text", text }], createdAt: Date.now() };
}

function ids(store: Store, sessionId: string): string[] {
  return store.getPath(sessionId).map((node) => node.message.id);
}

test("branches, selects and walks the message tree", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");

  store.appendMessage(session.id, message("m1", "user", "one"));
  store.appendMessage(session.id, message("m2", "assistant", "reply1"));
  store.appendMessage(session.id, message("m3", "user", "two"));
  store.appendMessage(session.id, message("m4", "assistant", "reply2"));
  assert.deepEqual(ids(store, session.id), ["m1", "m2", "m3", "m4"]);

  store.setActiveLeaf(session.id, "m1");
  store.appendMessage(session.id, message("m5", "assistant", "alt reply"));
  assert.deepEqual(ids(store, session.id), ["m1", "m5"]);
  assert.deepEqual(
    store.children(session.id, "m1").map((m) => m.id),
    ["m2", "m5"],
  );

  store.selectBranch(session.id, "m2");
  assert.deepEqual(ids(store, session.id), ["m1", "m2", "m3", "m4"]);

  store.selectBranch(session.id, "m5");
  const node = store.getPath(session.id)[1];
  assert.equal(node.siblingCount, 2);
  assert.equal(node.siblingIndex, 1);
  assert.deepEqual(node.siblingIds, ["m2", "m5"]);

  store.close();
});

test("titles the session from the first user message", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");
  store.appendMessage(session.id, message("u1", "user", "Hello there world"));
  assert.equal(store.getSession(session.id)?.title, "Hello there world");
  store.close();
});

test("secrets round-trip and fall back to env", async () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  store.setSecret("OPENROUTER_API_KEY", "sk-or-123");
  assert.equal(await store.getSecret("OPENROUTER_API_KEY"), "sk-or-123");
  assert.equal(store.hasSecret("OPENROUTER_API_KEY"), true);

  process.env.HAT_TEST_SECRET = "from-env";
  assert.equal(await store.getSecret("HAT_TEST_SECRET"), "from-env");
  delete process.env.HAT_TEST_SECRET;

  assert.equal(await store.getSecret("MISSING"), undefined);
  assert.equal(store.hasSecret("MISSING"), false);
  store.close();
});

/** An assistant message that records what it cost, as the kernel now writes. */
function spent(id: string, usage: Usage): ChatMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "reply" }],
    createdAt: Date.now(),
    meta: { provider: "fake", model: "fake/fake-agent", usage },
  };
}

test("usageBySession sums usage over the active branch only", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");

  store.appendMessage(session.id, message("u1", "user", "one"));
  store.appendMessage(session.id, spent("a1", { inputTokens: 100, outputTokens: 20 }));
  store.appendMessage(session.id, message("u2", "user", "two"));
  store.appendMessage(session.id, spent("a2", { inputTokens: 50, outputTokens: 5 }));

  // A sibling branch off u1 that the user later abandons.
  store.setActiveLeaf(session.id, "u1");
  store.appendMessage(session.id, spent("a3", { inputTokens: 999, outputTokens: 999 }));
  store.selectBranch(session.id, "a2");

  const totals = store.usageBySession();
  assert.deepEqual(totals.get(session.id), {
    inputTokens: 150,
    outputTokens: 25,
    totalTokens: 0,
  });
  assert.equal(usageTotal(totals.get(session.id)), 175);
  store.close();
});

test("usageBySession omits sessions with no messages or no usage", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const empty = store.createSession("fake/fake-agent");
  const unspent = store.createSession("fake/fake-agent");
  store.appendMessage(unspent.id, message("u1", "user", "hi"));

  const totals = store.usageBySession();
  assert.equal(totals.has(empty.id), false);
  assert.equal(totals.has(unspent.id), false);
  store.close();
});

test("a message with unreadable metadata does not break usage aggregation", () => {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "hat-store-")),
    "hat.db",
  );
  const store = new Store(file, crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");
  store.appendMessage(session.id, message("u1", "user", "one"));
  store.appendMessage(session.id, spent("a1", { inputTokens: 10, outputTokens: 2 }));
  store.close();

  // Corrupt the metadata out-of-band, the way a bad migration might.
  const raw = new DatabaseSync(file);
  raw.exec(`UPDATE messages SET meta = 'not json' WHERE id = 'a1'`);
  raw.close();

  const reopened = new Store(file, crypto.randomBytes(32));
  assert.equal(reopened.usageBySession().get(session.id), undefined);
  assert.equal(reopened.getMessage("a1")?.meta, undefined);
  reopened.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
