import assert from "node:assert/strict";
import { test } from "node:test";
import { BlockedUrlError, allowedPrivateHosts, assertPublicUrl, isPrivateAddress } from "./index.js";

test("private, loopback, link-local and reserved addresses are recognised", () => {
  for (const address of [
    "127.0.0.1",
    "127.8.8.8",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.10",
    "169.254.169.254",
    "169.254.170.2",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::10.0.0.1",
    "not-an-address",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "64:ff9b::808:808"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("IPv6 forms that carry a private IPv4 address, and deprecated local ranges, are private", () => {
  for (const address of [
    "::127.0.0.1", // IPv4-compatible
    "::7f00:1",
    "::10.0.0.1",
    "::ffff:0:127.0.0.1", // IPv4-translated
    "::ffff:0:a9fe:a9fe",
    "0:0:0:0:0:ffff:7f00:1",
    "64:ff9b:1::8.8.8.8", // local-use NAT64
    "64:ff9b:1:abcd::1",
    "2002:7f00:1::", // 6to4 around 127.0.0.1
    "2002:a9fe:a9fe::1", // 6to4 around 169.254.169.254
    "2002:c0a8:101:1::1", // 6to4 around 192.168.1.1
    "fec0::1", // site-local
    "feff::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
    "100::1", // discard-only
    "fe80::1%eth0",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["2002:808:808::1", "::ffff:0:8.8.8.8", "::ffff:8.8.8.8", "2001:4860:4860::8888", "2a00:1450::1"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("a URL passes only when every address of its host is public", async () => {
  const dns: Record<string, string[]> = {
    "example.com": ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    "rebind.example": ["93.184.215.14", "127.0.0.1"],
    "metadata.example": ["169.254.169.254"],
  };
  const resolve = async (host: string): Promise<string[]> => dns[host] ?? [];
  assert.equal((await assertPublicUrl("https://example.com/page", { resolve })).hostname, "example.com");
  for (const url of [
    "http://rebind.example/",
    "http://metadata.example/latest/meta-data/",
    "http://127.0.0.1:8787/api/sessions",
    "http://2130706433/", // 127.0.0.1 written as a number
    "http://0x7f.1/",
    "http://[::ffff:169.254.169.254]/",
    "http://localhost:8787/",
    "http://api.localhost./",
    "http://0.0.0.0:8787/",
  ]) {
    await assert.rejects(assertPublicUrl(url, { resolve }), BlockedUrlError, url);
  }
});

test("only http(s) URLs are fetched", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "not a url"]) {
    await assert.rejects(assertPublicUrl(url, { resolve: async () => ["93.184.215.14"] }), BlockedUrlError, url);
  }
});

test("hosts on the allow list may be private: exact names and whole subdomains", async () => {
  const resolve = async (): Promise<string[]> => ["192.168.1.20"];
  const allowHosts = allowedPrivateHosts(" scout.internal.example , *.lan ");
  assert.deepEqual(allowHosts, ["scout.internal.example", "*.lan"]);
  await assertPublicUrl("http://scout.internal.example/api", { resolve, allowHosts });
  await assertPublicUrl("http://nas.lan/", { resolve, allowHosts });
  await assert.rejects(assertPublicUrl("http://lan/", { resolve, allowHosts }), BlockedUrlError);
  await assert.rejects(assertPublicUrl("http://other.internal.example/", { resolve, allowHosts }), BlockedUrlError);
});
