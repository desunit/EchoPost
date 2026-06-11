import { describe, expect, it } from "vitest";
import { stripInlineComment } from "../src/config/index.js";

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
