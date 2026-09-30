import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { ChatMessage, Usage } from "@hat/core";
import { textOf, usageTotal } from "@hat/core";
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

test("the active leaf follows an append only while it points at the parent", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");
  store.appendMessage(session.id, message("u1", "user", "one"));
  store.appendMessage(session.id, message("a1", "assistant", "reply"));
  store.appendMessage(session.id, message("u2", "user", "two"), "a1");
  assert.deepEqual(ids(store, session.id), ["u1", "a1", "u2"]);

  // The user switches to another branch while a turn is still writing its own.
  store.setActiveLeaf(session.id, "u1");
  store.appendMessage(session.id, message("a2", "assistant", "reply two"), "u2");
  assert.deepEqual(ids(store, session.id), ["u1"]);
  assert.deepEqual(store.children(session.id, "u2").map((m) => m.id), ["a2"]);

  store.selectBranch(session.id, "a1");
  assert.deepEqual(ids(store, session.id), ["u1", "a1", "u2", "a2"]);
  store.close();
});

test("a new session persists the auto/low defaults it reports", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const created = store.createSession("fake/fake-agent");
  assert.equal(created.approvalMode, "auto");
  assert.equal(created.reasoningEffort, "low");

  // The persisted row, not the returned literal, is what later reads and the
  // agent's tool policy use.
  const reloaded = store.getSession(created.id);
  assert.equal(reloaded?.approvalMode, "auto");
  assert.equal(reloaded?.reasoningEffort, "low");
  store.close();
});

test("reopening a legacy database realigns the old ask/off defaults once", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hat-store-")), "hat.db");
  const store = new Store(file, crypto.randomBytes(32));
  const legacy = store.createSession("fake/fake-agent");
  const denied = store.createSession("fake/fake-agent");
  store.close();

  // Emulate a database written by the older build: rows at the legacy defaults
  // and no migration marker yet.
  const raw = new DatabaseSync(file);
  raw.exec(
    `UPDATE sessions SET approval_mode = 'ask', reasoning_effort = 'off' WHERE id = '${legacy.id}'`,
  );
  raw.exec(
    `UPDATE sessions SET approval_mode = 'deny', reasoning_effort = 'high' WHERE id = '${denied.id}'`,
  );
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  const reopened = new Store(file, crypto.randomBytes(32));
  assert.equal(reopened.getSession(legacy.id)?.approvalMode, "auto");
  assert.equal(reopened.getSession(legacy.id)?.reasoningEffort, "low");
  assert.equal(reopened.getSession(denied.id)?.approvalMode, "deny");
  assert.equal(reopened.getSession(denied.id)?.reasoningEffort, "high");

  // The marker makes the realignment one-shot: an explicit ask chosen afterwards
  // survives the next open.
  reopened.setSessionPolicy(legacy.id, { approvalMode: "ask" });
  reopened.close();
  const again = new Store(file, crypto.randomBytes(32));
  assert.equal(again.getSession(legacy.id)?.approvalMode, "ask");
  again.close();
});

test("titles the session from the first user message", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");
  store.appendMessage(session.id, message("u1", "user", "Hello there world"));
  assert.equal(store.getSession(session.id)?.title, "Hello there world");
  assert.equal(store.getSession(session.id)?.titleSource, "derived");
  store.close();
});

test("a generated title replaces the derived one but never a rename", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");
  store.appendMessage(session.id, message("u1", "user", "why is the build slow"));

  assert.equal(store.setGeneratedTitle(session.id, "Slow build diagnosis"), true);
  assert.equal(store.getSession(session.id)?.title, "Slow build diagnosis");
  assert.equal(store.getSession(session.id)?.titleSource, "model");

  // A model title is final: later attempts are refused.
  assert.equal(store.setGeneratedTitle(session.id, "Something else"), false);
  assert.equal(store.getSession(session.id)?.title, "Slow build diagnosis");

  store.close();
});

