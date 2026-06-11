import { describe, expect, it, beforeEach } from "vitest";
import pino from "pino";
import { WordPressImportService, extractImageSrcs } from "../src/modules/wordpress/import-service.js";
import type { WpPost, WpFetchResult, WpContentType } from "../src/modules/wordpress/client.js";
import { PostsService } from "../src/modules/posts/service.js";
import { testDb } from "./helpers.js";
import type { DB } from "../src/db/index.js";

const log = pino({ level: "silent" });

function wpPost(partial: Partial<WpPost> & { id: number }): WpPost {
  return {
    date_gmt: "2023-01-15T10:00:00",
    modified_gmt: "2023-01-15T10:00:00",
    slug: `post-${partial.id}`,
    status: "publish",
    link: `https://blog.example.com/post-${partial.id}/`,
    title: { rendered: `Post ${partial.id}` },
    content: { rendered: "<p>Hello <strong>world</strong>. This is body copy.</p>" },
    excerpt: { rendered: "<p>An excerpt.</p>" },
    featured_media: 0,
    ...partial,
  };
}

/** Fake client returning fixed pages per content type, mimicking WP REST pagination. */
class FakeClient {
  // Pages of posts (index 0 = page 1). `pages` kept as an alias for posts.
  posts: WpPost[][] = [];
  wpPages: WpPost[][] = [];
  set pages(p: WpPost[][]) { this.posts = p; }
  async getContentPage(type: WpContentType, page: number): Promise<WpFetchResult> {
    const source = type === "pages" ? this.wpPages : this.posts;
    return { items: source[page - 1] ?? [], totalPages: source.length || 0 };
  }
}

/** Fake MediaService capturing mirror calls without touching the network. */
class FakeMedia {
  calls: Array<{ postId: string; sourceUrl: string; sortOrder?: number }> = [];
  failHosts: string[] = [];
  async mirrorRemote(input: { postId: string; sourceUrl: string; sortOrder?: number; altText?: string | null }) {
    if (this.failHosts.some((h) => input.sourceUrl.includes(h))) throw new Error("host not allowed");
    this.calls.push({ postId: input.postId, sourceUrl: input.sourceUrl, sortOrder: input.sortOrder });
    const checksum = String(this.calls.length);
    return {
      id: `media-${checksum}`,
      public_url: `/media/${checksum}.jpg`,
      mime_type: "image/jpeg",
      alt_text: input.altText ?? null,
    } as any;
  }
}

let db: DB;
let client: FakeClient;
let media: FakeMedia;
let importer: WordPressImportService;
let posts: PostsService;

beforeEach(() => {
  db = testDb();
  client = new FakeClient();
  media = new FakeMedia();
  importer = new WordPressImportService(db, client as any, log, media as any);
  posts = new PostsService(db);
});

