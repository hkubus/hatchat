import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import type { ChatMessage } from "@hat/core";
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
