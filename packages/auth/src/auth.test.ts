import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
  RateLimiter,
  hashPassword,
  signSession,
  verifyPassword,
  verifySession,
} from "./index.js";

test("password hashing round-trips and rejects wrong passwords", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.ok(stored.startsWith("scrypt$"));
  assert.equal(verifyPassword("correct horse battery staple", stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
  assert.equal(verifyPassword("x", "not-a-hash"), false);
});

test("session tokens verify and reject tampering/expiry", () => {
  const secret = crypto.randomBytes(32);
  const token = signSession({ sub: "user", exp: Date.now() + 1000 }, secret);

  assert.equal(verifySession(token, secret)?.sub, "user");
  assert.equal(verifySession(token, crypto.randomBytes(32)), undefined);
  assert.equal(verifySession(`${token}x`, secret), undefined);
  assert.equal(verifySession(signSession({ sub: "user", exp: Date.now() - 1 }, secret), secret), undefined);
});

test("rate limiter blocks after the limit", () => {
  const limiter = new RateLimiter(3, 60_000);
  const now = 1_000_000;
  assert.equal(limiter.allow("ip", now), true);
  assert.equal(limiter.allow("ip", now + 1), true);
  assert.equal(limiter.allow("ip", now + 2), true);
  assert.equal(limiter.allow("ip", now + 3), false);
  assert.equal(limiter.allow("other", now + 3), true);
  assert.equal(limiter.allow("ip", now + 61_000), true);
});
