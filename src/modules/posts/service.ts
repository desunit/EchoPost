import type { DB } from "../../db/index.js";
import { newId } from "../../lib/ids.js";
import { nowIso, daysAgoIso, daysAgoDate } from "../../lib/time.js";
import { renderMarkdown, markdownToText, countWords, makeExcerpt } from "../../lib/markdown.js";
import { uniqueSlug, slugify } from "../../lib/slugify.js";
import { invalidateContentCaches } from "../../lib/cache.js";
import { config } from "../../config/index.js";
import type {
  ContentType,
  FilterMode,
  PostRow,
  PublicationStatus,
  SortMode,
  XPublicMetrics,
} from "../types.js";

export interface PostInput {
  title: string;
  slug?: string;
  type: ContentType;
  status?: PublicationStatus;
  publishedAt?: string | null;
  excerpt?: string | null;
  markdownBody?: string | null;
  language?: string | null;
  sourceUrl?: string | null;
  canonicalUrl?: string | null;
  externalUrl?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  ogImageMediaId?: string | null;
  pinned?: boolean;
  featured?: boolean;
  xPostId?: string | null;
  xConversationId?: string | null;
  xAuthorId?: string | null;
  xRawJson?: string | null;
  importedAt?: string | null;
  preserveManualTitle?: boolean;
  preserveManualBody?: boolean;
}

export interface ArchiveItem extends PostRow {
  x_views: number;
  blog_views: number;
  tag_names: string | null;
  thumbnail_url: string | null;
}

const SORT_SQL: Record<SortMode, string> = {
  latest: "p.published_at DESC",
  oldest: "p.published_at ASC",
  x_views: "x_views DESC, p.published_at DESC",
  blog_views: "blog_views DESC, p.published_at DESC",
  x_views_30d: "x_views_30d DESC, p.published_at DESC",
  blog_views_30d: "blog_views_30d DESC, p.published_at DESC",
};

export class PostsService {
  constructor(private db: DB) {}

  /* ---------------- write path ---------------- */

  create(input: PostInput): PostRow {
    const id = newId();
    const now = nowIso();
    const markdown = input.markdownBody ?? "";
    const html = markdown ? renderMarkdown(markdown) : "";
    const text = markdown ? markdownToText(markdown) : "";
    const slug = uniqueSlug(input.slug || input.title, (s) => this.slugExists(s));
    const status = input.status ?? "draft";

    this.db
      .prepare(
        `INSERT INTO posts (
          id, type, status, title, slug, excerpt, markdown_body, html_body, normalized_text,
          language, published_at, pinned, featured, source_url, canonical_url, external_url,
          x_post_id, x_conversation_id, x_author_id, x_raw_json,
          preserve_manual_title, preserve_manual_body,
          seo_title, seo_description, og_image_media_id, word_count,
          created_at, updated_at, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.type, status, input.title, slug,
        input.excerpt ?? makeExcerpt(text), markdown, html, text,
        input.language ?? null,
        input.publishedAt ?? (status === "published" ? now : null),
        input.pinned ? 1 : 0, input.featured ? 1 : 0,
        input.sourceUrl ?? null, input.canonicalUrl ?? null, input.externalUrl ?? null,
        input.xPostId ?? null, input.xConversationId ?? null, input.xAuthorId ?? null,
        input.xRawJson ?? null,
        input.preserveManualTitle ? 1 : 0, input.preserveManualBody ? 1 : 0,
        input.seoTitle ?? null, input.seoDescription ?? null, input.ogImageMediaId ?? null,
        countWords(text), now, now, input.importedAt ?? null,
      );

    const post = this.getById(id)!;
    this.syncSearchIndex(post);
    invalidateContentCaches();
    return post;
  }

  update(id: string, input: Partial<PostInput>): PostRow {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Post not found: ${id}`);

    const markdown = input.markdownBody !== undefined ? (input.markdownBody ?? "") : (existing.markdown_body ?? "");
    const bodyChanged = input.markdownBody !== undefined && input.markdownBody !== existing.markdown_body;
    const html = bodyChanged ? renderMarkdown(markdown) : existing.html_body;
    const text = bodyChanged ? markdownToText(markdown) : (existing.normalized_text ?? "");

    let slug = existing.slug;
    if (input.slug !== undefined && input.slug && slugify(input.slug) !== existing.slug) {
      slug = uniqueSlug(input.slug, (s) => this.slugExists(s, id));
      // PRD 5.4.2 / 5.13.2: published slug change creates a permanent redirect
      if (existing.status === "published") {
        this.createRedirect(`/${existing.slug}`, `/${slug}`);
      }
    }

    const status = (input.status ?? existing.status) as PublicationStatus;
    let publishedAt = input.publishedAt !== undefined ? input.publishedAt : existing.published_at;
    if (status === "published" && !publishedAt) publishedAt = nowIso();

    const pick = <T>(value: T | undefined, fallback: T): T => (value !== undefined ? value : fallback);

    this.db
      .prepare(
        `UPDATE posts SET
          type = ?, status = ?, title = ?, slug = ?, excerpt = ?, markdown_body = ?, html_body = ?,
          normalized_text = ?, language = ?, published_at = ?, pinned = ?, featured = ?,
          source_url = ?, canonical_url = ?, external_url = ?, seo_title = ?, seo_description = ?,
          og_image_media_id = ?, preserve_manual_title = ?, preserve_manual_body = ?,
          word_count = ?, updated_at = ?
        WHERE id = ?`,
      )
      .run(
        pick(input.type, existing.type), status,
        pick(input.title, existing.title), slug,
        pick(input.excerpt, existing.excerpt),
        markdown, html, text,
        pick(input.language, existing.language), publishedAt,
        pick(input.pinned, existing.pinned === 1) ? 1 : 0,
        pick(input.featured, existing.featured === 1) ? 1 : 0,
        pick(input.sourceUrl, existing.source_url),
        pick(input.canonicalUrl, existing.canonical_url),
        pick(input.externalUrl, existing.external_url),
        pick(input.seoTitle, existing.seo_title),
        pick(input.seoDescription, existing.seo_description),
        pick(input.ogImageMediaId, existing.og_image_media_id),
        pick(input.preserveManualTitle, existing.preserve_manual_title === 1) ? 1 : 0,
        pick(input.preserveManualBody, existing.preserve_manual_body === 1) ? 1 : 0,
        bodyChanged ? countWords(text) : existing.word_count,
        nowIso(), id,
      );

    const post = this.getById(id)!;
    this.syncSearchIndex(post);
    invalidateContentCaches();
    return post;
  }

