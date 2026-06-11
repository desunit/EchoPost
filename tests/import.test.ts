import { describe, expect, it, beforeEach } from "vitest";
import pino from "pino";
import { XImportService } from "../src/modules/x/import-service.js";
import { XAccountService } from "../src/modules/x/account.js";
import { PostsService } from "../src/modules/posts/service.js";
import type { XTweet, XMedia, TimelineResponse } from "../src/modules/x/client.js";
import { testDb } from "./helpers.js";
import type { DB } from "../src/db/index.js";

const USER_ID = "u1";
const log = pino({ level: "silent" });

function tweet(partial: Partial<XTweet> & { id: string }): XTweet {
  return {
    text: "A standalone post with more than enough characters to clear the default minimum import character threshold used by the import rules in these tests.",
    created_at: "2026-06-01T10:00:00Z",
    conversation_id: partial.id,
    author_id: USER_ID,
    lang: "en",
    public_metrics: { impression_count: 1000, like_count: 10, retweet_count: 2, reply_count: 1, quote_count: 0 },
    ...partial,
  };
}

class FakeClient {
  timeline: XTweet[] = [];
  archive: XTweet[] = []; // full history, newest-first, for backfill tests
  full = new Map<string, XTweet>(); // tweets-lookup responses (with note_tweet)
  media = new Map<string, XMedia>();

  async getUserTimeline(): Promise<TimelineResponse> {
    return {
      tweets: this.timeline,
      media: this.media,
      newestId: this.timeline[0]?.id,
      raw: {},
    };
  }

  // Mimics the real client: returns tweets older than untilId, newest-first,
  // clamped to the X API page minimum of 5.
  async getUserTimelineOlder(_userId: string, untilId?: string, maxResults = 100): Promise<TimelineResponse> {
    const older = this.archive
      .filter((t) => !untilId || Number(t.id) < Number(untilId))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, Math.min(100, Math.max(5, maxResults)));
    return {
      tweets: older,
      media: this.media,
      newestId: older[0]?.id,
      oldestId: older[older.length - 1]?.id,
      raw: {},
    };
  }

  async getTweets(ids: string[]): Promise<TimelineResponse> {
    return { tweets: ids.map((id) => this.full.get(id)).filter(Boolean) as XTweet[], media: new Map(), raw: {} };
  }
}

let db: DB;
let client: FakeClient;
let importer: XImportService;
let posts: PostsService;

beforeEach(() => {
  db = testDb();
  client = new FakeClient();
  importer = new XImportService(db, client as any, log);
  posts = new PostsService(db);
  new XAccountService(db).setProfile({ xUserId: USER_ID, username: "tester", displayName: "Tester" });
});

