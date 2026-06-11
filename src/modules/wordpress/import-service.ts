import type { DB } from "../../db/index.js";
import type { Logger } from "pino";
import { WordPressClient, type WpPost, type WpContentType } from "./client.js";
import { config } from "../../config/index.js";
import { PostsService } from "../posts/service.js";
import { TagsService } from "../tags/service.js";
import { MediaService } from "../media/service.js";
import { htmlToMarkdown, htmlToText } from "../../lib/markdown.js";
import { invalidateContentCaches } from "../../lib/cache.js";

export interface WordPressImportSummary {
  fetched: number;
  imported: number;
  skipped: number;
  mediaMirrored: number;
  errors: string[];
  /** Per-content-type counts (posts vs pages) for visibility in the CLI output. */
  byType: Record<WpContentType, number>;
}

/**
 * WordPress → blog importer. Walks the public WP REST API page by page and
 * mirrors every post as a native `type: "blog"` post: the WordPress slug is
 * preserved verbatim, body HTML is converted to markdown, and inline + featured
 * images are mirrored locally (so nothing keeps loading from the old host).
 *
 * Idempotent: `wp_post_id` is unique, so re-running only imports new posts.
 * Posts that are `publish` in WordPress are published here; everything else
 * (draft/pending/private/future) lands as a draft.
 */
export class WordPressImportService {
  private posts: PostsService;
  private tags: TagsService;
  private media: MediaService;

  constructor(
    private db: DB,
    private client: WordPressClient,
    private log: Logger,
    media?: MediaService,
    // Which WordPress content types to import. Defaults to both posts and pages
    // (config.wordpress.contentTypes), so an entire site comes across in one run.
    private contentTypes: WpContentType[] = config.wordpress.contentTypes,
  ) {
    this.posts = new PostsService(db);
    this.tags = new TagsService(db);
    this.media = media ?? new MediaService(db);
  }

  async runImport(): Promise<WordPressImportSummary> {
    const summary: WordPressImportSummary = {
      fetched: 0, imported: 0, skipped: 0, mediaMirrored: 0, errors: [],
      byType: { posts: 0, pages: 0 },
    };
    for (const type of this.contentTypes) await this.importContentType(type, summary);
    invalidateContentCaches();
    return summary;
  }

  private async importContentType(type: WpContentType, summary: WordPressImportSummary): Promise<void> {
    let page = 1;
    let totalPages = 1;
    do {
      const { items, totalPages: tp } = await this.client.getContentPage(type, page);
      totalPages = tp;
      summary.fetched += items.length;
      for (const item of items) {
        try {
          if (this.posts.getByWpPostId(item.id)) {
            summary.skipped++;
            continue;
          }
          await this.importPost(item, type, summary);
          summary.imported++;
          summary.byType[type]++;
        } catch (err: any) {
          summary.errors.push(`wp ${type}#${item.id}: ${err.message}`);
          this.log.error({ err, type, wpPostId: item.id }, "wordpress import: item failed");
        }
      }
      this.log.info({ type, page, totalPages, imported: summary.imported }, "wordpress import: page processed");
      page++;
    } while (page <= totalPages);
  }

  private async importPost(post: WpPost, type: WpContentType, summary: WordPressImportSummary): Promise<void> {
    const title = htmlToText(post.title.rendered) || "Untitled";
    const excerpt = htmlToText(post.excerpt.rendered) || null;
    const publishedAt = isoFromGmt(post.date_gmt);

    // WordPress pages (About, Contact, …) come in as `hidden`: reachable at their
    // own URL but kept out of the homepage, archive, RSS, sitemap and search.
    // Posts publish normally. WordPress drafts stay drafts regardless of type.
    const liveStatus = type === "pages" ? "hidden" : "published";

    const created = this.posts.create({
      title,
      slug: post.slug || undefined, // preserve the WordPress slug verbatim
      type: "blog",
      status: post.status === "publish" ? liveStatus : "draft",
      publishedAt,
      excerpt,
      // First pass: convert with original image URLs; rewritten to local below.
      markdownBody: htmlToMarkdown(post.content.rendered),
      canonicalUrl: post.link || null,
      sourceUrl: post.link || null,
      wpPostId: post.id,
      importedAt: isoNow(),
    });

    // Tags + categories become tags (skip the default "Uncategorized").
    const termNames = (post._embedded?.["wp:term"] ?? [])
      .flat()
      .map((t) => t.name)
      .filter((n) => n && n.toLowerCase() !== "uncategorized");
    if (termNames.length > 0) this.tags.setPostTags(created.id, termNames, "auto");

    // Mirror images and rewrite the body so it serves from /media (the CSP only
    // allows self + twimg for <img>, so un-mirrored WP images would be blocked).
    const urlMap = new Map<string, string>();
    let order = 0;

    const featuredUrl = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
    const featuredAlt = post._embedded?.["wp:featuredmedia"]?.[0]?.alt_text ?? null;
    let ogImageMediaId: string | null = null;
    if (featuredUrl) {
      const row = await this.mirror(created.id, featuredUrl, featuredAlt, order++, summary);
      if (row) {
        ogImageMediaId = row.id;
        urlMap.set(featuredUrl, row.public_url);
      }
    }

    for (const src of extractImageSrcs(post.content.rendered)) {
      if (urlMap.has(src)) continue;
      const row = await this.mirror(created.id, src, null, order++, summary);
      if (row) urlMap.set(src, row.public_url);
    }

    if (urlMap.size > 0 || ogImageMediaId) {
      let body = created.markdown_body ?? "";
      for (const [from, to] of urlMap) body = body.split(from).join(to);
      this.posts.update(created.id, { markdownBody: body, ogImageMediaId });
    }

    this.posts.syncSearchIndex(this.posts.getById(created.id)!);
  }

  private async mirror(
    postId: string,
    sourceUrl: string,
    altText: string | null,
    sortOrder: number,
    summary: WordPressImportSummary,
  ): Promise<{ id: string; public_url: string } | null> {
    try {
      const row = await this.media.mirrorRemote({ postId, sourceUrl, sourceType: "image", altText, sortOrder });
      summary.mediaMirrored++;
      return row;
    } catch (err: any) {
      // Media failures never block the import; the body keeps the original URL.
      summary.errors.push(`media ${sourceUrl}: ${err.message}`);
      this.log.warn({ err, postId, sourceUrl }, "wordpress import: media mirror failed");
      return null;
    }
  }
}

/** Append the UTC marker WP omits, so date_gmt parses as an ISO instant. */
function isoFromGmt(dateGmt: string): string {
  if (!dateGmt) return isoNow();
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(dateGmt) ? dateGmt : `${dateGmt}Z`;
}

function isoNow(): string {
  return new Date().toISOString();
}

/** Pull every <img src="..."> out of rendered HTML (handles single/double quotes). */
export function extractImageSrcs(html: string): string[] {
  const out: string[] = [];
  const re = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[1]!.trim();
    if (src.startsWith("http") && !out.includes(src)) out.push(src);
  }
  return out;
}
