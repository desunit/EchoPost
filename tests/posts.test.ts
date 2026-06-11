import { describe, expect, it, beforeEach } from "vitest";
import { PostsService } from "../src/modules/posts/service.js";
import { TagsService } from "../src/modules/tags/service.js";
import { testDb } from "./helpers.js";
import type { DB } from "../src/db/index.js";

let db: DB;
let posts: PostsService;
let tags: TagsService;

beforeEach(() => {
  db = testDb();
  posts = new PostsService(db);
  tags = new TagsService(db);
});

describe("PostsService", () => {
  it("creates a post with generated slug, html, and word count", () => {
    const post = posts.create({
      title: "Hello World!",
      type: "blog",
      status: "published",
      markdownBody: "# Heading\n\nSome **content** here.",
    });
    expect(post.slug).toBe("hello-world");
    expect(post.html_body).toContain("<strong>content</strong>");
    expect(post.word_count).toBe(4);
    expect(post.published_at).toBeTruthy();
  });

  it("deduplicates slugs", () => {
    posts.create({ title: "Same", type: "blog" });
    const second = posts.create({ title: "Same", type: "blog" });
    expect(second.slug).toBe("same-2");
  });

  it("creates a 301 redirect when a published slug changes", () => {
    const post = posts.create({ title: "Original", type: "blog", status: "published" });
    posts.update(post.id, { slug: "renamed" });
    const redirect = db.prepare("SELECT * FROM redirects WHERE from_path = '/original'").get() as any;
    expect(redirect.to_path).toBe("/renamed");
    expect(redirect.status_code).toBe(301);
  });

  it("excludes hidden and draft posts from the archive", () => {
    posts.create({ title: "Visible", type: "blog", status: "published" });
    posts.create({ title: "Hidden", type: "blog", status: "hidden" });
    posts.create({ title: "Draft", type: "blog", status: "draft" });
    const archive = posts.listArchive();
    expect(archive.map((p) => p.title)).toEqual(["Visible"]);
  });

  it("filters by content type", () => {
    posts.create({ title: "A blog", type: "blog", status: "published" });
    posts.create({ title: "An x post", type: "x_post", status: "published" });
    expect(posts.listArchive({ filter: "x_post" }).map((p) => p.title)).toEqual(["An x post"]);
  });

  it("sorts by x views using the latest snapshot", () => {
    const low = posts.create({ title: "Low", type: "x_post", status: "published", publishedAt: "2024-01-01T00:00:00Z" });
    const high = posts.create({ title: "High", type: "x_post", status: "published", publishedAt: "2024-01-02T00:00:00Z" });
    const insert = db.prepare(
      "INSERT INTO x_metric_snapshots (post_id, impression_count, collected_at) VALUES (?, ?, ?)",
    );
    insert.run(low.id, 100, "2024-06-01T00:00:00Z");
    insert.run(high.id, 5000, "2024-06-01T00:00:00Z");
    const archive = posts.listArchive({ sort: "x_views" });
    expect(archive.map((p) => p.title)).toEqual(["High", "Low"]);
  });

  it("computes previous/next chronological posts", () => {
    const a = posts.create({ title: "A", type: "blog", status: "published", publishedAt: "2024-01-01T00:00:00Z" });
    const b = posts.create({ title: "B", type: "blog", status: "published", publishedAt: "2024-02-01T00:00:00Z" });
    const c = posts.create({ title: "C", type: "blog", status: "published", publishedAt: "2024-03-01T00:00:00Z" });
    const { prev, next } = posts.adjacent(posts.getById(b.id)!);
    expect(prev?.id).toBe(a.id);
    expect(next?.id).toBe(c.id);
  });

  it("is idempotent on x_post_id", () => {
    posts.create({ title: "One", type: "x_post", xPostId: "123" });
    expect(posts.getByXPostId("123")).toBeTruthy();
    expect(() => posts.create({ title: "Dup", type: "x_post", xPostId: "123" })).toThrow();
  });
});

describe("TagsService", () => {
  it("resolves aliases to canonical tags", () => {
    const ai = tags.ensure("AI");
    tags.addAlias(ai.id, "artificial-intelligence");
    const resolved = tags.ensure("Artificial Intelligence");
    expect(resolved.id).toBe(ai.id);
  });

  it("merges tags and keeps the old slug as an alias", () => {
    const a = tags.ensure("ML");
    const b = tags.ensure("Machine Learning");
    const post = posts.create({ title: "P", type: "blog", status: "published" });
    tags.attach(post.id, a.id);
    tags.merge(a.id, b.id);
    expect(tags.getById(a.id)).toBeUndefined();
    expect(tags.forPost(post.id).map((t) => t.id)).toEqual([b.id]);
    expect(tags.ensure("ML").id).toBe(b.id); // alias resolves
  });

  it("counts only published posts", () => {
    const tag = tags.ensure("Test");
    const pub = posts.create({ title: "Pub", type: "blog", status: "published" });
    const draft = posts.create({ title: "Draft", type: "blog", status: "draft" });
    tags.attach(pub.id, tag.id);
    tags.attach(draft.id, tag.id);
    const counts = tags.listWithCounts();
    expect(counts[0]!.post_count).toBe(1);
  });
});
