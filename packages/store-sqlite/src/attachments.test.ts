import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LocalArtifactStore } from "@hat/artifacts";
import { imageSize } from "./image.js";
import { Store } from "./store.js";

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("parses PNG and GIF dimensions", () => {
  assert.deepEqual(imageSize(png(800, 600)), { width: 800, height: 600 });

  const gif = Buffer.alloc(10);
  gif.write("GIF89a", 0, "ascii");
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(240, 8);
  assert.deepEqual(imageSize(gif), { width: 320, height: 240 });

  assert.equal(imageSize(Buffer.from("not an image")), undefined);
});

test("stores, dedupes and reads attachments", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hat-att-"));
  const store = new Store(":memory:", crypto.randomBytes(32), new LocalArtifactStore(dir));
  const data = png(10, 20);

  const a = await store.putAttachment(data, "image/png");
  const b = await store.putAttachment(Buffer.from(data), "image/png");
  assert.equal(a.id, b.id, "identical bytes dedupe by hash");
  assert.equal(a.width, 10);
  assert.equal(a.height, 20);
  assert.deepEqual(await store.readAttachment(a.id), data);
  assert.equal(store.getAttachment("missing"), undefined);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deleting a conversation removes the attachments only it used, bytes included", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hat-prune-"));
  const blobs = new LocalArtifactStore(dir);
  const store = new Store(":memory:", crypto.randomBytes(32), blobs);
  const image = await store.putAttachment(Buffer.from("only-here-image"), "image/png");
  const doc = await store.putAttachment(Buffer.from("secret contract"), "text/plain", { name: "c.txt", text: "secret contract" });
  const artifact = await store.putAttachment(Buffer.from("made by a tool"), "text/plain", { name: "out.txt", text: "made by a tool" });
  const shared = await store.putAttachment(Buffer.from("used twice"), "image/png");

  const doomed = store.createSession("fake/fake-agent");
  store.appendMessage(doomed.id, {
    id: "u1",
    role: "user",
    parts: [
      { type: "image", source: { kind: "attachment", id: image.id, mime: "image/png" } },
      { type: "file", id: doc.id, name: "c.txt", mime: "text/plain", size: doc.size },
      { type: "image", source: { kind: "attachment", id: shared.id, mime: "image/png" } },
    ],
    createdAt: 1,
  });
  store.appendMessage(doomed.id, {
    id: "t1",
    role: "tool",
    parts: [{ type: "tool_result", id: "c1", name: "create_artifact", content: [{ type: "file", id: artifact.id, name: "out.txt", mime: "text/plain", size: artifact.size }] }],
    createdAt: 2,
  });
  const other = store.createSession("fake/fake-agent");
  store.appendMessage(other.id, {
    id: "u2",
    role: "user",
    parts: [{ type: "image", source: { kind: "attachment", id: shared.id, mime: "image/png" } }],
    createdAt: 3,
  });

  const ids = store.attachmentIdsOf(doomed.id);
  assert.deepEqual(new Set(ids), new Set([image.id, doc.id, shared.id, artifact.id]));
  store.deleteSession(doomed.id);
  // Past the grace for drafts: every upload here is "old".
  const removed = await store.pruneAttachments(ids, { olderThan: Date.now() + 1 });

  assert.deepEqual(new Set(removed), new Set([image.id, doc.id, artifact.id]));
  assert.equal(store.getAttachment(doc.id), undefined);
  assert.equal(store.getAttachmentText(doc.id), undefined);
  assert.equal(await store.readAttachment(image.id), undefined);
  assert.equal(fs.existsSync(path.join(dir, doc.sha256)), false, "the bytes are gone from disk");
  assert.ok(store.getAttachment(shared.id), "an attachment another conversation uses stays");
  assert.ok(await store.readAttachment(shared.id));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("deleting a conversation keeps an attachment another one uploaded but has not sent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hat-prune-draft-"));
  const store = new Store(":memory:", crypto.randomBytes(32), new LocalArtifactStore(dir));
  const sent = await store.putAttachment(Buffer.from("same picture"), "image/png");
  const doomed = store.createSession("fake/fake-agent");
  store.appendMessage(doomed.id, {
    id: "u1",
    role: "user",
    parts: [{ type: "image", source: { kind: "attachment", id: sent.id, mime: "image/png" } }],
    createdAt: 1,
  });
  const ids = store.attachmentIdsOf(doomed.id);
  const beforeDraft = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Another chat uploads the same bytes (dedupes to the same id) and holds it in its composer.
  const draft = await store.putAttachment(Buffer.from("same picture"), "image/png");
  assert.equal(draft.id, sent.id);
  store.deleteSession(doomed.id);

  // Even with the grace ending before that re-upload, the re-upload keeps it.
  assert.deepEqual(await store.pruneAttachments(ids, { olderThan: beforeDraft }), []);
  assert.deepEqual(await store.pruneAttachments(ids), [], "the default grace keeps a fresh upload");
  assert.ok(await store.readAttachment(draft.id), "the draft can still be sent");

  // Once the upload is older than the grace and still unsent, it goes.
  assert.deepEqual(await store.pruneAttachments(ids, { olderThan: Date.now() + 1 }), [sent.id]);
  assert.equal(store.getAttachment(sent.id), undefined);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
