import type { DB } from "../../db/index.js";
import type { Logger } from "pino";
import { XClient, XRateLimitError, type XTweet, type XMedia } from "./client.js";
import { XAccountService } from "./account.js";
import { PostsService } from "../posts/service.js";
import { TagsService } from "../tags/service.js";
import { MediaService } from "../media/service.js";
import { SettingsService } from "../settings/service.js";
import { generateTitle, generateExcerpt, generateSeoDescription, generateTags } from "../metadata/generate.js";
import type { LlmMetadataProvider } from "../metadata/llm.js";
import { nowIso } from "../../lib/time.js";
import { slugify } from "../../lib/slugify.js";
import { invalidateContentCaches } from "../../lib/cache.js";
import type { ImportRules, PostRow } from "../types.js";

export interface ImportSummary {
  fetched: number;
  imported: number;
  threadSections: number;
  skipped: number;
  errors: string[];
}

/** Full tweet text: note_tweet.text for long (>280) tweets, else the standard text. */
export function tweetText(tweet: XTweet): string {
  return (tweet.note_tweet?.text ?? tweet.text ?? "").trim();
}

/**
 * X import pipeline (PRD 5.2.3–5.2.5): fetch new posts since the last known
 * ID, apply import rules, combine threads, mirror media, generate metadata,
 * and queue for review or auto-publish. Idempotent: x_post_id is unique.
 */
export class XImportService {
  private accounts: XAccountService;
  private posts: PostsService;
  private tags: TagsService;
  private media: MediaService;
  private settings: SettingsService;

  constructor(
    private db: DB,
    private client: XClient,
    private log: Logger,
    // Optional LLM metadata (title/SEO description/tags). Injected by the worker
    // from config; left null in tests so imports stay deterministic and offline.
    private metadata: LlmMetadataProvider | null = null,
  ) {
    this.accounts = new XAccountService(db);
    this.posts = new PostsService(db);
    this.tags = new TagsService(db);
    this.media = new MediaService(db);
    this.settings = new SettingsService(db);
  }

  async runImport(): Promise<ImportSummary> {
    const summary: ImportSummary = { fetched: 0, imported: 0, threadSections: 0, skipped: 0, errors: [] };
    const account = this.accounts.get();
    if (!account.x_user_id) {
      throw new Error("No X account connected — connect one in the admin panel first");
    }

    const rules = this.settings.getImportRules();
    const timeline = await this.client.getUserTimeline(
      account.x_user_id,
      account.last_imported_x_post_id ?? undefined,
    );
    summary.fetched = timeline.tweets.length;

    await this.processTimeline(timeline.tweets, timeline.media, rules, account.x_user_id, summary);

    this.accounts.recordSyncSuccess(timeline.newestId ?? account.last_imported_x_post_id ?? undefined);
    invalidateContentCaches();
    return summary;
  }

  /**
   * Batch backfill of older posts (PRD deviation): fetch one page of tweets
   * older than the backfill watermark, import the ones that don't exist yet,
   * then advance the watermark so the next batch reaches still further back.
   * `batchSize` posts per run (default 100, the X API page maximum).
   */
  async runBackfill(batchSize = 100): Promise<ImportSummary> {
    const summary: ImportSummary = { fetched: 0, imported: 0, threadSections: 0, skipped: 0, errors: [] };
    const account = this.accounts.get();
    if (!account.x_user_id) {
      throw new Error("No X account connected — connect one in the admin panel first");
    }
    if (account.backfill_complete) {
      this.log.info("x backfill: archive already fully imported, nothing older to fetch");
      return summary;
    }

    const untilId = account.backfill_oldest_x_post_id ?? this.oldestKnownPostId() ?? undefined;
    const rules = this.settings.getImportRules();
    // The X API enforces a 5-post page minimum, so for small batch sizes we
    // fetch a page and keep only the `batchSize` newest (closest to the cursor);
    // the remainder is re-fetched next run, so nothing is skipped.
    const timeline = await this.client.getUserTimelineOlder(account.x_user_id, untilId, batchSize);
    const batch = [...timeline.tweets].sort((a, b) => this.compareIds(b.id, a.id)).slice(0, batchSize);
    summary.fetched = batch.length;

    await this.processTimeline(batch, timeline.media, rules, account.x_user_id, summary, { forcePublish: true });

    // Advance the watermark to the oldest tweet in this batch. An empty page
    // means we've reached the start of the timeline — mark the backfill done.
    const oldestId = this.minTweetId(batch);
    const oldestAt = oldestId ? (batch.find((t) => t.id === oldestId)?.created_at ?? null) : null;
    this.accounts.recordBackfillProgress(oldestId, oldestAt, timeline.tweets.length === 0);

    invalidateContentCaches();
    return summary;
  }

