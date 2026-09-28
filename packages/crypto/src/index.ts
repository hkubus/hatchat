import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY_BYTES = 32;
const ALGORITHM = "aes-256-gcm";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(record: EncryptedSecret, key: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Accept a 64-char hex key, a base64 32-byte key, or derive from a passphrase. */
export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === KEY_BYTES) return decoded;
  return crypto.createHash("sha256").update(trimmed).digest();
}

export interface MasterKey {
  key: Buffer;
  source: "env" | "file" | "generated";
  path?: string;
}

/**
 * Resolve the master key from `HAT_MASTER_KEY`, then a key file, then generate
 * and persist one (0600). Generated keys are dev convenience — set the env var
 * in production.
 */
export function loadMasterKey(options: {
  envVar?: string;
  filePath: string;
}): MasterKey {
  const envVar = options.envVar ?? "HAT_MASTER_KEY";
  const fromEnv = process.env[envVar];
  if (fromEnv) return { key: parseKey(fromEnv), source: "env" };

  if (fs.existsSync(options.filePath)) {
    return {
      key: parseKey(fs.readFileSync(options.filePath, "utf8")),
      source: "file",
      path: options.filePath,
    };
  }

  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
  fs.writeFileSync(options.filePath, key.toString("hex"), { mode: 0o600 });
  return { key, source: "generated", path: options.filePath };
}
