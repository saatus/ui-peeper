/**
 * URL validation for a service whose whole job is fetching URLs strangers give it.
 *
 * Without this, `POST /api/capture {url: "http://169.254.169.254/..."}` turns the
 * box into a screenshot-as-a-service for its own cloud metadata endpoint. So every
 * URL is checked twice: the scheme/shape up front, then every IP the hostname
 * actually resolves to. Redirects get re-checked at each hop by the caller.
 */

import dns from 'node:dns/promises';
import { TRUST_NETWORK } from './config.js';

export class UrlRejected extends Error {
  constructor(message, code = 'rejected') {
    super(message);
    this.name = 'UrlRejected';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ parsing */

/** Dotted-quad to a 32-bit int, or null. Rejects octal/short forms on purpose. */
function ipv4ToInt(str) {
  const parts = str.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    // No leading zeros: `0177.0.0.1` is octal loopback to some resolvers, and
    // treating it as decimal 177 would wave it through as a public address.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** IPv6 (including `::` compression and trailing IPv4) to a BigInt, or null. */
function ipv6ToBigInt(input) {
  let s = input;

  const pct = s.indexOf('%'); // strip zone id
  if (pct !== -1) s = s.slice(0, pct);

  // Rewrite a trailing `…:1.2.3.4` into `…:102:304` so one parser handles both.
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(s.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = Math.floor(v4 / 0x10000).toString(16);
    const lo = (v4 % 0x10000).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;

  const hextets = (part) => {
    if (part === '') return [];
    const out = [];
    for (const h of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
      out.push(Number.parseInt(h, 16));
    }
    return out;
  };

  const head = hextets(halves[0]);
  if (head === null) return null;
  const tail = halves.length === 2 ? hextets(halves[1]) : [];
  if (tail === null) return null;

  const total = head.length + tail.length;
  if (halves.length === 2) {
    if (total > 7) return null; // `::` has to stand for at least one zero group
  } else if (total !== 8) {
    return null;
  }

  const groups = [...head, ...new Array(8 - total).fill(0), ...tail];
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(g);
  return n;
}

/* ----------------------------------------------------------------- blocklist */

const v4Mask = (prefix) => (prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);

const V4_BLOCKED = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — includes 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
  // `>>> 0` on both sides: `&` yields a signed int32, so any base above 2^31
  // (169.254/16, 172.16/12, 224/4, 240/4) would otherwise compare negative
  // against an unsigned address and never match.
].map(([base, prefix]) => ({
  base: (ipv4ToInt(base) & v4Mask(prefix)) >>> 0,
  mask: v4Mask(prefix),
}));

const v6Mask = (prefix) =>
  prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);

const V6_BLOCKED = [
  ['::', 96], // unspecified, loopback, and deprecated IPv4-compatible
  ['100::', 64], // discard-only
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['2001:db8::', 32], // documentation
].map(([base, prefix]) => ({ base: ipv6ToBigInt(base) & v6Mask(prefix), mask: v6Mask(prefix) }));

// Ranges that wrap an IPv4 address; unwrap and judge by the IPv4 rules instead.
const V6_EMBEDS_V4 = [
  { base: ipv6ToBigInt('::ffff:0:0'), mask: v6Mask(96), shift: 0n }, // IPv4-mapped
  { base: ipv6ToBigInt('64:ff9b::'), mask: v6Mask(96), shift: 0n }, // NAT64
  { base: ipv6ToBigInt('2002::'), mask: v6Mask(16), shift: 80n }, // 6to4
];

/**
 * True when an address is a normal, routable, public one.
 * Anything unparseable is treated as unsafe rather than assumed fine.
 */
export function isPublicAddress(ip) {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return !V4_BLOCKED.some(({ base, mask }) => (v4 & mask) >>> 0 === base);

  const v6 = ipv6ToBigInt(ip);
  if (v6 === null) return false;

  for (const { base, mask, shift } of V6_EMBEDS_V4) {
    if ((v6 & mask) === base) {
      const embedded = Number((v6 >> shift) & 0xffffffffn);
      const dotted = [24, 16, 8, 0].map((s) => (embedded >>> s) & 0xff).join('.');
      return isPublicAddress(dotted);
    }
  }

  return !V6_BLOCKED.some(({ base, mask }) => (v6 & mask) === base);
}

/* -------------------------------------------------------------------- public */

/**
 * Accepts what a person would actually paste — `example.com`, `example.com/path`,
 * a full URL — and returns a parsed http(s) URL, or throws UrlRejected.
 * No DNS here, so this stays synchronous and cheap.
 */
export function normalizeUrl(input) {
  if (typeof input !== 'string') throw new UrlRejected('A url string is required.', 'missing_url');

  const trimmed = input.trim();
  if (trimmed === '') throw new UrlRejected('A url string is required.', 'missing_url');
  if (trimmed.length > 2048) throw new UrlRejected('That url is unreasonably long.', 'too_long');

  // Only prepend a scheme when there is no scheme at all, so `javascript:…`
  // and `file:…` still land in the protocol check below instead of being hidden.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  let url;
  try {
    url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    throw new UrlRejected('That does not look like a valid url.', 'unparseable');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlRejected('Only http and https urls can be loaded.', 'bad_protocol');
  }
  if (url.username || url.password) {
    throw new UrlRejected('Urls with embedded credentials are not accepted.', 'has_credentials');
  }
  if (!url.hostname) throw new UrlRejected('That url has no host.', 'no_host');

  return url;
}

/** URL.hostname keeps the brackets on IPv6 literals; the IP parsers do not want them. */
export function bareHostname(url) {
  const h = url.hostname;
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/**
 * Full check: shape, then every address the host resolves to. A hostname with
 * even one private address is refused outright rather than partially allowed.
 *
 * Note the residual gap: DNS is resolved here, and Chromium resolves it again
 * when it navigates. A record that changes between those two lookups (DNS
 * rebinding) would slip past. Closing that properly means pinning the resolved
 * IP into the request, which is why the README recommends network-level egress
 * restriction as the real control. This is defence in depth, not the only layer.
 */
export async function assertSafeUrl(input) {
  const url = typeof input === 'string' ? normalizeUrl(input) : input;
  const host = bareHostname(url);

  if (TRUST_NETWORK) return { url, addresses: [] };

  // An IP literal needs no lookup, and must not get one.
  if (ipv4ToInt(host) !== null || ipv6ToBigInt(host) !== null) {
    if (!isPublicAddress(host)) {
      throw new UrlRejected('That address is not publicly routable.', 'private_address');
    }
    return { url, addresses: [host] };
  }

  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw new UrlRejected('That address is not publicly routable.', 'private_address');
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UrlRejected(`Could not resolve ${host}.`, 'dns_failure');
  }
  if (records.length === 0) throw new UrlRejected(`Could not resolve ${host}.`, 'dns_failure');

  for (const { address } of records) {
    if (!isPublicAddress(address)) {
      throw new UrlRejected('That host resolves to a private address.', 'private_address');
    }
  }

  return { url, addresses: records.map((r) => r.address) };
}
