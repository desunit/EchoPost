import type { DB } from "../../db/index.js";
import { config } from "../../config/index.js";
import { cache } from "../../lib/cache.js";
import { escapeHtml } from "../../lib/markdown.js";
import { SettingsService } from "../settings/service.js";
import type { ContentType, PostRow } from "../types.js";

function cdata(html: string): string {
  return `<![CDATA[${html.replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

/** RSS 2.0 feeds (PRD 5.12): /rss plus /rss/x, /rss/blog, /tag/:slug/rss. */
export class RssService {
  private settings: SettingsService;

  constructor(private db: DB) {
    this.settings = new SettingsService(db);
  }

  private queryPosts(opts: { type?: ContentType; tagSlug?: string }): PostRow[] {
    if (opts.tagSlug) {
      return this.db
        .prepare(
          `SELECT p.* FROM posts p
           JOIN post_tags pt ON pt.post_id = p.id
           JOIN tags t ON t.id = pt.tag_id
           WHERE t.slug = ? AND p.status = 'published' AND p.deleted_at IS NULL
           ORDER BY p.published_at DESC LIMIT 50`,
        )
        .all(opts.tagSlug) as PostRow[];
    }
    const where = ["status = 'published'", "deleted_at IS NULL"];
    const params: unknown[] = [];
    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
    }
    return this.db
      .prepare(`SELECT * FROM posts WHERE ${where.join(" AND ")} ORDER BY published_at DESC LIMIT 50`)
      .all(...params) as PostRow[];
  }

  build(opts: { type?: ContentType; tagSlug?: string; title?: string } = {}): string {
    const cacheKey = `rss:${opts.type ?? "all"}:${opts.tagSlug ?? ""}`;
    return cache.getOrCompute(cacheKey, 5 * 60_000, () => {
      const site = this.settings.getSiteSettings();
      const fullContent = site.rssIncludeFullContent;
      const posts = this.queryPosts(opts);
      const feedTitle = opts.title ?? config.siteTitle;

      const items = posts
        .map((p) => {
          const url = `${config.publicUrl}/${p.slug}`;
          const media = this.db
            .prepare("SELECT public_url, mime_type FROM media WHERE post_id = ? AND mime_type LIKE 'image/%' ORDER BY sort_order LIMIT 1")
            .get(p.id) as { public_url: string; mime_type: string } | undefined;
          const enclosure = media
            ? `\n      <enclosure url="${escapeHtml(config.siteUrl + media.public_url)}" type="${escapeHtml(media.mime_type)}" length="0"/>`
            : "";
          const sourceLink =
            p.type === "x_post" && p.source_url
              ? `<p><a href="${escapeHtml(p.source_url)}">Originally posted on X</a></p>`
              : "";
          const content = fullContent ? (p.html_body ?? "") + sourceLink : "";
          return `    <item>
      <title>${escapeHtml(p.title)}</title>
      <link>${escapeHtml(url)}</link>
      <guid isPermaLink="true">${escapeHtml(url)}</guid>
      <pubDate>${new Date(p.published_at ?? p.created_at).toUTCString()}</pubDate>
      <category>${escapeHtml(p.type)}</category>
      <description>${cdata(escapeHtml(p.excerpt ?? ""))}</description>${
        content ? `\n      <content:encoded>${cdata(content)}</content:encoded>` : ""
      }${enclosure}
    </item>`;
        })
        .join("\n");

      return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeHtml(feedTitle)}</title>
    <link>${escapeHtml(config.publicUrl)}</link>
    <description>${escapeHtml(config.siteDescription)}</description>
    <language>en</language>
    <atom:link href="${escapeHtml(config.publicUrl)}/rss" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
    });
  }
}
