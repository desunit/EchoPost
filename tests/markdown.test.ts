import { describe, expect, it } from "vitest";
import { renderMarkdown, markdownToText, makeExcerpt, countWords, htmlToMarkdown, youTubeId } from "../src/lib/markdown.js";

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

  it("keeps inline <video> with poster and playback attributes", () => {
    const html = renderMarkdown('<video src="/media/clip.mp4" poster="/media/poster.jpg" controls preload="metadata"></video>');
    expect(html).toContain("<video");
    expect(html).toContain('src="/media/clip.mp4"');
    expect(html).toContain('poster="/media/poster.jpg"');
    expect(html).toContain("controls");
  });

  it("keeps autoplay/loop/muted on inline <video> (animated GIFs)", () => {
    const html = renderMarkdown('<video src="/media/gif.mp4" autoplay loop muted playsinline></video>');
    expect(html).toContain("autoplay");
    expect(html).toContain("loop");
    expect(html).toContain("muted");
    expect(html).toContain("playsinline");
  });

  it("marks off-site links rel=nofollow", () => {
    const html = renderMarkdown("[external](https://random-third-party.example/page)");
    expect(html).toContain('rel="nofollow noopener noreferrer"');
  });

  it("does not nofollow relative/internal links", () => {
    const html = renderMarkdown("[home](/about)");
    expect(html).toContain('rel="noopener"');
    expect(html).not.toContain("nofollow");
  });

  it("does not nofollow mailto links", () => {
    const html = renderMarkdown("[mail](mailto:hi@example.com)");
    expect(html).not.toContain("nofollow");
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

describe("YouTube embeds", () => {
  it("extracts the video id from common URL forms", () => {
    expect(youTubeId("https://www.youtube.com/embed/5QcCeSsNRks?feature=oembed")).toBe("5QcCeSsNRks");
    expect(youTubeId("https://youtu.be/QX_oy9614HQ")).toBe("QX_oy9614HQ");
    expect(youTubeId("https://www.youtube.com/watch?v=FnL4VeUaZiw&t=10s")).toBe("FnL4VeUaZiw");
    expect(youTubeId("https://example.com/not-a-video")).toBeNull();
  });

  it("converts a WordPress YouTube oembed iframe to a nocookie embed", () => {
    const wp = '<figure class="wp-block-embed is-provider-youtube"><div class="wp-block-embed__wrapper">' +
      '<iframe title="Great talk" src="https://www.youtube.com/embed/5QcCeSsNRks?feature=oembed"></iframe></div></figure>';
    const md = htmlToMarkdown(wp);
    expect(md).toContain('<iframe class="yt-embed"');
    expect(md).toContain("https://www.youtube-nocookie.com/embed/5QcCeSsNRks");
    expect(md).toContain('title="Great talk"');
  });

  it("keeps the YouTube iframe through render/sanitize but drops other hosts", () => {
    const ok = renderMarkdown('<iframe class="yt-embed" src="https://www.youtube-nocookie.com/embed/abc12345678"></iframe>');
    expect(ok).toContain("youtube-nocookie.com/embed/abc12345678");
    const evil = renderMarkdown('<iframe src="https://evil.example.com/x"></iframe>');
    expect(evil).not.toContain("evil.example.com");
  });

  it("turns a non-YouTube iframe into a plain link so nothing is lost", () => {
    expect(htmlToMarkdown('<iframe src="https://example.com/widget"></iframe>'))
      .toContain("[Embedded content](https://example.com/widget)");
  });
});

describe("WordPress content-toggle accordions", () => {
  const accordion =
    '<div class="wp-block-ub-content-toggle-accordion">' +
    '<div class="wp-block-ub-content-toggle-accordion-title-wrap">' +
    '<p class="wp-block-ub-content-toggle-accordion-title">Deepseek (DeepThink)</p>' +
    '<div class="wp-block-ub-content-toggle-accordion-toggle-wrap"><span></span></div></div>' +
    '<div class="wp-block-ub-content-toggle-accordion-content-wrap ub-hide"><p>Hidden reasoning here.</p></div></div>';

  it("converts a collapsible block to a native <details>/<summary>", () => {
    const md = htmlToMarkdown(accordion);
    expect(md).toContain("<details><summary>Deepseek (DeepThink)</summary>");
    expect(md).toContain("</details>");
    expect(md).toContain("Hidden reasoning here.");
  });

  it("renders the collapsible through sanitize as real <details>/<summary>", () => {
    const html = renderMarkdown(htmlToMarkdown(accordion));
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>Deepseek (DeepThink)</summary>");
    expect(html).toContain("<p>Hidden reasoning here.</p>");
  });
});