describe("WordPress import", () => {
  it("imports a published post as a blog post, preserving the slug and date", async () => {
    client.pages = [[wpPost({ id: 1, slug: "my-first-post", date_gmt: "2022-03-04T09:00:00" })]];
    const summary = await importer.runImport();
    expect(summary.imported).toBe(1);

    const post = posts.getByWpPostId(1)!;
    expect(post.type).toBe("blog");
    expect(post.status).toBe("published");
    expect(post.slug).toBe("my-first-post");
    expect(post.published_at).toBe("2022-03-04T09:00:00Z");
    expect(post.canonical_url).toBe("https://blog.example.com/post-1/");
  });

  it("converts HTML content to markdown", async () => {
    client.pages = [[wpPost({
      id: 2,
      content: { rendered: "<h2>Heading</h2><p>Some <strong>bold</strong> and a <a href=\"https://x.com\">link</a>.</p>" },
    })]];
    await importer.runImport();
    const post = posts.getByWpPostId(2)!;
    expect(post.markdown_body).toContain("## Heading");
    expect(post.markdown_body).toContain("**bold**");
    expect(post.markdown_body).toContain("[link](https://x.com)");
  });

  it("preserves a YouTube embed from the post body", async () => {
    client.pages = [[wpPost({
      id: 8,
      content: { rendered:
        '<p>Watch this:</p><figure class="wp-block-embed is-provider-youtube">' +
        '<div class="wp-block-embed__wrapper"><iframe title="A Talk" ' +
        'src="https://www.youtube.com/embed/5QcCeSsNRks?feature=oembed"></iframe></div></figure>' },
    })]];
    await importer.runImport();
    const post = posts.getByWpPostId(8)!;
    expect(post.markdown_body).toContain("youtube-nocookie.com/embed/5QcCeSsNRks");
    // and it survives into the rendered, sanitized html_body
    expect(post.html_body).toContain('<iframe class="yt-embed"');
  });

  it("decodes HTML entities in titles", async () => {
    client.pages = [[wpPost({ id: 3, title: { rendered: "Tips &amp; Tricks &#8212; 2023" } })]];
    await importer.runImport();
    expect(posts.getByWpPostId(3)!.title).toBe("Tips & Tricks — 2023");
  });

  it("maps non-published WordPress posts to drafts", async () => {
    client.pages = [[wpPost({ id: 4, status: "draft" }), wpPost({ id: 5, status: "private" })]];
    await importer.runImport();
    expect(posts.getByWpPostId(4)!.status).toBe("draft");
    expect(posts.getByWpPostId(5)!.status).toBe("draft");
  });

  it("imports embedded categories and tags as tags, skipping Uncategorized", async () => {
    client.pages = [[wpPost({
      id: 6,
      _embedded: {
        "wp:term": [
          [{ name: "Uncategorized", taxonomy: "category" }, { name: "Engineering", taxonomy: "category" }],
          [{ name: "sqlite", taxonomy: "post_tag" }],
        ],
      },
    })]];
    await importer.runImport();
    const tagNames = (db.prepare(
      "SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?",
    ).all(posts.getByWpPostId(6)!.id) as any[]).map((r) => r.name).sort();
    expect(tagNames).toEqual(["Engineering", "sqlite"]);
  });

  it("is idempotent across repeated runs", async () => {
    client.pages = [[wpPost({ id: 7 })]];
    await importer.runImport();
    const second = await importer.runImport();
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM posts").get() as any).c).toBe(1);
  });

  it("imports WordPress pages as well as posts", async () => {
    client.posts = [[wpPost({ id: 30, slug: "a-post" })]];
    client.wpPages = [[wpPost({ id: 31, slug: "about", title: { rendered: "About" } })]];
    const summary = await importer.runImport();
    expect(summary.imported).toBe(2);
    expect(summary.byType).toEqual({ posts: 1, pages: 1 });

    // posts publish normally; pages land as "hidden" — reachable at /about but
    // kept out of the homepage, archive, RSS, sitemap and search.
    expect(posts.getByWpPostId(30)!.status).toBe("published");
    const aboutPage = posts.getByWpPostId(31)!;
    expect(aboutPage.type).toBe("blog");
    expect(aboutPage.slug).toBe("about");
    expect(aboutPage.title).toBe("About");
    expect(aboutPage.status).toBe("hidden");
  });

  it("only imports the configured content types", async () => {
    const postsOnly = new WordPressImportService(db, client as any, log, media as any, ["posts"]);
    client.posts = [[wpPost({ id: 40 })]];
    client.wpPages = [[wpPost({ id: 41 })]];
    const summary = await postsOnly.runImport();
    expect(summary.imported).toBe(1);
    expect(posts.getByWpPostId(40)).toBeTruthy();
    expect(posts.getByWpPostId(41)).toBeUndefined();
  });

  it("paginates across multiple pages", async () => {
    client.pages = [[wpPost({ id: 10 }), wpPost({ id: 11 })], [wpPost({ id: 12 })]];
    const summary = await importer.runImport();
    expect(summary.fetched).toBe(3);
    expect(summary.imported).toBe(3);
  });

  it("mirrors inline + featured images and rewrites the body to local URLs", async () => {
    client.pages = [[wpPost({
      id: 20,
      content: { rendered: '<p>Intro</p><img src="https://blog.example.com/wp-content/uploads/a.jpg" alt="A"><p>Outro</p>' },
      featured_media: 99,
      _embedded: { "wp:featuredmedia": [{ source_url: "https://blog.example.com/wp-content/uploads/hero.jpg", alt_text: "Hero" }] },
    })]];
    const summary = await importer.runImport();
    expect(summary.mediaMirrored).toBe(2); // featured + inline

    const post = posts.getByWpPostId(20)!;
    // body no longer references the WordPress host; rewritten to /media/*
    expect(post.markdown_body).not.toContain("blog.example.com");
    expect(post.markdown_body).toContain("/media/");
    // featured image becomes the og image (mirrored first → media-1)
    expect(post.og_image_media_id).toBe("media-1");
  });

  it("keeps importing the post even when an image mirror fails", async () => {
    media.failHosts = ["a.jpg"];
    client.pages = [[wpPost({
      id: 21,
      content: { rendered: '<img src="https://blog.example.com/a.jpg" alt="A">' },
    })]];
    const summary = await importer.runImport();
    expect(summary.imported).toBe(1);
    expect(summary.errors.length).toBe(1);
    // the original URL is left intact since mirroring failed
    expect(posts.getByWpPostId(21)!.markdown_body).toContain("https://blog.example.com/a.jpg");
  });
});

describe("extractImageSrcs", () => {
  it("pulls absolute image URLs from rendered HTML", () => {
    const html = `<img src="https://a.com/1.jpg"><figure><img src='https://a.com/2.png' /></figure><img src="/relative.gif">`;
    expect(extractImageSrcs(html)).toEqual(["https://a.com/1.jpg", "https://a.com/2.png"]);
  });
});
