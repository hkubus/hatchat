import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { decryptSecret, encryptSecret, parseKey } from "./index.js";

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
