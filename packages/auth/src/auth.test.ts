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

test("password hashing round-trips and rejects wrong passwords", async () => {
  const stored = hashPassword("correct horse battery staple");
  assert.ok(stored.startsWith("scrypt$"));
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("wrong", stored), false);
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
});

test("checking a password leaves the event loop free", async () => {
  const stored = hashPassword("secret");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  await Promise.all(Array.from({ length: 4 }, () => verifyPassword("guess", stored)));
  clearInterval(timer);
  assert.ok(ticks > 0, "timers ran while scrypt worked");
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

test("the rate limiter forgets addresses it has not seen for a window", () => {
  const limiter = new RateLimiter(3, 60_000);
  const now = 1_000_000;
  for (let i = 0; i < 1_000; i++) limiter.allow(`10.0.${i >> 8}.${i & 255}`, now);
  assert.equal(limiter.size, 1_000);
  limiter.allow("fresh", now + 61_000);
  assert.equal(limiter.size, 1);
});
