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
