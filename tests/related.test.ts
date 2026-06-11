import { describe, expect, it, beforeEach } from "vitest";
import { PostsService } from "../src/modules/posts/service.js";
import { TagsService } from "../src/modules/tags/service.js";
import { RelatedPostsService } from "../src/modules/related-posts/service.js";
import { testDb } from "./helpers.js";
import type { DB } from "../src/db/index.js";

let db: DB;
let posts: PostsService;
let tags: TagsService;
let related: RelatedPostsService;

beforeEach(() => {
  db = testDb();
  posts = new PostsService(db);
  tags = new TagsService(db);
  related = new RelatedPostsService(db);
});

function makePost(title: string, tagNames: string[], status = "published" as const) {
  const post = posts.create({ title, type: "blog", status, markdownBody: `Content about ${title}` });
  tags.setPostTags(post.id, tagNames);
  posts.syncSearchIndex(posts.getById(post.id)!);
  return post;
}

describe("RelatedPostsService", () => {
  it("ranks tag-overlapping posts and never includes the post itself", () => {
    const a = makePost("AI agents in production", ["AI", "Agents"]);
    const b = makePost("AI coding assistants", ["AI"]);
    const c = makePost("Travel notes from Lisbon", ["Travel"]);
    related.recalculateForPost(a.id);
    const result = related.forPost(a.id);
    const ids = result.map((p) => p.id);
    expect(ids).not.toContain(a.id);
    expect(ids[0]).toBe(b.id);
  });

  it("never surfaces drafts or hidden posts", () => {
    const a = makePost("Main post about AI", ["AI"]);
    makePost("Hidden AI post", ["AI"], "hidden" as any);
    makePost("Draft AI post", ["AI"], "draft" as any);
    related.recalculateForPost(a.id);
    expect(related.forPost(a.id)).toHaveLength(0);
  });

  it("respects blocked overrides across recalculation", () => {
    const a = makePost("AI post one", ["AI"]);
    const b = makePost("AI post two", ["AI"]);
    related.block(a.id, b.id);
    related.recalculateForPost(a.id);
    expect(related.forPost(a.id).map((p) => p.id)).not.toContain(b.id);
  });

  it("pins posts to the top", () => {
    const a = makePost("AI post", ["AI"]);
    const b = makePost("Closely related AI post", ["AI"]);
    const c = makePost("Unrelated travel post", ["Travel"]);
    related.pin(a.id, c.id);
    related.recalculateForPost(a.id);
    expect(related.forPost(a.id)[0]!.id).toBe(c.id);
  });

  it("caps suggestions at five", () => {
    const main = makePost("Main AI post", ["AI"]);
    for (let i = 0; i < 8; i++) makePost(`AI post number ${i} something`, ["AI"]);
    related.recalculateForPost(main.id);
    expect(related.forPost(main.id).length).toBeLessThanOrEqual(5);
  });
});
