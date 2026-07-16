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
import type { ImportRules, PostRow, MediaRow } from "../types.js";

export interface ImportSummary {
  fetched: number;
  imported: number;
  threadSections: number;
  skipped: number;
  errors: string[];
  /** Site-relative paths that went live (auto-published or thread-extended) — for IndexNow pings. */
  publishedPaths: string[];
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
    const summary: ImportSummary = { fetched: 0, imported: 0, threadSections: 0, skipped: 0, errors: [], publishedPaths: [] };
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
    const summary: ImportSummary = { fetched: 0, imported: 0, threadSections: 0, skipped: 0, errors: [], publishedPaths: [] };
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

  /**
   * Re-fetch an imported post's tweet(s) from X and re-mirror their media.
   * Unlike the `verify_media` job (which only restores files missing on disk),
   * this pulls straight from the API, so media that changed upstream — or was
   * never captured — is picked up. Existing X-sourced media rows are dropped
   * first so re-runs don't duplicate; admin uploads are left untouched. Body
   * text isn't touched (image URLs are content-addressed, so they stay valid).
   */
  async refetchMedia(postId: string): Promise<{ tweets: number; mirrored: number }> {
    const post = this.posts.getById(postId);
    if (!post) throw new Error(`Post not found: ${postId}`);
    if (!post.x_post_id) throw new Error("Post is not an imported X post");

    // Root tweet plus any thread continuations appended to it.
    const ids = [...new Set([post.x_post_id, ...this.threadIds(post)])];
    const { tweets, media } = await this.client.getTweets(ids);
    // Fetch before deleting: if X returns nothing (e.g. all deleted), keep what we have.
    if (tweets.length === 0) throw new Error("X returned no tweets for this post (deleted or inaccessible)");

    // Drop existing X-sourced media (keep admin uploads), then re-mirror fresh.
    for (const m of this.media.forPost(postId)) {
      if (m.source_type !== "upload") this.media.removeUpload(m.id);
    }

    const byId = new Map(tweets.map((t) => [t.id, t]));
    let order = this.media.forPost(postId).length; // continue after any kept uploads
    let mirrored = 0;
    for (const id of ids) {
      const tweet = byId.get(id);
      if (!tweet) continue;
      const rows = await this.mirrorTweetMedia(postId, tweet, media, order);
      order += rows.length;
      mirrored += rows.length;
    }

    // Re-mirror an Article's cover image (lives in article.cover_media, not in
    // attachments) and restore it as the post's og:image / lead cover.
    const root = byId.get(post.x_post_id);
    if (root?.article) {
      const cover = await this.mirrorArticleCover(postId, root, media);
      if (cover) {
        this.posts.update(postId, { ogImageMediaId: cover.id });
        mirrored += 1;
      }
    }

    invalidateContentCaches();
    return { tweets: tweets.length, mirrored };
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
        const result = await this.processTweet(tweet, mediaMap, rules, ownUserId, summary, opts);
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
    summary: ImportSummary,
    opts: { forcePublish?: boolean } = {},
  ): Promise<"imported" | "thread_section" | "skipped"> {
    if (this.posts.getByXPostId(tweet.id)) return "skipped"; // idempotent

    const refs = tweet.referenced_tweets ?? [];
    const isRepost = refs.some((r) => r.type === "retweeted");
    const isQuote = refs.some((r) => r.type === "quoted");
    const isReply = refs.some((r) => r.type === "replied_to");

    if (isRepost && !rules.importReposts) return "skipped";

    // X long-form Articles (Premium+) arrive as ordinary timeline tweets that
    // carry an `article` object. They're original long-form content, so they
    // bypass the thread/reply/quote routing and the minimum-character gate (the
    // substance is the Article body, not the short timeline blurb whose length
    // would otherwise fail the gate). Only language and blocked-keyword rules
    // still apply.
    if (tweet.article) {
      // The language filter is skipped for Articles: the tweet's own `lang` is
      // "zxx" (no linguistic content) because its text is just the article URL,
      // so it can't be matched against allowedLanguages. Blocked keywords still apply.
      const haystack = this.articleFullText(tweet).toLowerCase();
      if (rules.blockedKeywords.some((k) => k && haystack.includes(k.toLowerCase()))) return "skipped";
      return this.importStandalone(tweet, mediaMap, rules, ownUserId, summary, opts);
    }

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
        // extending a live post changes its content — worth an IndexNow ping
        if (root.status === "published") summary.publishedPaths.push(`/${root.slug}`);
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

    return this.importStandalone(tweet, mediaMap, rules, ownUserId, summary, opts);
  }

