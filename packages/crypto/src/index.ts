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

/** Accept a 64-char hex key or a base64 32-byte key. Weak passphrases are rejected. */
export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === KEY_BYTES && trimmed.length >= 40) return decoded;
  if (trimmed.length < 8) {
    throw new Error(
      "HAT_MASTER_KEY too weak: use 64-char hex or base64 32-byte key (generate with `openssl rand -hex 32`)",
    );
  }
  console.warn("[hat] HAT_MASTER_KEY is a passphrase, deriving via sha256 — prefer a 64-char hex key");
  return crypto.createHash("sha256").update(trimmed).digest();
}

export interface MasterKey {
  key: Buffer;
  source: "env" | "file" | "generated";
  path?: string;
  /**
   * A key file ignored because `HAT_MASTER_KEY` is set, holding a different
   * key: whatever was saved before the variable was set is encrypted with it.
   */
  shadowedFile?: string;
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
  if (fromEnv) {
    const key = parseKey(fromEnv);
    let fileKey: Buffer | undefined;
    try {
      if (fs.existsSync(options.filePath)) fileKey = parseKey(fs.readFileSync(options.filePath, "utf8"));
    } catch {
      /* an unreadable key file is not one secrets were saved under */
    }
    return {
      key,
      source: "env",
      ...(fileKey && !fileKey.equals(key) ? { shadowedFile: options.filePath } : {}),
    };
  }

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
