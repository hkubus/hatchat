import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decryptSecret, encryptSecret, loadMasterKey, parseKey } from "./index.js";

test("encrypts and decrypts a secret", () => {
  const key = crypto.randomBytes(32);
  const record = encryptSecret("sk-super-secret", key);
  assert.notEqual(record.ciphertext, "sk-super-secret");
  assert.equal(decryptSecret(record, key), "sk-super-secret");
});

test("fails to decrypt with the wrong key", () => {
  const record = encryptSecret("hello", crypto.randomBytes(32));
  assert.throws(() => decryptSecret(record, crypto.randomBytes(32)));
});

test("parseKey accepts hex and derives from passphrases", () => {
  const hex = crypto.randomBytes(32).toString("hex");
  assert.equal(parseKey(hex).length, 32);

  const derived = parseKey("a passphrase");
  assert.equal(derived.length, 32);
  assert.deepEqual(derived, parseKey("a passphrase"));
});

test("an env key that differs from an existing key file is reported", (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hat-key-")), "master.key");
  const fileKey = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, fileKey);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  const envVar = "HAT_TEST_MASTER_KEY";
  process.env[envVar] = crypto.randomBytes(32).toString("hex");
  t.after(() => delete process.env[envVar]);
  assert.equal(loadMasterKey({ envVar, filePath: file }).shadowedFile, file);

  process.env[envVar] = fileKey;
  assert.equal(loadMasterKey({ envVar, filePath: file }).shadowedFile, undefined);
});