  /** Process a fetched timeline page oldest-first so thread roots precede continuations. */
  private async processTimeline(
    tweets: XTweet[],
    mediaMap: Map<string, XMedia>,
    rules: ImportRules,
    ownUserId: string,
    summary: ImportSummary,
    opts: { forcePublish?: boolean } = {},
  ): Promise<void> {
    await this.enrichTruncatedTweets(tweets, mediaMap);
    const ordered = [...tweets].sort((a, b) => this.compareIds(a.id, b.id));
    for (const tweet of ordered) {
      try {
        const result = await this.processTweet(tweet, mediaMap, rules, ownUserId, opts);
        if (result === "imported") summary.imported++;
        else if (result === "thread_section") summary.threadSections++;
        else summary.skipped++;
      } catch (err: any) {
        summary.errors.push(`${tweet.id}: ${err.message}`);
        this.log.error({ err, tweetId: tweet.id }, "x import: tweet failed");
      }
    }
  }

  /**
   * The user-timeline endpoint inconsistently omits `note_tweet` for some long
   * (>280 char) tweets, leaving `text` truncated mid-sentence. The tweets-lookup
   * endpoint returns it reliably, so re-fetch the truncated-looking ones and
   * splice the full text + entities (and any extra media) back in before import.
   */
  private async enrichTruncatedTweets(tweets: XTweet[], mediaMap: Map<string, XMedia>): Promise<void> {
    // A note tweet truncated in `text` sits right at the ~280-char cap with no
    // note_tweet present; short tweets are never truncated, so 250 is a safe gate.
    const truncated = tweets.filter((t) => !t.note_tweet && (t.text ?? "").length >= 250);
    if (truncated.length === 0) return;
    try {
      const full = await this.client.getTweets(truncated.map((t) => t.id));
      const byId = new Map(full.tweets.map((t) => [t.id, t]));
      for (const t of truncated) {
        const f = byId.get(t.id);
        if (!f?.note_tweet) continue;
        t.note_tweet = f.note_tweet;
        if (f.entities) t.entities = f.entities;
      }
      for (const [key, m] of full.media) if (!mediaMap.has(key)) mediaMap.set(key, m);
    } catch (err) {
      if (err instanceof XRateLimitError) throw err; // let the job reschedule
      this.log.warn({ err }, "x import: note_tweet enrichment failed; using truncated text");
    }
  }

  /** Numeric compare for snowflake ids (lengths differ across years, so string order is wrong). */
  private compareIds(a: string, b: string): number {
    return a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length;
  }

  private minTweetId(tweets: XTweet[]): string | null {
    if (tweets.length === 0) return null;
    return tweets.reduce((min, t) => (this.compareIds(t.id, min) < 0 ? t.id : min), tweets[0]!.id);
  }

  /** Oldest x_post_id already stored — the starting point when no backfill cursor exists yet. */
  private oldestKnownPostId(): string | null {
    const row = this.db
      .prepare(
        "SELECT x_post_id FROM posts WHERE x_post_id IS NOT NULL ORDER BY CAST(x_post_id AS INTEGER) ASC LIMIT 1",
      )
      .get() as { x_post_id: string } | undefined;
    return row?.x_post_id ?? null;
  }