  setStatus(id: string, status: PublicationStatus): PostRow {
    return this.update(id, { status });
  }

  softDelete(id: string): void {
    this.db.prepare("UPDATE posts SET deleted_at = ?, status = 'archived', updated_at = ? WHERE id = ?")
      .run(nowIso(), nowIso(), id);
    this.db.prepare("DELETE FROM post_search WHERE post_id = ?").run(id);
    invalidateContentCaches();
  }

  createRedirect(fromPath: string, toPath: string): void {
    this.db
      .prepare(
        `INSERT INTO redirects (from_path, to_path, status_code, created_at) VALUES (?, ?, 301, ?)
         ON CONFLICT(from_path) DO UPDATE SET to_path = excluded.to_path, created_at = excluded.created_at`,
      )
      .run(fromPath, toPath, nowIso());
    // avoid loops: any redirect previously pointing at fromPath now points at toPath
    this.db.prepare("UPDATE redirects SET to_path = ? WHERE to_path = ?").run(toPath, fromPath);
    this.db.prepare("DELETE FROM redirects WHERE from_path = to_path").run();
  }

  syncSearchIndex(post: PostRow): void {
    this.db.prepare("DELETE FROM post_search WHERE post_id = ?").run(post.id);
    if (post.status === "published") {
      const tags = this.db
        .prepare(
          `SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?`,
        )
        .all(post.id)
        .map((r: any) => r.name)
        .join(" ");
      this.db
        .prepare("INSERT INTO post_search (post_id, title, excerpt, body, tags) VALUES (?, ?, ?, ?, ?)")
        .run(post.id, post.title, post.excerpt ?? "", post.normalized_text ?? "", tags);
    }
  }

  /* ---------------- read path ---------------- */

  slugExists(slug: string, excludeId?: string): boolean {
    const row = excludeId
      ? this.db.prepare("SELECT 1 FROM posts WHERE slug = ? AND id != ?").get(slug, excludeId)
      : this.db.prepare("SELECT 1 FROM posts WHERE slug = ?").get(slug);
    return !!row;
  }

  getById(id: string): PostRow | undefined {
    return this.db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as PostRow | undefined;
  }

  getBySlug(slug: string): PostRow | undefined {
    return this.db.prepare("SELECT * FROM posts WHERE slug = ? AND deleted_at IS NULL").get(slug) as
      | PostRow
      | undefined;
  }

  getByXPostId(xPostId: string): PostRow | undefined {
    return this.db.prepare("SELECT * FROM posts WHERE x_post_id = ?").get(xPostId) as PostRow | undefined;
  }

  getThreadRootByConversation(conversationId: string): PostRow | undefined {
    return this.db
      .prepare("SELECT * FROM posts WHERE x_conversation_id = ? ORDER BY imported_at ASC LIMIT 1")
      .get(conversationId) as PostRow | undefined;
  }

