import { runMigrations } from "../db/migrate.js";
import { getDb } from "../db/index.js";
import { config } from "../config/index.js";
import { IndexNowService } from "../modules/seo/indexnow.js";

/**
 * One-shot bulk IndexNow submission: pings every URL the sitemap lists
 * (homepage, /tags, /stats, published posts, tag pages). Useful right after
 * enabling IndexNow or after a bulk import, so engines learn about the whole
 * archive without waiting for a sitemap re-crawl. Pings directly (no job
 * queue) — running the script is explicit intent, so INDEXNOW_ENABLED is
 * ignored; only a localhost SITE_URL is refused.
 */
const host = new URL(config.siteUrl).hostname;
if (host === "localhost" || host === "127.0.0.1") {
  console.error(`SITE_URL is ${config.siteUrl} — engines can't reach localhost. Set SITE_URL first.`);
  process.exit(1);
}

const db = getDb();
runMigrations(db);
const indexNow = new IndexNowService(db);

const posts = db
  .prepare("SELECT slug FROM posts WHERE status = 'published' AND deleted_at IS NULL ORDER BY published_at DESC")
  .all() as Array<{ slug: string }>;
const tags = db
  .prepare(
    `SELECT DISTINCT t.slug FROM tags t
     JOIN post_tags pt ON pt.tag_id = t.id
     JOIN posts p ON p.id = pt.post_id AND p.status = 'published' AND p.deleted_at IS NULL`,
  )
  .all() as Array<{ slug: string }>;

const urls = [
  `${config.publicUrl}/`,
  `${config.publicUrl}/tags`,
  `${config.publicUrl}/stats`,
  ...posts.map((p) => `${config.publicUrl}/${p.slug}`),
  ...tags.map((t) => `${config.publicUrl}/tag/${t.slug}`),
];

console.log(`Submitting ${urls.length} URLs (${posts.length} posts, ${tags.length} tag pages) for ${host}`);
console.log(`Key file: ${config.publicUrl}/${indexNow.keyFileName}`);

// IndexNow caps a single POST at 10,000 URLs.
for (let i = 0; i < urls.length; i += 10_000) {
  const batch = urls.slice(i, i + 10_000);
  await indexNow.ping(batch);
  console.log(`Batch ${i / 10_000 + 1}: ${batch.length} URLs accepted`);
}
console.log("Done.");