  private async processTweet(
    tweet: XTweet,
    mediaMap: Map<string, XMedia>,
    rules: ImportRules,
    ownUserId: string,
    opts: { forcePublish?: boolean } = {},
  ): Promise<"imported" | "thread_section" | "skipped"> {
    if (this.posts.getByXPostId(tweet.id)) return "skipped"; // idempotent

    const refs = tweet.referenced_tweets ?? [];
    const isRepost = refs.some((r) => r.type === "retweeted");
    const isQuote = refs.some((r) => r.type === "quoted");
    const isReply = refs.some((r) => r.type === "replied_to");

    if (isRepost && !rules.importReposts) return "skipped";

    // Thread continuation: a self-reply to the author's OWN previous tweet in a
    // conversation we track. Replies to other people's comments in the same
    // conversation (in_reply_to_user_id !== own) are not part of the article.
    if (isReply && rules.combineThreads && tweet.conversation_id) {
      const root = this.posts.getThreadRootByConversation(tweet.conversation_id);
      if (
        root &&
        root.x_author_id === ownUserId &&
        tweet.author_id === ownUserId &&
        tweet.in_reply_to_user_id === ownUserId
      ) {
        // Skip "self-requotes": a continuation that quote-tweets the thread's
        // own root (quoted id === conversation_id) is a self-promo, not content.
        if (refs.some((r) => r.type === "quoted" && r.id === tweet.conversation_id)) return "skipped";
        await this.appendThreadSection(root, tweet, mediaMap);
        return "thread_section";
      }
    }
    if (isReply && !rules.importReplies) return "skipped";

    const text = tweetText(tweet);
    if (isQuote) {
      if (!rules.importQuotes) return "skipped";
      // A quote needs more standalone commentary than a normal post because the
      // quoted tweet itself isn't embedded (PRD 5.2.4). Held to a dedicated,
      // higher bar that falls back to the general minimum when unconfigured.
      const quoteMinimum = rules.minimumQuoteCommentaryCount ?? rules.minimumCharacterCount;
      if (text.replace(/https?:\/\/\S+/g, "").trim().length < quoteMinimum) return "skipped";
    }

    if (text.replace(/https?:\/\/\S+/g, "").trim().length < rules.minimumCharacterCount) return "skipped";
    if (rules.allowedLanguages.length > 0 && tweet.lang && !rules.allowedLanguages.includes(tweet.lang)) {
      return "skipped";
    }
    const lowered = text.toLowerCase();
    if (rules.blockedKeywords.some((k) => k && lowered.includes(k.toLowerCase()))) return "skipped";

    return this.importStandalone(tweet, mediaMap, rules, ownUserId, opts);
  }

