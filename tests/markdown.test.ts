import { describe, expect, it } from "vitest";
import { renderMarkdown, markdownToText, makeExcerpt, countWords } from "../src/lib/markdown.js";

describe("markdown rendering", () => {
  it("renders basic markdown", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** text.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("sanitizes script tags", () => {
    const html = renderMarkdown('Hello <script>alert("xss")</script> world');
    expect(html).not.toContain("<script>");
  });

  it("strips javascript: URLs", () => {
    const html = renderMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("adds lazy loading to images", () => {
    const html = renderMarkdown("![alt](https://example.com/a.png)");
    expect(html).toContain('loading="lazy"');
  });

  it("extracts plain text", () => {
    expect(markdownToText("# Hi\n\nSome *text* here.")).toBe("Hi Some text here.");
  });

  it("counts words", () => {
    expect(countWords("one two three")).toBe(3);
  });

  it("builds excerpts on word boundaries", () => {
    const excerpt = makeExcerpt("word ".repeat(100), 50);
    expect(excerpt.length).toBeLessThanOrEqual(51);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