test("a rename beats an in-flight generated title", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");
  store.appendMessage(session.id, message("u1", "user", "why is the build slow"));

  // The user renames while the model is still thinking about the title.
  store.setSessionTitle(session.id, "CI triage");
  assert.equal(store.setGeneratedTitle(session.id, "Slow build diagnosis"), false);
  assert.equal(store.getSession(session.id)?.title, "CI triage");
  assert.equal(store.getSession(session.id)?.titleSource, "user");

  store.close();
});

test("titling a session does not count as activity", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const older = store.createSession("fake/fake-agent");
  const newer = store.createSession("fake/fake-agent");
  store.appendMessage(older.id, message("u1", "user", "first"));
  store.appendMessage(newer.id, message("u2", "user", "second"));

  // updated_at drives the sidebar ordering, so a title must not reorder it.
  // Compare against the order as it stands rather than a fixed expectation:
  // both sessions can share a millisecond, and ties are not deterministic.
  const orderBefore = store.listSessions().map((s) => s.id);
  const before = store.getSession(older.id)?.updatedAt;

  assert.equal(store.setGeneratedTitle(older.id, "First conversation"), true);
  assert.equal(store.getSession(older.id)?.updatedAt, before);
  assert.deepEqual(store.listSessions().map((s) => s.id), orderBefore);

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

test("memories can be added, updated and deleted", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const memory = store.addMemory("Prefers metric units");
  assert.match(memory.id, /^mem_/);
  assert.ok(store.updateMemory(memory.id, "Prefers metric units and 24h time"));
  assert.deepEqual(
    store.listMemories().map((m) => m.text),
    ["Prefers metric units and 24h time"],
  );
  assert.ok(store.deleteMemory(memory.id));
  assert.equal(store.deleteMemory(memory.id), false);
  assert.deepEqual(store.listMemories(), []);
});

test("searchMessages finds prose across sessions and forgets deleted ones", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const a = store.createSession("fake/fake-agent", "Sourdough");
  const b = store.createSession("fake/fake-agent", "Taxes");
  store.appendMessage(a.id, message("a1", "user", "How long should I proof sourdough bread?"));
  store.appendMessage(a.id, message("a2", "assistant", "Proof the dough 4-6 hours at room temperature."));
  store.appendMessage(b.id, message("b1", "user", "When are quarterly taxes due?"));
  // Tool output is not indexed.
  store.appendMessage(a.id, {
    id: "a3",
    role: "tool",
    parts: [{ type: "tool_result", id: "c", name: "x", content: [{ type: "text", text: "sourdough" }] }],
    createdAt: Date.now(),
  });

  const hits = store.searchMessages("sourdough proofing?");
  assert.deepEqual(hits.map((h) => h.messageId).sort(), ["a1", "a2"]);
  assert.equal(hits[0].sessionTitle, "Sourdough");
  assert.match(hits.find((h) => h.messageId === "a1")!.snippet, /«sourdough»/i);

  assert.deepEqual(store.searchMessages("sourdough", { excludeSessionId: a.id }), []);
  assert.deepEqual(store.searchMessages("!!!"), []);

  store.deleteSession(a.id);
  assert.deepEqual(store.searchMessages("sourdough"), []);
  assert.equal(store.searchMessages("taxes").length, 1);
});