  private async importStandalone(
    tweet: XTweet,
    mediaMap: Map<string, XMedia>,
    rules: ImportRules,
    ownUserId: string,
    opts: { forcePublish?: boolean } = {},
  ): Promise<"imported"> {
    const account = this.accounts.get();
    const sourceUrl = `https://x.com/${account.username ?? "i"}/status/${tweet.id}`;
    const markdown = this.tweetToMarkdown(tweet);

    const existingTagNames = (this.db.prepare("SELECT name FROM tags").all() as any[]).map((r) => r.name);
    const site = this.settings.getSiteSettings();
    const fullText = tweetText(tweet);

    // Heuristic metadata is the baseline; an LLM enhances it when configured.
    let title = generateTitle(fullText);
    let seoDescription = generateSeoDescription(fullText);
    let tagNames = generateTags(fullText, { existingTags: existingTagNames, vocabulary: site.controlledTagVocabulary });
    if (this.metadata) {
      try {
        const m = await this.metadata.generate({
          text: fullText,
          existingTags: existingTagNames,
          vocabulary: site.controlledTagVocabulary,
        });
        if (m.title) title = m.title;
        if (m.seoDescription) seoDescription = m.seoDescription;
        if (m.tags.length > 0) tagNames = m.tags;
      } catch (err) {
        this.log.warn({ err, tweetId: tweet.id }, "x import: LLM metadata failed; using heuristic");
      }
    }
    const slug = this.slugForImport(title, fullText, tweet.id);

    const metrics = tweet.public_metrics;
    // Backfilled posts are auto-published (opts.forcePublish), bypassing the
    // review queue and engagement thresholds; sensitive posts still draft below.
    const autoPublish =
      !tweet.possibly_sensitive &&
      (opts.forcePublish ||
        (rules.autoPublishStandalonePosts &&
          (rules.minimumXViewsForAutoPublish == null ||
            (metrics?.impression_count ?? 0) >= rules.minimumXViewsForAutoPublish) &&
          (rules.minimumLikesForAutoPublish == null ||
            (metrics?.like_count ?? 0) >= rules.minimumLikesForAutoPublish)));

    const post = this.posts.create({
      title,
      slug,
      type: "x_post",
      // sensitive posts always land as draft (PRD 5.2.4); others review or auto-publish
      status: tweet.possibly_sensitive ? "draft" : autoPublish ? "published" : "review",
      // Publication date is always the original tweet's date, so the archive
      // is chronological by when the content was actually posted. It is set
      // even for review-queue posts and preserved when later published.
      publishedAt: tweet.created_at ?? nowIso(),
      excerpt: generateExcerpt(fullText),
      markdownBody: markdown,
      language: tweet.lang ?? null,
      sourceUrl,
      seoDescription,
      xPostId: tweet.id,
      xConversationId: tweet.conversation_id ?? null,
      xAuthorId: tweet.author_id ?? ownUserId,
      xRawJson: JSON.stringify(tweet),
      importedAt: nowIso(),
    });

    if (tagNames.length > 0) this.tags.setPostTags(post.id, tagNames, "auto");

    await this.mirrorTweetMedia(post.id, tweet, mediaMap);
    this.recordMetricsSnapshot(post.id, tweet);
    this.posts.syncSearchIndex(this.posts.getById(post.id)!);
    return "imported";
  }

  /**
   * SEO slug for an imported post. Prefer the generated title; when that
   * degenerates to a generic fallback (e.g. an emoji-only tweet → "Untitled
   * post") fall back to the post body, and finally to the tweet id, so the
   * archive never produces a wall of "untitled-post-2, -3, …". Uniqueness is
   * still enforced by PostsService against the DB.
   */
  private slugForImport(title: string, body: string, tweetId: string): string {
    const generic = new Set(["post", "untitled-post"]);
    const fromTitle = slugify(title);
    if (!generic.has(fromTitle)) return fromTitle;
    const fromBody = slugify(body.replace(/https?:\/\/\S+/g, " "));
    if (!generic.has(fromBody)) return fromBody;
    return `x-${tweetId}`;
  }

