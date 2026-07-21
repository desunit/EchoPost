import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "../src/lib/csp.js";
import { normalizeGaMeasurementId } from "../src/config/index.js";

const STRICT =
  "default-src 'self'; img-src 'self' data: https://pbs.twimg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' https://platform.twitter.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://platform.twitter.com; frame-ancestors 'self'";

describe("buildContentSecurityPolicy", () => {
  it("returns the strict, GA-free policy when no measurement ID is set", () => {
    expect(buildContentSecurityPolicy()).toBe(STRICT);
    expect(buildContentSecurityPolicy({})).toBe(STRICT);
    expect(buildContentSecurityPolicy({ gaMeasurementId: "" })).toBe(STRICT);
    // A nonce alone (no GA) must not widen the policy.
    expect(buildContentSecurityPolicy({ nonce: "abc123" })).toBe(STRICT);
  });

  it("widens script-src, connect-src and img-src when GA is enabled", () => {
    const csp = buildContentSecurityPolicy({ gaMeasurementId: "G-ABC123", nonce: "n0nce" });
    expect(csp).toContain("script-src 'self' https://platform.twitter.com https://www.googletagmanager.com 'nonce-n0nce'");
    expect(csp).toContain("img-src 'self' data: https://pbs.twimg.com https://www.google-analytics.com");
    expect(csp).toContain(
      "connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com",
    );
    // Base directives are preserved.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("omits the nonce token when none is provided but still allows the GA origin", () => {
    const csp = buildContentSecurityPolicy({ gaMeasurementId: "G-ABC123" });
    expect(csp).toContain("script-src 'self' https://platform.twitter.com https://www.googletagmanager.com");
    expect(csp).not.toContain("nonce-");
  });
});

describe("normalizeGaMeasurementId", () => {
  it("accepts a valid GA4 measurement ID", () => {
    expect(normalizeGaMeasurementId("G-RMYV1WV23E")).toBe("G-RMYV1WV23E");
    expect(normalizeGaMeasurementId("  G-ABC123  ")).toBe("G-ABC123");
  });

  it("disables GA for empty or unsafe values", () => {
    expect(normalizeGaMeasurementId("")).toBe("");
    expect(normalizeGaMeasurementId("   ")).toBe("");
    // Anything with characters outside [A-Za-z0-9-] is rejected (injection guard).
    expect(normalizeGaMeasurementId("G-ABC'><script>")).toBe("");
    expect(normalizeGaMeasurementId("G ABC")).toBe("");
    expect(normalizeGaMeasurementId("G-ABC;connect-src")).toBe("");
  });
});
