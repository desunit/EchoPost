import type { DB } from "../../db/index.js";
import { config } from "../../config/index.js";
import { cache } from "../../lib/cache.js";
import { escapeHtml } from "../../lib/markdown.js";
import type { PostRow } from "../types.js";

/** Sitemap, robots.txt, redirects, and JSON-LD (PRD 5.13). */
export class SeoService {
  constructor(private db: DB) {}

  sitemap(): string {
    return cache.getOrCompute("sitemap", 10 * 60_000, () => {
      const urls: Array<{ loc: string; lastmod?: string }> = [
        { loc: `${config.publicUrl}/` },
        { loc: `${config.publicUrl}/tags` },
        { loc: `${config.publicUrl}/stats` },
      ];

      const posts = this.db
        .prepare(
          "SELECT slug, updated_at FROM posts WHERE status = 'published' AND deleted_at IS NULL ORDER BY published_at DESC",
        )
        .all() as Array<{ slug: string; updated_at: string }>;
      for (const p of posts) {
        urls.push({ loc: `${config.publicUrl}/${p.slug}`, lastmod: p.updated_at.slice(0, 10) });
      }

      const tags = this.db
        .prepare(
          `SELECT t.slug, MAX(p.updated_at) AS lastmod FROM tags t
           JOIN post_tags pt ON pt.tag_id = t.id
           JOIN posts p ON p.id = pt.post_id AND p.status = 'published' AND p.deleted_at IS NULL
           GROUP BY t.slug`,
        )
        .all() as Array<{ slug: string; lastmod: string | null }>;
      for (const t of tags) {
        urls.push({ loc: `${config.publicUrl}/tag/${t.slug}`, lastmod: t.lastmod?.slice(0, 10) });
      }

      const entries = urls
        .map(
          (u) =>
            `  <url><loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`,
        )
        .join("\n");
      return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
    });
  }

  robotsTxt(): string {
    const bp = config.basePath;
    return `User-agent: *
Disallow: ${bp}/admin
Disallow: ${bp}/subscribe
Disallow: ${bp}/unsubscribe

Sitemap: ${config.publicUrl}/sitemap.xml
`;
  }

  findRedirect(path: string): { to_path: string; status_code: number } | undefined {
    return this.db.prepare("SELECT to_path, status_code FROM redirects WHERE from_path = ?").get(path) as
      | { to_path: string; status_code: number }
      | undefined;
  }

  jsonLd(post: PostRow, authorName: string, image?: string): string {
    const url = `${config.publicUrl}/${post.slug}`;
    const data = {
      "@context": "https://schema.org",
      "@type": post.type === "blog" ? "BlogPosting" : "Article",
      headline: post.title,
      datePublished: post.published_at,
      dateModified: post.updated_at,
      author: { "@type": "Person", name: authorName, url: config.publicUrl + "/" },
      publisher: { "@type": "Person", name: authorName },
      mainEntityOfPage: url,
      url,
      ...(image ? { image: [image] } : {}),
      description: post.seo_description ?? post.excerpt ?? "",
      wordCount: post.word_count,
    };
    // </script> can't appear inside a JSON-LD block
    return JSON.stringify(data).replace(/</g, "\\u003c");
  }

  /** WebSite (with sitelinks SearchAction) + Blog markup for the homepage. */
  siteJsonLd(name: string, description: string): string {
    const home = `${config.publicUrl}/`;
    const data = {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebSite",
          name,
          description,
          url: home,
          potentialAction: {
            "@type": "SearchAction",
            target: { "@type": "EntryPoint", urlTemplate: `${config.publicUrl}/search?q={search_term_string}` },
            "query-input": "required name=search_term_string",
          },
        },
        { "@type": "Blog", name, description, url: home },
      ],
    };
    return JSON.stringify(data).replace(/</g, "\\u003c");
  }
}