test("the search index is backfilled for databases created before it existed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hat-fts-"));
  const dbPath = path.join(dir, "hat.db");
  const key = crypto.randomBytes(32);
  const first = new Store(dbPath, key);
  const session = first.createSession("fake/fake-agent");
  first.appendMessage(session.id, message("m1", "user", "remember the lighthouse"));
  first.close();

  // Simulate a pre-index database: empty index, old schema version.
  const raw = new DatabaseSync(dbPath);
  raw.exec("DELETE FROM messages_fts; PRAGMA user_version = 1");
  raw.close();

  const reopened = new Store(dbPath, key);
  assert.equal(reopened.searchMessages("lighthouse").length, 1);
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("schedules become due, advance, and one-shots disable themselves", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const schedule = store.createSchedule({
    title: "Digest",
    prompt: "Summarize the news",
    cron: "0 8 * * *",
    timezone: "UTC",
    runAt: null,
    sessionId: null,
    model: "fake/fake-agent",
    nextRunAt: 1_000,
  });
  assert.deepEqual(store.dueSchedules(999), []);
  assert.deepEqual(store.dueSchedules(1_000).map((s) => s.id), [schedule.id]);

  store.markScheduleRun(schedule.id, { at: 1_000, sessionId: "s1", error: null, nextRunAt: 5_000 });
  assert.deepEqual(store.dueSchedules(4_999), []);
  assert.equal(store.getSchedule(schedule.id)?.lastSessionId, "s1");

  store.markScheduleRun(schedule.id, { at: 5_000, sessionId: "s2", error: "boom", nextRunAt: null });
  const after = store.getSchedule(schedule.id)!;
  assert.equal(after.enabled, false);
  assert.equal(after.lastError, "boom");
  assert.deepEqual(store.dueSchedules(Number.MAX_SAFE_INTEGER), []);
  assert.ok(store.deleteSchedule(schedule.id));
});

test("per-session settings round-trip and clear back to defaults", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");
  assert.equal(session.instructions, "");
  assert.equal(session.temperature, null);

  store.setSessionSettings(session.id, { instructions: "Be terse.", temperature: 0.3, maxTokens: 500 });
  let updated = store.getSession(session.id)!;
  assert.equal(updated.instructions, "Be terse.");
  assert.equal(updated.temperature, 0.3);
  assert.equal(updated.maxTokens, 500);

  // Omitted fields are left alone; null clears.
  store.setSessionSettings(session.id, { temperature: null });
  updated = store.getSession(session.id)!;
  assert.equal(updated.temperature, null);
  assert.equal(updated.maxTokens, 500);
  assert.equal(updated.instructions, "Be terse.");
});

test("forkSession copies only the path up to the chosen message", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");
  store.setSessionSettings(session.id, { instructions: "keep" });
  store.appendMessage(session.id, message("m1", "user", "one"));
  store.appendMessage(session.id, message("m2", "assistant", "reply1"));
  store.appendMessage(session.id, message("m3", "user", "two"));
  store.appendMessage(session.id, message("m4", "assistant", "reply2"));
  // A sibling branch that must not come along.
  store.setActiveLeaf(session.id, "m1");
  store.appendMessage(session.id, message("m5", "assistant", "alt"));

  const fork = store.forkSession(session.id, "m3")!;
  assert.ok(fork);
  assert.notEqual(fork.id, session.id);
  assert.equal(fork.instructions, "keep");
  assert.match(fork.title, /\(fork\)$/);
  const path = store.getPath(fork.id);
  assert.deepEqual(
    path.map((n) => textOf(n.message)),
    ["one", "reply1", "two"],
  );
  assert.ok(path.every((n) => !["m1", "m2", "m3"].includes(n.message.id)), "fresh ids");
  assert.equal(store.countMessages(fork.id), 3);
  // The source is untouched.
  assert.equal(store.countMessages(session.id), 5);
  // A message from another session cannot be forked from here.
  const other = store.createSession("fake/fake-agent");
  assert.equal(store.forkSession(other.id, "m3"), undefined);
});

test("export and import preserve the whole tree, settings and active branch", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");
  store.setSessionTitle(session.id, "Original");
  store.setSessionSettings(session.id, { instructions: "Speak plainly.", maxTokens: 256 });
  store.appendMessage(session.id, message("m1", "user", "one"));
  store.appendMessage(session.id, message("m2", "assistant", "first"));
  store.setActiveLeaf(session.id, "m1");
  store.appendMessage(session.id, message("m3", "assistant", "second"));

  const exported = store.exportSession(session.id)!;
  assert.equal(exported.format, "hat.session");
  assert.equal(exported.messages.length, 3);
  assert.equal(exported.activeLeafId, "m3");

  const json = JSON.parse(JSON.stringify(exported));
  const imported = store.importSession(json);
  assert.equal(imported.title, "Original");
  assert.equal(imported.instructions, "Speak plainly.");
  assert.equal(imported.maxTokens, 256);
  const path = store.getPath(imported.id);
  assert.deepEqual(path.map((n) => textOf(n.message)), ["one", "second"]);
  assert.equal(path[1].siblingCount, 2, "the other branch came along too");
  assert.equal(store.countMessages(imported.id), 3);
  // Search indexes imported messages like any other.
  assert.ok(store.searchMessages("second").some((hit) => hit.sessionId === imported.id));
});

