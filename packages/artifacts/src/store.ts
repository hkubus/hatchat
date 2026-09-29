import fs from "node:fs";
import path from "node:path";
import { presignUrl, signRequest, type S3Credentials } from "./sigv4.js";

/**
 * Blob storage for attachments/artifacts. Keys are content hashes, so writes
 * are idempotent and dedupe naturally.
 */
export interface ArtifactStore {
  readonly kind: "local" | "s3";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
  /** A durable URL for the browser, or undefined to serve via the API by id. */
  url(key: string): Promise<string | undefined>;
}

function assertKey(key: string): void {
  // Keys are internal (content hashes); reject traversal/separators so
  // path.join can't escape the store dir if a caller ever passes user input.
  if (!key || key.includes("..") || key.includes("/") || key.includes("\\") || key.includes("\0")) {
    throw new Error(`invalid artifact key`);
  }
}

export class LocalArtifactStore implements ArtifactStore {
  readonly kind = "local" as const;

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  async put(key: string, data: Buffer, _contentType: string): Promise<void> {
    assertKey(key);
    fs.writeFileSync(path.join(this.dir, key), data);
  }

  async get(key: string): Promise<Buffer | undefined> {
    assertKey(key);
    const file = path.join(this.dir, key);
    return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  }

  async url(_key: string): Promise<string | undefined> {
    return undefined; // served through /api/attachments/:id
  }
}

export interface S3StoreOptions extends S3Credentials {
  bucket: string;
  endpoint?: string;
  prefix?: string;
  pathStyle?: boolean;
  urlExpiresSeconds?: number;
  fetch?: typeof fetch;
}

export class S3ArtifactStore implements ArtifactStore {
  readonly kind = "s3" as const;
  private readonly endpoint: string;
  private readonly pathStyle: boolean;
  private readonly prefix: string;
  private readonly urlExpires: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: S3StoreOptions) {
    this.endpoint =
      options.endpoint?.replace(/\/$/, "") ?? `https://s3.${options.region}.amazonaws.com`;
    if (!this.endpoint.startsWith("https://") && !this.endpoint.startsWith("http://localhost")) {
      throw new Error("S3 endpoint must be https (http allowed only for localhost testing)");
    }
    this.pathStyle = options.pathStyle ?? true;
    this.prefix = options.prefix?.replace(/\/$/, "") ?? "";
    // Clamp: presigned URLs are bearer creds, AWS max is 7 days.
    const requested = options.urlExpiresSeconds ?? 900;
    this.urlExpires = Math.min(604800, Math.max(60, requested));
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private objectKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const { url, headers } = signRequest({
      method: "PUT",
      endpoint: this.endpoint,
      bucket: this.options.bucket,
      key: this.objectKey(key),
      pathStyle: this.pathStyle,
      body: data,
      contentType,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      sessionToken: this.options.sessionToken,
      region: this.options.region,
    });
    const response = await this.fetchImpl(url, {
      method: "PUT",
      headers,
      body: new Uint8Array(data),
    });
    if (!response.ok) {
      throw new Error(`S3 put failed: ${response.status} ${await response.text().catch(() => "")}`);
    }
  }

  async get(key: string): Promise<Buffer | undefined> {
    const { url, headers } = signRequest({
      method: "GET",
      endpoint: this.endpoint,
      bucket: this.options.bucket,
      key: this.objectKey(key),
      pathStyle: this.pathStyle,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      sessionToken: this.options.sessionToken,
      region: this.options.region,
    });
    const response = await this.fetchImpl(url, { headers });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`S3 get failed: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async url(key: string): Promise<string | undefined> {
    return presignUrl({
      method: "GET",
      endpoint: this.endpoint,
      bucket: this.options.bucket,
      key: this.objectKey(key),
      pathStyle: this.pathStyle,
      expiresSeconds: this.urlExpires,
      accessKeyId: this.options.accessKeyId,
      secretAccessKey: this.options.secretAccessKey,
      sessionToken: this.options.sessionToken,
      region: this.options.region,
    });
  }
}

export interface ArtifactConfig {
  dir: string;
  s3?: {
    bucket: string;
    region: string;
    endpoint?: string;
    prefix?: string;
    pathStyle?: boolean;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    urlExpiresSeconds?: number;
  };
}

export function createArtifactStore(config: ArtifactConfig): ArtifactStore {
  if (config.s3) return new S3ArtifactStore(config.s3);
  return new LocalArtifactStore(config.dir);
}
