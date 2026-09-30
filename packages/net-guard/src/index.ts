import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Keeping requests made on the model's behalf off private networks.
 *
 * `web_fetch` (on the runner) and the `browser` tool (in the server) fetch
 * URLs a model picked, and a model can be steered by whatever it read last.
 * From those machines, a private address means cloud metadata (credentials),
 * hat's own API, the host's other services and the rest of the network, so
 * every address a host name resolves to has to be public. A redirect is a new
 * URL: callers check each hop.
 *
 * DNS can still answer differently when the request itself connects (DNS
 * rebinding); the check narrows that to a deliberate, well-timed attack.
 */

const privateRanges = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this network": 0.0.0.0 reaches the local host
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv6");
}

/**
 * Whether an IP address is anything but public: private, loopback,
 * link-local, carrier-grade NAT, multicast or reserved. IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`) is judged by its IPv4 address, as is NAT64
 * (`64:ff9b::/96`). Anything that is not an IP address counts as private.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateRanges.check(address, "ipv4");
  if (family !== 6) return true;
  const nat64 = nat64Target(address);
  return nat64 ? privateRanges.check(nat64, "ipv4") : privateRanges.check(address, "ipv6");
}

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

export interface UrlCheckOptions {
  /**
   * Host names that may be private: your own services. Exact names, or
   * `*.example` for every name under one.
   */
  allowHosts?: readonly string[];
  /** Resolve a host name to every address it has (tests replace this). */
  resolve?: (hostname: string) => Promise<string[]>;
}

/**
 * Throw a `BlockedUrlError` unless `url` is http(s) and its host is public:
 * an IP address outside the private ranges, or a name whose every address
 * is. Names in `allowHosts` skip the address check.
 */
export async function assertPublicUrl(url: string | URL, options: UrlCheckOptions = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    throw new BlockedUrlError(`not a valid URL: ${String(url)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedUrlError(`only http(s) URLs can be fetched, not ${parsed.protocol}`);
  }
  await resolvePublicHost(parsed.hostname, options);
  return parsed;
}

/**
 * Resolve a host name (or IP address) to an address it is safe to connect
 * to, or throw a `BlockedUrlError`. Connecting to the address returned,
 * instead of resolving the name again, keeps a second DNS answer from
 * steering the connection somewhere else.
 */
export async function resolvePublicHost(hostname: string, options: UrlCheckOptions = {}): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const resolve = options.resolve ?? resolveAll;
  if (isAllowed(host, options.allowHosts)) return isIP(host) ? host : (await resolve(host))[0] ?? host;
  const addresses =
    host === "localhost" || host.endsWith(".localhost") ? ["127.0.0.1"] : isIP(host) ? [host] : await resolve(host);
  if (addresses.length === 0) throw new BlockedUrlError(`${host} does not resolve`);
  const internal = addresses.find(isPrivateAddress);
  if (internal !== undefined) {
    const via = internal === host ? "" : ` (it resolves to ${internal})`;
    throw new BlockedUrlError(`${host} is a private or internal address${via}`);
  }
  return addresses[0];
}

/**
 * The host names `HAT_ALLOW_PRIVATE_HOSTS` lets through: comma-separated,
 * exact or `*.suffix`.
 */
export function allowedPrivateHosts(value = process.env.HAT_ALLOW_PRIVATE_HOSTS): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowed(host: string, allowHosts: readonly string[] = []): boolean {
  return allowHosts.some((entry) => (entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry));
}

async function resolveAll(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** The IPv4 address inside a NAT64 (`64:ff9b::/96`) address, if it is one. */
function nat64Target(address: string): string | undefined {
  const groups = ipv6Groups(address);
  if (!groups || groups[0] !== 0x64 || groups[1] !== 0xff9b || groups.slice(2, 6).some(Boolean)) return undefined;
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
}

/** The eight 16-bit groups of an IPv6 address. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const parse = (part: string): number[] => (part ? part.split(":").map((group) => Number.parseInt(group, 16)) : []);
  const [head, tail] = text.split("::");
  if (tail === undefined) {
    const groups = parse(head);
    return groups.length === 8 ? groups : undefined;
  }
  const front = parse(head);
  const back = parse(tail);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}
