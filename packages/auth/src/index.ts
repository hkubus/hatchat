import crypto from "node:crypto";

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Hash a password with scrypt. Format: `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Check a password against a stored hash. Asynchronous on purpose: scrypt is
 * slow by design, and done synchronously every login attempt would stall the
 * server, streams included, for its duration.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  let actual: Buffer;
  try {
    actual = await new Promise<Buffer>((resolve, reject) =>
      crypto.scrypt(
        password,
        salt,
        expected.length,
        { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export interface SessionPayload {
  sub: string;
  exp: number;
}

/** Sign a session token: `<base64url(payload)>.<base64url(hmac)>`. */
export function signSession(payload: SessionPayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifySession(token: string, secret: Buffer, now = Date.now()): SessionPayload | undefined {
  const [body, signature] = token.split(".");
  if (!body || !signature) return undefined;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp <= now) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function newToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Fixed-window rate limiter, keyed by e.g. client IP. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((time) => now - time < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** How many keys are being tracked. */
  get size(): number {
    return this.hits.size;
  }

  /**
   * Forget keys with no hit inside the window, at most once per window. Keys
   * are client addresses, and there is no end to those.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) {
      if (times.every((time) => now - time >= this.windowMs)) this.hits.delete(key);
    }
  }
}
