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
  ["100::", 64], // discard-only
  ["64:ff9b:1::", 48], // local-use NAT64: translates to whatever the local network routes
  ["2001::", 32], // Teredo: the IPv4 address inside is obfuscated, and nobody needs it
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated, still routed by some stacks)
  ["ff00::", 8], // multicast
] as const) {
  privateRanges.addSubnet(network, prefix, "ipv6");
}

/**
 * Whether an IP address is anything but public: private, loopback,
 * link-local, site-local, carrier-grade NAT, multicast or reserved. An IPv6
 * address that carries an IPv4 one is judged by that too: IPv4-compatible
 * (`::127.0.0.1`), IPv4-mapped (`::ffff:127.0.0.1`), IPv4-translated
 * (`::ffff:0:127.0.0.1`), NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`).
 * Anything that is not an IP address counts as private.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateRanges.check(address, "ipv4");
  if (family !== 6) return true;
  const groups = ipv6Groups(address.replace(/%.*$/, ""));
  if (!groups) return true;
  const embedded = embeddedIPv4(groups);
  if (embedded !== undefined && privateRanges.check(embedded, "ipv4")) return true;
  return privateRanges.check(groups.map((group) => group.toString(16)).join(":"), "ipv6");
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

/**
 * The IPv4 address an IPv6 address carries, where the network would deliver
 * it to that IPv4 host: IPv4-compatible and IPv4-mapped (`::/96`,
 * `::ffff:0:0/96`), IPv4-translated (`::ffff:0:0:0/96`), NAT64
 * (`64:ff9b::/96`) and 6to4 (`2002:AABB:CCDD::/48`).
 */
function embeddedIPv4(groups: readonly number[]): string | undefined {
  const dotted = (high: number, low: number): string => [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  const zero = (from: number, to: number): boolean => groups.slice(from, to).every((group) => group === 0);
  if (zero(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) return dotted(groups[6], groups[7]);
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return dotted(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return dotted(groups[6], groups[7]);
  if (groups[0] === 0x2002) return dotted(groups[1], groups[2]);
  return undefined;
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