describe("X import pipeline", () => {
  it("imports a standalone post into the review queue with metrics and metadata", async () => {
    client.timeline = [tweet({ id: "100" })];
    const summary = await importer.runImport();
    expect(summary.imported).toBe(1);

    const post = posts.getByXPostId("100")!;
    expect(post.status).toBe("review");
    expect(post.type).toBe("x_post");
    expect(post.title.length).toBeGreaterThan(5);
    expect(post.source_url).toBe("https://x.com/tester/status/100");
    // publication date comes from the original tweet, even in the review queue
    expect(post.published_at).toBe("2026-06-01T10:00:00Z");

    const snapshot = db.prepare("SELECT * FROM x_metric_snapshots WHERE post_id = ?").get(post.id) as any;
    expect(snapshot.impression_count).toBe(1000);
  });

  it("keeps the original tweet date when an imported post is later published", async () => {
    client.timeline = [tweet({ id: "110", created_at: "2025-12-25T08:30:00Z" })];
    await importer.runImport();
    const post = posts.getByXPostId("110")!;
    expect(post.status).toBe("review");
    // approving the post must not overwrite the date with "now"
    const published = posts.setStatus(post.id, "published");
    expect(published.published_at).toBe("2025-12-25T08:30:00Z");
  });

  it("uses full note_tweet text for long (>280 char) tweets, not the truncated text", async () => {
    // X truncates the `text` field for note tweets and appends a t.co self-link;
    // the full content lives in note_tweet.text.
    client.timeline = [
      tweet({
        id: "150",
        text: "It can significantly reduce the time spent managing Reddit Ads campaigns.\n\nOpen source. Feel https://t.co/abc123",
        note_tweet: {
          text: "It can significantly reduce the time spent managing Reddit Ads campaigns.\n\nOpen source. Feel free to use it 👇",
        },
      }),
    ];
    await importer.runImport();
    const post = posts.getByXPostId("150")!;
    expect(post.markdown_body).toContain("Open source. Feel free to use it 👇");
    expect(post.markdown_body).not.toContain("t.co/abc123");
  });

  it("recovers full text when the timeline truncates a note tweet (no note_tweet field)", async () => {
    // The timeline sometimes drops note_tweet, leaving `text` cut at ~280 chars
    // ending in a self media link; the tweets-lookup endpoint returns the full body.
    const truncated = "A".repeat(255) + " https://t.co/selfphoto"; // >=250, no note_tweet
    client.timeline = [tweet({ id: "800", text: truncated, note_tweet: undefined })];
    client.full.set(
      "800",
      tweet({ id: "800", text: truncated, note_tweet: { text: "A".repeat(255) + " and here is the rest of the full note tweet body." } }),
    );
    await importer.runImport();
    const post = posts.getByXPostId("800")!;
    expect(post.markdown_body).toContain("and here is the rest of the full note tweet body.");
    expect(post.markdown_body).not.toContain("t.co/selfphoto");
  });

  it("ignores replies and reposts by default", async () => {
    client.timeline = [
      tweet({ id: "101", referenced_tweets: [{ type: "replied_to", id: "999" }], conversation_id: "999" }),
      tweet({ id: "102", referenced_tweets: [{ type: "retweeted", id: "998" }] }),
    ];
    const summary = await importer.runImport();
    expect(summary.imported).toBe(0);
    expect(summary.skipped).toBe(2);
  });

  it("skips posts below the minimum character count", async () => {
    client.timeline = [tweet({ id: "103", text: "too short" })];
    const summary = await importer.runImport();
    expect(summary.imported).toBe(0);
  });

  it("imports sensitive posts as drafts only", async () => {
    client.timeline = [tweet({ id: "104", possibly_sensitive: true })];
    await importer.runImport();
    expect(posts.getByXPostId("104")!.status).toBe("draft");
  });

  it("is idempotent across repeated runs", async () => {
    client.timeline = [tweet({ id: "105" })];
    await importer.runImport();
    const second = await importer.runImport();
    expect(second.imported).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM posts").get() as any).c).toBe(1);
  });

  it("combines thread continuations into the root article", async () => {
    client.timeline = [tweet({ id: "200", text: "Thread root post with plenty of characters to satisfy the import rules and the minimum character count threshold." })];
    await importer.runImport();

    client.timeline = [
      tweet({
        id: "201",
        conversation_id: "200",
        referenced_tweets: [{ type: "replied_to", id: "200" }],
        in_reply_to_user_id: USER_ID, // self-reply → genuine continuation
        text: "Second part of the thread, also long enough to exist as a meaningful continuation section.",
      }),
    ];
    const summary = await importer.runImport();
    expect(summary.threadSections).toBe(1);

    const root = posts.getByXPostId("200")!;
    expect(root.markdown_body).toContain("Second part of the thread");
    expect(root.markdown_body).toContain("<!-- x:201 -->"); // section marker, no visible --- separator
    expect(root.markdown_body).not.toContain("\n\n---\n\n");
    expect(posts.getByXPostId("201")).toBeUndefined(); // no separate post
  });

  it("skips self-requotes — a continuation that quote-tweets the thread's own root", async () => {
    client.timeline = [tweet({ id: "220", text: "Thread root post with plenty of characters to satisfy the import rules and the minimum character count threshold." })];
    await importer.runImport();

    client.timeline = [
      tweet({
        id: "221",
        conversation_id: "220",
        in_reply_to_user_id: USER_ID,
        referenced_tweets: [{ type: "quoted", id: "220" }, { type: "replied_to", id: "220" }],
        text: "don’t follow me @desunit unless you want more of this",
      }),
    ];
    const summary = await importer.runImport();
    expect(summary.threadSections).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(posts.getByXPostId("220")!.markdown_body).not.toContain("don’t follow me");
  });

  it("does not fold the author's replies to other people's comments into the article", async () => {
    client.timeline = [tweet({ id: "210", text: "Thread root post with plenty of characters to satisfy the import rules and the minimum character count threshold." })];
    await importer.runImport();

    client.timeline = [
      tweet({
        id: "211",
        conversation_id: "210",
        referenced_tweets: [{ type: "replied_to", id: "999" }],
        in_reply_to_user_id: "someone-else", // author replying to a commenter, not self
        text: "@someone yes exactly, thanks for the kind words about the project, really appreciate it!",
      }),
    ];
    const summary = await importer.runImport();
    expect(summary.threadSections).toBe(0);
    expect(summary.skipped).toBe(1);
    const root = posts.getByXPostId("210")!;
    expect(root.markdown_body).not.toContain("thanks for the kind words");
  });

  it("does not overwrite manually edited bodies on thread updates", async () => {
    client.timeline = [tweet({ id: "300" })];
    await importer.runImport();
    const root = posts.getByXPostId("300")!;
    posts.update(root.id, { markdownBody: "Manually edited", preserveManualBody: true });

    client.timeline = [
      tweet({
        id: "301",
        conversation_id: "300",
        referenced_tweets: [{ type: "replied_to", id: "300" }],
        in_reply_to_user_id: USER_ID,
      }),
    ];
    await importer.runImport();
    expect(posts.getById(root.id)!.markdown_body).toBe("Manually edited");
  });

  it("holds quotes to a higher commentary bar than standalone posts", async () => {
    // Default quote bar is 280 chars: a one-liner and a 100-char take are both
    // skipped, only a quote with substantial standalone commentary is imported.
    const shortTake = "This take matters because owning your distribution is the only durable advantage left for builders today."; // ~105 chars, clears the 100 general minimum but not the quote bar
    const substantial = "A".repeat(300);
    client.timeline = [
      tweet({ id: "400", referenced_tweets: [{ type: "quoted", id: "1" }], text: "agreed! https://t.co/x" }),
      tweet({ id: "401", referenced_tweets: [{ type: "quoted", id: "2" }], text: shortTake }),
      tweet({ id: "402", referenced_tweets: [{ type: "quoted", id: "3" }], text: substantial }),
    ];
    const summary = await importer.runImport();
    expect(summary.imported).toBe(1);
    expect(posts.getByXPostId("402")).toBeTruthy();
    expect(posts.getByXPostId("401")).toBeUndefined();
    expect(posts.getByXPostId("400")).toBeUndefined();
  });

  it("uses minimumQuoteCommentaryCount from rules when set", async () => {
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('import_rules', ?, '')").run(
      JSON.stringify({ blockedKeywords: [], minimumCharacterCount: 10, minimumQuoteCommentaryCount: 50, importReplies: false, importReposts: false, importQuotes: true, combineThreads: true, autoPublishStandalonePosts: false, autoPublishAfterMinutes: 0, allowedLanguages: [] }),
    );
    client.timeline = [tweet({ id: "410", referenced_tweets: [{ type: "quoted", id: "9" }], text: "A".repeat(60) })];
    const summary = await importer.runImport();
    expect(summary.imported).toBe(1);
  });

  it("respects blocked keywords", async () => {
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('import_rules', ?, '')").run(
      JSON.stringify({ blockedKeywords: ["crypto"], minimumCharacterCount: 10, importReplies: false, importReposts: false, importQuotes: true, combineThreads: true, autoPublishStandalonePosts: false, autoPublishAfterMinutes: 0, allowedLanguages: [] }),
    );
    client.timeline = [tweet({ id: "500", text: "A long enough post that mentions Crypto and should be filtered by the blocklist." })];
    const summary = await importer.runImport();
    expect(summary.imported).toBe(0);
  });

  it("generates a usable slug derived from the title for imported posts", async () => {
    client.timeline = [tweet({ id: "700", text: "Shipping the new analytics dashboard today. Here is what changed and why it matters for every creator on the platform right now." })];
    await importer.runImport();
    const post = posts.getByXPostId("700")!;
    expect(post.slug).toBe("shipping-the-new-analytics-dashboard-today");
  });

  it("falls back to the tweet id for posts with no slug-able text", async () => {
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('import_rules', ?, '')").run(
      JSON.stringify({ blockedKeywords: [], minimumCharacterCount: 0, importReplies: false, importReposts: false, importQuotes: true, combineThreads: true, autoPublishStandalonePosts: false, autoPublishAfterMinutes: 0, allowedLanguages: [] }),
    );
    client.timeline = [tweet({ id: "701", text: "🚀🔥", note_tweet: undefined })];
    await importer.runImport();
    expect(posts.getByXPostId("701")!.slug).toBe("x-701");
  });

  describe("batch backfill of older posts", () => {
    const archive = (ids: string[]) =>
      ids.map((id) => tweet({ id, created_at: `2024-01-${id.slice(-2).padStart(2, "0")}T00:00:00Z` }));

    it("imports one batch of older posts and remembers how far back it reached", async () => {
      client.archive = archive(["20", "19", "18", "17", "16", "15"]);
      const summary = await importer.runBackfill(2);
      expect(summary.imported).toBe(2);
      // newest-of-archive first → 20 and 19 imported this batch
      expect(posts.getByXPostId("20")).toBeTruthy();
      expect(posts.getByXPostId("19")).toBeTruthy();
      expect(posts.getByXPostId("18")).toBeUndefined();

      const account = new XAccountService(db).get();
      expect(account.backfill_oldest_x_post_id).toBe("19");
      expect(account.backfill_complete).toBe(0);
    });

    it("auto-publishes backfilled posts, bypassing the review queue", async () => {
      client.archive = archive(["20", "19", "18"]);
      await importer.runBackfill(2);
      expect(posts.getByXPostId("20")!.status).toBe("published");
      expect(posts.getByXPostId("19")!.status).toBe("published");
    });

    it("still drafts sensitive posts even during backfill", async () => {
      client.archive = [tweet({ id: "20", possibly_sensitive: true })];
      await importer.runBackfill(2);
      expect(posts.getByXPostId("20")!.status).toBe("draft");
    });

    it("walks further back on each run without re-importing existing posts", async () => {
      client.archive = archive(["20", "19", "18", "17", "16", "15"]);
      await importer.runBackfill(2); // 20, 19
      const second = await importer.runBackfill(2); // 18, 17
      expect(second.imported).toBe(2);
      expect(posts.getByXPostId("18")).toBeTruthy();
      expect(posts.getByXPostId("17")).toBeTruthy();
      expect(new XAccountService(db).get().backfill_oldest_x_post_id).toBe("17");
      // all four distinct posts, nothing duplicated
      expect((db.prepare("SELECT COUNT(*) AS c FROM posts").get() as any).c).toBe(4);
    });

    it("marks the backfill complete once nothing older remains", async () => {
      client.archive = archive(["12", "11"]);
      await importer.runBackfill(5); // imports both
      const done = await importer.runBackfill(5); // nothing older
      expect(done.imported).toBe(0);
      expect(new XAccountService(db).get().backfill_complete).toBe(1);
    });

    it("starts from the oldest already-imported post when no cursor exists", async () => {
      // a forward import leaves post 18 as the oldest known
      client.timeline = [tweet({ id: "18" })];
      await importer.runImport();
      client.archive = archive(["18", "17", "16", "15", "14"]);
      const summary = await importer.runBackfill(2); // older than 18 → 17, 16
      expect(summary.imported).toBe(2);
      expect(posts.getByXPostId("17")).toBeTruthy();
      expect(posts.getByXPostId("16")).toBeTruthy();
    });
  });

  describe("LLM metadata", () => {
    const tagNamesFor = (postId: string) =>
      (db.prepare("SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?").all(postId) as any[]).map((r) => r.name);

    it("uses LLM title, SEO description and tags when a provider is configured", async () => {
      const provider = {
        generate: async () => ({ title: "A Crisp LLM Headline", seoDescription: "An LLM-written meta description.", tags: ["mcp", "appfigures"] }),
      };
      const llmImporter = new XImportService(db, client as any, log, provider);
      client.timeline = [tweet({ id: "900" })];
      await llmImporter.runImport();
      const post = posts.getByXPostId("900")!;
      expect(post.title).toBe("A Crisp LLM Headline");
      expect(post.seo_description).toBe("An LLM-written meta description.");
      expect(post.slug).toBe("a-crisp-llm-headline");
      expect(tagNamesFor(post.id).sort()).toEqual(["appfigures", "mcp"]);
    });

    it("falls back to heuristic metadata when the LLM provider fails", async () => {
      const provider = { generate: async () => { throw new Error("LLM down"); } };
      const llmImporter = new XImportService(db, client as any, log, provider);
      client.timeline = [tweet({ id: "901", text: "Heuristic fallback works fine. This sentence is long enough to clear the import minimum character threshold easily." })];
      await llmImporter.runImport();
      const post = posts.getByXPostId("901")!;
      expect(post.title).toBe("Heuristic fallback works fine");
    });
  });

  it("auto-publishes when rules allow and thresholds are met", async () => {
    db.prepare("INSERT INTO settings (key, value_json, updated_at) VALUES ('import_rules', ?, '')").run(
      JSON.stringify({ blockedKeywords: [], minimumCharacterCount: 10, importReplies: false, importReposts: false, importQuotes: true, combineThreads: true, autoPublishStandalonePosts: true, minimumXViewsForAutoPublish: 500, autoPublishAfterMinutes: 0, allowedLanguages: [] }),
    );
    client.timeline = [tweet({ id: "600" })];
    await importer.runImport();
    expect(posts.getByXPostId("600")!.status).toBe("published");
  });
});
