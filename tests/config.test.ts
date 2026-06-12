import { describe, expect, it } from "vitest";
import { stripInlineComment, parseTrustProxy } from "../src/config/index.js";

describe("stripInlineComment", () => {
  it("removes a dotenv-style inline comment (whitespace + #)", () => {
    expect(stripInlineComment("local # local | s3")).toBe("local");
    expect(stripInlineComment("openai        # anthropic | openai")).toBe("openai");
    expect(stripInlineComment("185.180.221.174   # optional")).toBe("185.180.221.174");
  });

  it("treats a whitespace-only-then-comment value as empty", () => {
    expect(stripInlineComment("    # forward to provider").trim()).toBe("");
  });

  it("preserves a # that is not a comment (no leading whitespace)", () => {
    expect(stripInlineComment("/page#section")).toBe("/page#section");
    expect(stripInlineComment("pa#ssword")).toBe("pa#ssword");
  });

  it("leaves plain values untouched", () => {
    expect(stripInlineComment("local")).toBe("local");
    expect(stripInlineComment("https://example.com/media")).toBe("https://example.com/media");
  });
});

describe("parseTrustProxy", () => {
  it("defaults an empty value to a single trusted proxy hop (not 'trust all')", () => {
    expect(parseTrustProxy("")).toBe(1);
    expect(parseTrustProxy("   ")).toBe(1);
  });

  it("treats 0/false as no trust (use the socket peer IP)", () => {
    expect(parseTrustProxy("0")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("False")).toBe(false);
  });

  it("parses a hop count", () => {
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("2")).toBe(2);
  });

  it("allows opting into trust-all explicitly", () => {
    expect(parseTrustProxy("true")).toBe(true);
  });

  it("parses a comma-separated CIDR/IP allowlist", () => {
    expect(parseTrustProxy("10.0.0.0/8, 192.168.0.0/16")).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
  });
});
