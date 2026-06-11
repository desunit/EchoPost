import { describe, expect, it } from "vitest";
import { embedXReferences, type XRefCard } from "../src/lib/x-embed.js";
import { config } from "../src/config/index.js";

const OWN_ID = "25348232";
const OWN_USER = "desunit";

function run(html: string, archive: Record<string, XRefCard> = {}) {
  return embedXReferences(html, {
    ownUserId: OWN_ID,
    ownUsername: OWN_USER,
    lookup: (id) => archive[id] ?? null,
  });
}

const anchor = (href: string, text: string) => `<a href="${href}" rel="noopener">${text}</a>`;

describe("embedXReferences", () => {
  it("turns another account's quoted tweet into the X widget", () => {
    const { html, hasWidget } = run(`<p>great take ${anchor("https://twitter.com/jackfriks/status/123", "x.com/jack…")}</p>`);
    expect(hasWidget).toBe(true);
    expect(html).toContain('<blockquote class="twitter-tweet"');
    expect(html).toContain('href="https://twitter.com/jackfriks/status/123"');
    expect(html).not.toContain("x.com/jack…");
  });

  it("turns the author's own tweet into an internal reference card when it's in the archive", () => {
    const archive = { "999": { slug: "my-post", title: "My Post", excerpt: "A short summary.", thumbnailUrl: "/media/x.jpg" } };
    const { html, hasWidget } = run(`<p>see ${anchor("https://x.com/desunit/status/999", "x.com/desunit…")}</p>`, archive);
    expect(hasWidget).toBe(false);
    expect(html).toContain(`class="x-ref-card" href="${config.basePath}/my-post"`);
    expect(html).toContain("My Post");
    expect(html).toContain("A short summary.");
    expect(html).toContain('src="/media/x.jpg"');
  });

  it("matches own account by numeric user id too", () => {
    const archive = { "999": { slug: "my-post", title: "My Post", excerpt: "x" } };
    const { html } = run(`${anchor("https://twitter.com/25348232/status/999", "x.com/…")}`, archive);
    expect(html).toContain('class="x-ref-card"');
  });

  it("leaves the author's own tweet as a link when it's not in the archive", () => {
    const { html, hasWidget } = run(`${anchor("https://x.com/desunit/status/404", "x.com/desunit…")}`);
    expect(hasWidget).toBe(false);
    expect(html).toContain(anchor("https://x.com/desunit/status/404", "x.com/desunit…"));
  });

  it("never touches the 'View on X' section footer link", () => {
    const link = anchor("https://x.com/desunit/status/777", "View on X");
    const { html } = run(`<!-- x:777 --> ${link}`, { "777": { slug: "s", title: "t", excerpt: "e" } });
    expect(html).toContain(link);
    expect(html).not.toContain("x-ref-card");
  });

  it("leaves non-X links untouched", () => {
    const link = anchor("https://github.com/desunit/repo", "github.com/…");
    const { html, hasWidget } = run(`<p>${link}</p>`);
    expect(html).toContain(link);
    expect(hasWidget).toBe(false);
  });
});