  /** Append a thread continuation to its root article (PRD 5.2.5). */
  private async appendThreadSection(root: PostRow, tweet: XTweet, mediaMap: Map<string, XMedia>): Promise<void> {
    const sectionMarkdown = this.tweetToMarkdown(tweet);
    const account = this.accounts.get();
    const sectionUrl = `https://x.com/${account.username ?? "i"}/status/${tweet.id}`;

    const startOrder = this.media.forPost(root.id).length;
    const mirrored = await this.mirrorTweetMedia(root.id, tweet, mediaMap, startOrder);
    const mediaMarkdown = mirrored
      .filter((m) => m.mime_type?.startsWith("image/"))
      .map((m) => `\n![${(m.alt_text ?? "").replace(/[\[\]]/g, "")}](${m.public_url})`)
      .join("");

    if (root.preserve_manual_body !== 1) {
      // Sections flow as paragraphs — no visible <hr> separator between them.
      // The <!-- x:ID --> marker remains the canonical per-section boundary.
      const appended =
        `${root.markdown_body ?? ""}\n\n${sectionMarkdown}${mediaMarkdown}\n\n` +
        `<!-- x:${tweet.id} -->\n[View on X](${sectionUrl})`;
      this.posts.update(root.id, { markdownBody: appended });
    }

    // remember the section tweet so re-imports stay idempotent
    this.db
      .prepare(
        `UPDATE posts SET x_raw_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify({ ...this.safeParse(root.x_raw_json), thread: [...this.threadIds(root), tweet.id] }),
        nowIso(), root.id,
      );
  }

  private threadIds(root: PostRow): string[] {
    const parsed = this.safeParse(root.x_raw_json);
    return Array.isArray(parsed?.thread) ? parsed.thread : [];
  }

  private safeParse(json: string | null): any {
    try {
      return json ? JSON.parse(json) : {};
    } catch {
      return {};
    }
  }

  /** Convert tweet text to markdown: expand t.co links, strip trailing media URLs. */
  private tweetToMarkdown(tweet: XTweet): string {
    // For note tweets (>280 chars) use the full text and its own entity offsets;
    // the top-level entities only describe the truncated `text`.
    let text = tweetText(tweet);
    const urls = (tweet.note_tweet?.text ? tweet.note_tweet.entities?.urls : tweet.entities?.urls) ?? [];
    for (const u of urls) {
      if (!u.expanded_url) continue;
      if (u.expanded_url.includes("/photo/") || u.expanded_url.includes("/video/")) {
        text = text.replace(u.url, ""); // media link — the file itself is mirrored
      } else {
        text = text.replace(u.url, `[${u.display_url ?? u.expanded_url}](${u.expanded_url})`);
      }
    }
    return text.trim();
  }

  private async mirrorTweetMedia(
    postId: string,
    tweet: XTweet,
    mediaMap: Map<string, XMedia>,
    startOrder = 0,
  ): Promise<Array<{ public_url: string; mime_type: string | null; alt_text: string | null }>> {
    const mirrored: Array<{ public_url: string; mime_type: string | null; alt_text: string | null }> = [];
    let order = startOrder;
    for (const key of tweet.attachments?.media_keys ?? []) {
      const m = mediaMap.get(key);
      if (!m) continue;
      const url = m.type === "photo" ? m.url : (m.preview_image_url ?? m.url);
      if (!url) continue;
      try {
        const row = await this.media.mirrorRemote({
          postId,
          sourceUrl: url,
          sourceType: m.type === "photo" ? "image" : `${m.type}_thumbnail`,
          altText: m.alt_text ?? null,
          sortOrder: order++,
        });
        mirrored.push(row);
      } catch (err: any) {
        // media failures must not block the import; the daily verify job retries
        this.log.warn({ err, postId, url }, "x import: media mirror failed");
      }
    }
    return mirrored;
  }

  recordMetricsSnapshot(postId: string, tweet: XTweet): void {
    const m = tweet.public_metrics;
    if (!m) return;
    this.db
      .prepare(
        `INSERT INTO x_metric_snapshots (post_id, impression_count, like_count, repost_count,
          reply_count, quote_count, bookmark_count, url_link_clicks, profile_clicks, engagements, collected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        postId,
        m.impression_count ?? 0, m.like_count ?? 0, m.retweet_count ?? 0,
        m.reply_count ?? 0, m.quote_count ?? 0, m.bookmark_count ?? 0,
        tweet.non_public_metrics?.url_link_clicks ?? null,
        tweet.non_public_metrics?.user_profile_clicks ?? null,
        tweet.non_public_metrics?.engagements ?? null,
        nowIso(),
      );
  }
}
