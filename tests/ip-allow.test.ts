import { describe, expect, it } from "vitest";
import { ipAllowed, parseAllowlist } from "../src/lib/ip-allow.js";

describe("parseAllowlist", () => {
  it("splits on commas and whitespace, trimming blanks", () => {
    expect(parseAllowlist(" 1.2.3.4, 5.6.7.8 \n10.0.0.0/8 ")).toEqual(["1.2.3.4", "5.6.7.8", "10.0.0.0/8"]);
    expect(parseAllowlist("")).toEqual([]);
  });
});

describe("ipAllowed", () => {
  it("matches an exact IPv4 address", () => {
    expect(ipAllowed("203.0.113.4", ["203.0.113.4"])).toBe(true);
    expect(ipAllowed("203.0.113.5", ["203.0.113.4"])).toBe(false);
  });

  it("matches IPv4 CIDR ranges", () => {
    expect(ipAllowed("10.20.30.40", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.20.30.40", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("192.168.1.50", ["192.168.1.0/24"])).toBe(true);
    expect(ipAllowed("192.168.2.50", ["192.168.1.0/24"])).toBe(false);
  });

  it("treats IPv4-mapped IPv6 as IPv4 so a plain IPv4 entry still matches", () => {
    expect(ipAllowed("::ffff:203.0.113.4", ["203.0.113.4"])).toBe(true);
    expect(ipAllowed("::ffff:203.0.113.4", ["203.0.113.0/24"])).toBe(true);
  });

  it("matches IPv6 exact and CIDR", () => {
    expect(ipAllowed("2001:db8::1", ["2001:db8::1"])).toBe(true);
    expect(ipAllowed("2001:db8:dead:beef::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:dead::1", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("::1", ["::1"])).toBe(true);
  });

  it("does not match across address families", () => {
    expect(ipAllowed("203.0.113.4", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["203.0.113.0/24"])).toBe(false);
  });

  it("returns false for an empty allowlist or an unparseable IP", () => {
    expect(ipAllowed("203.0.113.4", [])).toBe(false);
    expect(ipAllowed("not-an-ip", ["203.0.113.4"])).toBe(false);
  });

  it("a /0 entry matches any address of the same family", () => {
    expect(ipAllowed("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
    expect(ipAllowed("2001:db8::1", ["::/0"])).toBe(true);
  });

  it("ignores invalid entries but honors valid ones in the same list", () => {
    expect(ipAllowed("203.0.113.4", ["garbage", "203.0.113.4"])).toBe(true);
    expect(ipAllowed("203.0.113.4", ["203.0.113.4/99"])).toBe(false); // bad prefix ignored
  });
});
