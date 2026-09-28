import crypto from "node:crypto";

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

export function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function shortDate(date: Date): string {
  return amzDate(date).slice(0, 8);
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

function objectPath(bucket: string, key: string, pathStyle: boolean): string {
  return pathStyle ? `/${bucket}/${encodeKeyPath(key)}` : `/${encodeKeyPath(key)}`;
}

export interface PresignOptions extends S3Credentials {
  method: "GET" | "PUT";
  endpoint: string;
  bucket: string;
  key: string;
  pathStyle: boolean;
  expiresSeconds: number;
  now?: Date;
}

/** SigV4 query-string presigned URL (AWS "Authenticating Requests: Query Parameters"). */
export function presignUrl(options: PresignOptions): string {
  const now = options.now ?? new Date();
  const date = shortDate(now);
  const timestamp = amzDate(now);
  const scope = `${date}/${options.region}/s3/aws4_request`;
  const canonicalUri = objectPath(options.bucket, options.key, options.pathStyle);
  const host = new URL(options.endpoint).host;

  const params: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${options.accessKeyId}/${scope}`],
    ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", String(options.expiresSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  if (options.sessionToken) params.push(["X-Amz-Security-Token", options.sessionToken]);
  params.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const canonicalQuery = params
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");

  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = crypto
    .createHmac("sha256", signingKey(options.secretAccessKey, date, options.region, "s3"))
    .update(stringToSign, "utf8")
    .digest("hex");

  const base = options.endpoint.replace(/\/$/, "");
  return `${base}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface SignRequestOptions extends S3Credentials {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  endpoint: string;
  bucket: string;
  key: string;
  pathStyle: boolean;
  body?: Buffer;
  contentType?: string;
  now?: Date;
}

/** SigV4 header-signed request for server-side S3 operations. */
export function signRequest(options: SignRequestOptions): {
  url: string;
  headers: Record<string, string>;
} {
  const now = options.now ?? new Date();
  const date = shortDate(now);
  const timestamp = amzDate(now);
  const scope = `${date}/${options.region}/s3/aws4_request`;
  const canonicalUri = objectPath(options.bucket, options.key, options.pathStyle);
  const host = new URL(options.endpoint).host;
  const payloadHash = sha256Hex(options.body ?? Buffer.alloc(0));

  const headers: Array<[string, string]> = [
    ["host", host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", timestamp],
  ];
  if (options.contentType) headers.push(["content-type", options.contentType]);
  if (options.sessionToken) headers.push(["x-amz-security-token", options.sessionToken]);
  headers.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const canonicalHeaders = headers.map(([key, value]) => `${key}:${value.trim()}\n`).join("");
  const signedHeaders = headers.map(([key]) => key).join(";");

  const canonicalRequest = [
    options.method,
    canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signature = crypto
    .createHmac("sha256", signingKey(options.secretAccessKey, date, options.region, "s3"))
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resultHeaders: Record<string, string> = { authorization };
  for (const [key, value] of headers) {
    if (key === "host") continue;
    resultHeaders[key] = value;
  }

  return {
    url: `${options.endpoint.replace(/\/$/, "")}${canonicalUri}`,
    headers: resultHeaders,
  };
}
