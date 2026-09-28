import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { presignUrl, signRequest } from "./sigv4.js";
import { LocalArtifactStore } from "./store.js";

test("presigned URL matches the AWS SigV4 example", () => {
  const url = presignUrl({
    method: "GET",
    endpoint: "https://examplebucket.s3.amazonaws.com",
    bucket: "examplebucket",
    key: "test.txt",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    pathStyle: false,
    expiresSeconds: 86400,
    now: new Date("2013-05-24T00:00:00.000Z"),
  });

  assert.equal(
    url,
    "https://examplebucket.s3.amazonaws.com/test.txt" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20130524T000000Z" +
      "&X-Amz-Expires=86400" +
      "&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

test("signRequest sets authorization and content hash headers", () => {
  const body = Buffer.from("hello");
  const { url, headers } = signRequest({
    method: "PUT",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    bucket: "mybucket",
    key: "a/b.txt",
    pathStyle: true,
    body,
    contentType: "text/plain",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date("2013-05-24T00:00:00.000Z"),
  });

  assert.equal(url, "https://s3.us-east-1.amazonaws.com/mybucket/a/b.txt");
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=/);
  assert.match(
    headers.authorization,
    /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/,
  );
  assert.equal(
    headers["x-amz-content-sha256"],
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

test("local artifact store round-trips and dedupes by key", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hat-art-"));
  const store = new LocalArtifactStore(dir);
  const data = Buffer.from("blob");
  await store.put("abc", data, "text/plain");
  assert.deepEqual(await store.get("abc"), data);
  assert.equal(await store.get("missing"), undefined);
  assert.equal(await store.url("abc"), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
