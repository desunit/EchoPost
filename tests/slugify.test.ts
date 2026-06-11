import { describe, expect, it } from "vitest";
import { slugify, uniqueSlug } from "../src/lib/slugify.js";

describe("slugify", () => {
  it("matches the PRD example", () => {
    expect(slugify("Everyone can now build apps with AI, so distribution is the real challenge")).toBe(
      "everyone-can-now-build-apps-with-ai-so-distribution-is-the-real-challenge",
    );
  });

  it("lowercases, hyphenates, and collapses repeats", () => {
    expect(slugify("Hello --  World!!")).toBe("hello-world");
  });

  it("transliterates diacritics", () => {
    expect(slugify("Café naïve résumé")).toBe("cafe-naive-resume");
  });

  it("drops apostrophes instead of hyphenating", () => {
    expect(slugify("Don't panic")).toBe("dont-panic");
  });

  it("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("post");
  });

  it("enforces uniqueness with numeric suffixes", () => {
    const taken = new Set(["my-post", "my-post-2"]);
    expect(uniqueSlug("My Post", (s) => taken.has(s))).toBe("my-post-3");
  });
});