  private async importStandalone(
    tweet: XTweet,
    mediaMap: Map<string, XMedia>,
    rules: ImportRules,
    ownUserId: string,
    summary: ImportSummary,
    opts: { forcePublish?: boolean } = {},
  ): Promise<"imported"> {
    const account = this.accounts.get();
    const sourceUrl = `https://x.com/${account.username ?? "i"}/status/${tweet.id}`;
    const isArticle = !!tweet.article;
    const markdown = isArticle ? this.articleToMarkdown(tweet) : this.tweetToMarkdown(tweet);

    const existingTagNames = (this.db.prepare("SELECT name FROM tags").all() as any[]).map((r) => r.name);
    const site = this.settings.getSiteSettings();
    const fullText = isArticle ? this.articleFullText(tweet) : tweetText(tweet);

    // For Articles the author-given title is canonical; otherwise derive a title
    // heuristically. Either way an LLM may enhance the SEO description and tags.
    const articleTitle = tweet.article?.title?.trim();
    let title = articleTitle || generateTitle(fullText);
    let seoDescription = generateSeoDescription(fullText);
    let tagNames = generateTags(fullText, { existingTags: existingTagNames, vocabulary: site.controlledTagVocabulary });
    if (this.metadata) {
      try {
        const m = await this.metadata.generate({
          text: fullText,
          existingTags: existingTagNames,
          vocabulary: site.controlledTagVocabulary,
        });
        // Don't let the LLM overwrite an Article's real, author-given title.
        if (m.title && !articleTitle) title = m.title;
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
      // X long-form Articles are native blog articles, not short X posts — they
      // get the "blog" treatment (cover image, BlogPosting schema, archive),
      // while retaining their X provenance (x_post_id, source_url, metrics).
      type: isArticle ? "blog" : "x_post",
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

    if (post.status === "published") summary.publishedPaths.push(`/${post.slug}`);

    if (tagNames.length > 0) this.tags.setPostTags(post.id, tagNames, "auto");

    await this.mirrorTweetMedia(post.id, tweet, mediaMap);
    // An Article's cover image lives in `article.cover_media` (resolved via the
    // article.cover_media expansion), not in attachments — mirror it and use it
    // as the post's lead/og:image so it renders above the body.
    if (isArticle) {
      const cover = await this.mirrorArticleCover(post.id, tweet, mediaMap);
      if (cover) this.posts.update(post.id, { ogImageMediaId: cover.id });
    }
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
    const mediaMarkdown = this.mediaMarkdownFor(mirrored);

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

  /**
   * Full body of an X Article. `plain_text` is the complete article; we fall
   * back to the (truncated) `preview_text`, and finally to the tweet's own text
   * (which for an Article is only the t.co link). Article bodies use single
   * newlines between paragraphs, so they're promoted to blank-line breaks for
   * Markdown. Imported Articles land in the review queue for a final pass.
   */
  private articleBodyText(tweet: XTweet): string {
    const a = tweet.article;
    const raw = (typeof a?.plain_text === "string" && a.plain_text) || (typeof a?.preview_text === "string" && a.preview_text) || "";
    return raw.trim();
  }

  private articleToMarkdown(tweet: XTweet): string {
    const body = this.articleBodyText(tweet);
    if (!body) return this.tweetToMarkdown(tweet);
    // Article paragraphs are separated by single newlines; Markdown needs blank
    // lines between them to render as distinct paragraphs.
    return body.split(/\n+/).map((p) => p.trim()).filter(Boolean).join("\n\n");
  }

  /**
   * Mirror an Article's cover image. The cover's media key (`article.cover_media`)
   * is resolved into the includes media map by the `article.cover_media`
   * expansion; mirror it as sort_order 0 so it leads the post's media. Returns
   * the new row, or null when there's no cover or the mirror fails (non-fatal).
   */
  private async mirrorArticleCover(
    postId: string,
    tweet: XTweet,
    mediaMap: Map<string, XMedia>,
  ): Promise<MediaRow | null> {
    const key = tweet.article?.cover_media;
    if (!key) return null;
    const m = mediaMap.get(key);
    if (!m?.url) return null;
    try {
      return await this.media.mirrorRemote({
        postId,
        sourceUrl: m.url,
        sourceType: "image",
        altText: m.alt_text ?? null,
        sortOrder: 0,
      });
    } catch (err) {
      this.log.warn({ err, postId }, "x import: article cover mirror failed");
      return null;
    }
  }

  /** Article text for metadata heuristics / filtering: title plus body. */
  private articleFullText(tweet: XTweet): string {
    const title = tweet.article?.title?.trim() ?? "";
    const body = this.articleBodyText(tweet) || tweetText(tweet);
    return `${title}\n\n${body}`.trim();
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

  /** Highest-bitrate MP4 rendition of a video / animated_gif, or null. */
  private bestMp4(m: XMedia): string | null {
    const mp4s = (m.variants ?? []).filter((v) => v.content_type === "video/mp4" && v.url);
    if (mp4s.length === 0) return null;
    return mp4s.sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0]!.url;
  }

  private async mirrorTweetMedia(
    postId: string,
    tweet: XTweet,
    mediaMap: Map<string, XMedia>,
    startOrder = 0,
  ): Promise<MediaRow[]> {
    const mirrored: MediaRow[] = [];
    let order = startOrder;
    const mirror = async (sourceUrl: string, sourceType: string, altText: string | null) => {
      try {
        mirrored.push(
          await this.media.mirrorRemote({ postId, sourceUrl, sourceType, altText, sortOrder: order++ }),
        );
      } catch (err: any) {
        // media failures must not block the import; the daily verify job retries
        this.log.warn({ err, postId, sourceUrl }, "x import: media mirror failed");
      }
    };
    for (const key of tweet.attachments?.media_keys ?? []) {
      const m = mediaMap.get(key);
      if (!m) continue;
      if (m.type === "photo") {
        if (m.url) await mirror(m.url, "image", m.alt_text ?? null);
        continue;
      }
      // video / animated_gif: mirror the playable MP4 (rendered in the post) and
      // the poster thumbnail. The thumbnail is used only for og:image — and as a
      // visible fallback if the MP4 is missing (e.g. it exceeded the size cap).
      const mp4 = this.bestMp4(m);
      if (mp4) await mirror(mp4, m.type, m.alt_text ?? null); // source_type "video" | "animated_gif"
      if (m.preview_image_url) await mirror(m.preview_image_url, `${m.type}_thumbnail`, m.alt_text ?? null);
    }
    return mirrored;
  }

  /**
   * Inline Markdown/HTML for a thread section's media. Photos become images;
   * videos become a <video> (poster = paired thumbnail). Poster thumbnails are
   * never shown on their own (they serve og:image) unless their MP4 is missing.
   */
  private mediaMarkdownFor(rows: MediaRow[]): string {
    const isThumb = (m: MediaRow) => /_thumbnail$/.test(m.source_type ?? "");
    const isVideo = (m: MediaRow) => (m.mime_type ?? "").startsWith("video/");
    const cleanAlt = (m: MediaRow) => (m.alt_text ?? "").replace(/[\[\]]/g, "");
    const thumbs = rows.filter(isThumb);
    const videoCount = rows.filter(isVideo).length;
    let ti = 0;
    const out: string[] = [];
    for (const m of rows) {
      if (isThumb(m)) continue;
      if (isVideo(m)) {
        const poster = thumbs[ti++];
        const posterAttr = poster ? ` poster="${poster.public_url}"` : "";
        const playback = m.source_type === "animated_gif" ? " autoplay loop muted playsinline" : " controls";
        out.push(`\n<video src="${m.public_url}"${posterAttr}${playback} preload="metadata"></video>`);
      } else if ((m.mime_type ?? "").startsWith("image/")) {
        out.push(`\n![${cleanAlt(m)}](${m.public_url})`);
      }
    }
    // Thumbnails whose MP4 failed to mirror: show them as fallback images.
    for (let i = videoCount; i < thumbs.length; i++) out.push(`\n![${cleanAlt(thumbs[i]!)}](${thumbs[i]!.public_url})`);
    return out.join("");
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