  /** Published archive with computed view metrics for every sort mode (PRD 4.2). */
  listArchive(opts: { sort?: SortMode; filter?: FilterMode; limit?: number; offset?: number } = {}): ArchiveItem[] {
    const sort = opts.sort ?? "latest";
    const filter = opts.filter ?? "all";
    const orderBy = SORT_SQL[sort] ?? SORT_SQL.latest;
    const where = ["p.status = 'published'", "p.deleted_at IS NULL"];
    const params: unknown[] = [daysAgoIso(30), daysAgoDate(30)];
    if (filter !== "all") {
      where.push("p.type = ?");
      params.push(filter);
    }
    params.push(opts.limit ?? 10000, opts.offset ?? 0);

    return this.db
      .prepare(
        `SELECT p.*,
          COALESCE((SELECT s.impression_count FROM x_metric_snapshots s
                    WHERE s.post_id = p.id ORDER BY s.collected_at DESC LIMIT 1), 0) AS x_views,
          COALESCE((SELECT s.impression_count FROM x_metric_snapshots s
                    WHERE s.post_id = p.id ORDER BY s.collected_at DESC LIMIT 1), 0)
            - COALESCE((SELECT s.impression_count FROM x_metric_snapshots s
                        WHERE s.post_id = p.id AND s.collected_at <= ?
                        ORDER BY s.collected_at DESC LIMIT 1), 0) AS x_views_30d,
          COALESCE((SELECT SUM(v.human_views) FROM post_daily_views v WHERE v.post_id = p.id), 0) AS blog_views,
          COALESCE((SELECT SUM(v.human_views) FROM post_daily_views v
                    WHERE v.post_id = p.id AND v.view_date >= ?), 0) AS blog_views_30d,
          (SELECT GROUP_CONCAT(t.name, ', ') FROM tags t
            JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = p.id) AS tag_names,
          (SELECT m.public_url FROM media m WHERE m.post_id = p.id
            AND m.mime_type LIKE 'image/%' ORDER BY m.sort_order LIMIT 1) AS thumbnail_url
        FROM posts p
        WHERE ${where.join(" AND ")}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      )
      .all(...params) as ArchiveItem[];
  }

  listPinned(): ArchiveItem[] {
    return this.listArchive({ sort: "latest" }).filter((p) => p.pinned === 1);
  }

  /** Chronological previous/next among published posts (PRD 5.6). */
  adjacent(post: PostRow): { prev: PostRow | undefined; next: PostRow | undefined } {
    const prev = this.db
      .prepare(
        `SELECT * FROM posts WHERE status = 'published' AND deleted_at IS NULL
         AND published_at < ? ORDER BY published_at DESC LIMIT 1`,
      )
      .get(post.published_at) as PostRow | undefined;
    const next = this.db
      .prepare(
        `SELECT * FROM posts WHERE status = 'published' AND deleted_at IS NULL
         AND published_at > ? ORDER BY published_at ASC LIMIT 1`,
      )
      .get(post.published_at) as PostRow | undefined;
    return { prev, next };
  }

  latestMetrics(postId: string): XPublicMetrics | undefined {
    const row = this.db
      .prepare("SELECT * FROM x_metric_snapshots WHERE post_id = ? ORDER BY collected_at DESC LIMIT 1")
      .get(postId) as any;
    if (!row) return undefined;
    return {
      impressionCount: row.impression_count,
      likeCount: row.like_count,
      repostCount: row.repost_count,
      replyCount: row.reply_count,
      quoteCount: row.quote_count,
      bookmarkCount: row.bookmark_count,
    };
  }

  blogViews(postId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(human_views), 0) AS total FROM post_daily_views WHERE post_id = ?")
      .get(postId) as any;
    return row.total;
  }

  totalArchiveViews(): { blog: number; x: number } {
    const blog = (this.db.prepare("SELECT COALESCE(SUM(human_views), 0) AS t FROM site_daily_views").get() as any).t;
    const x = (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(latest), 0) AS t FROM (
             SELECT MAX(impression_count) AS latest FROM x_metric_snapshots GROUP BY post_id
           )`,
        )
        .get() as any
    ).t;
    return { blog, x };
  }

  publicUrl(post: PostRow): string {
    return `${config.siteUrl}/${post.slug}`;
  }

  /* ---------------- admin listings ---------------- */

  listAdmin(opts: { status?: PublicationStatus | "all"; type?: ContentType | "all"; q?: string; limit?: number; offset?: number } = {}): PostRow[] {
    const where = ["deleted_at IS NULL"];
    const params: unknown[] = [];
    if (opts.status && opts.status !== "all") {
      where.push("status = ?");
      params.push(opts.status);
    }
    if (opts.type && opts.type !== "all") {
      where.push("type = ?");
      params.push(opts.type);
    }
    if (opts.q) {
      where.push("(title LIKE ? OR slug LIKE ?)");
      params.push(`%${opts.q}%`, `%${opts.q}%`);
    }
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    return this.db
      .prepare(
        `SELECT * FROM posts WHERE ${where.join(" AND ")}
         ORDER BY COALESCE(published_at, created_at) DESC LIMIT ? OFFSET ?`,
      )
      .all(...params) as PostRow[];
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS c FROM posts WHERE deleted_at IS NULL GROUP BY status")
      .all() as Array<{ status: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }
}
