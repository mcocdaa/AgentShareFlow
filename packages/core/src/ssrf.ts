import * as dns from "node:dns/promises";
import { isIP } from "node:net";

export interface DnsLookupAddress {
  address: string;
  family: number;
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true; verbatim?: boolean },
) => Promise<DnsLookupAddress | DnsLookupAddress[]>;

export interface SafeUrlOptions {
  allowPrivate?: boolean;
  lookupFn?: DnsLookupFn;
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  const [a, b, c, d] = nums;
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined
  ) {
    return null;
  }
  return [a, b, c, d];
}

function isPrivateIpv4Octets(
  a: number,
  b: number,
  c: number,
  _d: number,
): boolean {
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function expandIpv6(ip: string): number[] | null {
  let working = ip.toLowerCase();
  const doubleColonIndex = working.indexOf("::");
  if (doubleColonIndex !== -1 && working.indexOf("::", doubleColonIndex + 2) !== -1) {
    return null;
  }

  // Convert trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) into two 16-bit hex groups.
  const lastColon = working.lastIndexOf(":");
  if (lastColon !== -1 && working.slice(lastColon + 1).includes(".")) {
    const octets = parseIpv4Octets(working.slice(lastColon + 1));
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const tokens = side.split(":");
    const out: number[] = [];
    for (const token of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      out.push(Number.parseInt(token, 16));
    }
    return out;
  };

  if (doubleColonIndex !== -1) {
    const left = parseSide(working.slice(0, doubleColonIndex));
    const right = parseSide(working.slice(doubleColonIndex + 2));
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    return [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const groups = parseSide(working);
  if (!groups || groups.length !== 8) return null;
  return groups;
}

function isPrivateIpv6(ip: string): boolean {
  const g = expandIpv6(ip);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g;
  if (
    g0 === undefined ||
    g1 === undefined ||
    g2 === undefined ||
    g3 === undefined ||
    g4 === undefined ||
    g5 === undefined ||
    g6 === undefined ||
    g7 === undefined
  ) {
    return true;
  }

  const firstFiveZero =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // ::/96 covers ::, ::1, and deprecated IPv4-compatible addresses.
  if (firstFiveZero && g5 === 0) return true;

  // ::ffff:0:0/96 IPv4-mapped IPv6 addresses.
  if (firstFiveZero && g5 === 0xffff) {
    return isPrivateIpv4Octets(g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff);
  }

  // 64:ff9b::/96 NAT64 well-known prefix.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIpv4Octets(g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff);
  }

  // fc00::/7 unique local addresses.
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local addresses.
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // fec0::/10 deprecated site-local addresses.
  if ((g0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 multicast addresses.
  if ((g0 & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 documentation prefix.
  if (g0 === 0x2001 && g1 === 0x0db8) return true;
  // 100::/64 discard-only prefix.
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;

  return false;
}

export function isPrivateIp(ip: string): boolean {
  let cleaned = ip.trim();
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    cleaned = cleaned.slice(1, -1);
  }
  const zoneIndex = cleaned.indexOf("%");
  if (zoneIndex !== -1) {
    cleaned = cleaned.slice(0, zoneIndex);
  }

  const version = isIP(cleaned);
  if (version === 4) {
    const octets = parseIpv4Octets(cleaned);
    if (!octets) return true;
    return isPrivateIpv4Octets(octets[0], octets[1], octets[2], octets[3]);
  }
  if (version === 6) {
    return isPrivateIpv6(cleaned);
  }
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  return false;
}

export async function assertSafeExternalUrl(
  rawUrl: string,
  opts: SafeUrlOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked unsupported URL protocol: ${url.protocol}`);
  }

  const rawHost = url.hostname.toLowerCase();
  const strippedHost = (
    rawHost.startsWith("[") && rawHost.endsWith("]")
      ? rawHost.slice(1, -1)
      : rawHost
  ).replace(/\.+$/, "");

  if (!strippedHost) {
    throw new Error("URL hostname is empty");
  }

  if (opts.allowPrivate) {
    return url;
  }

  if (isBlockedHostname(strippedHost)) {
    throw new Error(`Blocked private/internal hostname: ${strippedHost}`);
  }

  if (isIP(strippedHost) !== 0) {
    if (isPrivateIp(strippedHost)) {
      throw new Error(`Blocked private/internal IP address: ${strippedHost}`);
    }
    return url;
  }

  const lookupFn: DnsLookupFn = opts.lookupFn ?? dns.lookup;
  let resolved: DnsLookupAddress | DnsLookupAddress[];
  try {
    resolved = await lookupFn(strippedHost, { all: true, verbatim: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`DNS resolution failed for ${strippedHost}: ${reason}`);
  }

  const records = Array.isArray(resolved) ? resolved : [resolved];
  if (records.length === 0) {
    throw new Error(`DNS resolution returned no addresses for ${strippedHost}`);
  }

  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error(
        `Blocked private/internal resolved IP ${record.address} for ${strippedHost}`,
      );
    }
  }

  return url;
}