test("import drops messages whose parent is missing", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.importSession({
    format: "hat.session",
    version: 1,
    exportedAt: 0,
    session: {
      title: "t",
      createdAt: 0,
      model: "fake/fake-agent",
      approvalMode: "ask",
      allowedTools: [],
      reasoningEffort: "low",
      instructions: "",
      temperature: null,
      maxTokens: null,
    },
    activeLeafId: "b",
    messages: [
      { id: "a", parentId: null, role: "user", parts: [{ type: "text", text: "root" }], createdAt: 1 },
      { id: "b", parentId: "zz", role: "assistant", parts: [{ type: "text", text: "orphan" }], createdAt: 2 },
    ],
  });
  assert.equal(store.countMessages(session.id), 1);
  assert.equal(session.approvalMode, "ask");
});

test("document attachments keep their name and extracted text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hat-doc-"));
  const { createArtifactStore } = await import("@hat/artifacts");
  const store = new Store(":memory:", crypto.randomBytes(32), createArtifactStore({ dir }));
  const bytes = Buffer.from("hello, document");
  const record = await store.putAttachment(bytes, "text/plain", { name: "notes.txt", text: "hello, document" });
  assert.equal(record.name, "notes.txt");
  assert.equal(record.hasText, true);
  assert.equal(store.getAttachmentText(record.id), "hello, document");

  const image = await store.putAttachment(Buffer.from([1, 2, 3]), "image/png");
  assert.equal(image.hasText, undefined);
  assert.equal(store.getAttachmentText(image.id), undefined);
});

test("synthetic nudges are neither searchable nor counted as visible rows", () => {
  const store = new Store(":memory:", crypto.randomBytes(32));
  const session = store.createSession("fake/fake-agent");
  store.appendMessage(session.id, message("m1", "user", "tell me about otters"));
  store.appendMessage(session.id, message("m2", "assistant", "otters are"));
  store.appendMessage(session.id, {
    ...message("m3", "user", "Continue exactly where it stopped"),
    meta: { synthetic: "continue" },
  });
  store.appendMessage(session.id, message("m4", "assistant", " very playful"));
  assert.equal(store.searchMessages("stopped").length, 0);
  assert.equal(store.searchMessages("playful").length, 1);
  assert.equal(store.countVisibleMessages(session.id), 3);
  assert.equal(store.countMessages(session.id), 4);
  assert.equal(store.hasMessage(session.id, "m1"), true);
  const other = store.createSession("fake/fake-agent");
  assert.equal(store.hasMessage(other.id, "m1"), false);
});

test("a secret saved under another master key reads as unset instead of throwing", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hat-store-")), "hat.db");
  const before = new Store(file, crypto.randomBytes(32));
  before.setSecret("HAT_TEST_PROVIDER_KEY", "sk-old");
  before.close();

  // The key changed: HAT_MASTER_KEY set to a new value, or master.key lost.
  const after = new Store(file, crypto.randomBytes(32));
  assert.equal(await after.get("HAT_TEST_PROVIDER_KEY"), undefined);
  assert.equal(after.hasSecret("HAT_TEST_PROVIDER_KEY"), false);
  assert.deepEqual(after.unreadableSecrets(), ["HAT_TEST_PROVIDER_KEY"]);

  after.setSecret("HAT_TEST_PROVIDER_KEY", "sk-new");
  assert.equal(await after.get("HAT_TEST_PROVIDER_KEY"), "sk-new");
  assert.deepEqual(after.unreadableSecrets(), []);
  after.close();
});
