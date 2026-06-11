import net from "node:net";

/**
 * IP allowlist matching for the admin area. Supports exact IPv4/IPv6 addresses
 * and CIDR ranges (e.g. "203.0.113.4", "203.0.113.0/24", "2001:db8::/32").
 * IPv4-mapped IPv6 addresses ("::ffff:203.0.113.4") are treated as IPv4 so a
 * plain IPv4 allowlist entry still matches a request that arrives mapped.
 *
 * `req.ip` is the source — with Fastify `trustProxy` enabled it is already
 * derived from `X-Forwarded-For`, so a reverse proxy's forwarded client IP is
 * what gets checked here.
 */

interface Addr {
  v: 4 | 6;
  n: bigint;
}

function ipv6ToBigInt(s: string): bigint | null {
  // Expand a possible "::" gap into the missing zero groups.
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0]!.split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1]!.split(":") : []) : null;
  let groups: string[];
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    const part = parseInt(g || "0", 16);
    if (Number.isNaN(part) || part < 0 || part > 0xffff) return null;
    n = (n << 16n) | BigInt(part);
  }
  return n;
}

function parseIp(ip: string): Addr | null {
  let s = ip.trim();
  const zone = s.indexOf("%"); // strip zone id, e.g. fe80::1%eth0
  if (zone >= 0) s = s.slice(0, zone);
  const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) s = mapped[1]!;

  if (net.isIPv4(s)) {
    let n = 0n;
    for (const part of s.split(".")) n = (n << 8n) | BigInt(Number(part));
    return { v: 4, n };
  }
  if (net.isIPv6(s)) {
    const n = ipv6ToBigInt(s);
    return n === null ? null : { v: 6, n };
  }
  return null;
}

/** Parse a comma/space-separated allowlist string into entries. */
export function parseAllowlist(raw: string): string[] {
  return raw.split(/[\s,]+/).map((e) => e.trim()).filter(Boolean);
}

/** True if `ip` matches any exact address or CIDR range in `entries`. */
export function ipAllowed(ip: string, entries: string[]): boolean {
  const addr = parseIp(ip);
  if (!addr) return false;
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    const base = parseIp(slash >= 0 ? entry.slice(0, slash) : entry);
    if (!base || base.v !== addr.v) continue;
    const bits = base.v === 4 ? 32 : 128;
    const prefix = slash >= 0 ? Number(entry.slice(slash + 1)) : bits;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) continue;
    if (prefix === 0) return true;
    const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
    if ((addr.n & mask) === (base.n & mask)) return true;
  }
  return false;
}
