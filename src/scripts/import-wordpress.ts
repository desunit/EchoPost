/**
 * One-shot WordPress → blog importer.
 *
 *   npm run import-wordpress                 # uses WORDPRESS_URL from .env
 *   npm run import-wordpress -- https://blog.example.com
 *
 * Downloads every post from the WordPress REST API, preserves each slug, mirrors
 * inline + featured images locally, and stores them as published `type: "blog"`
 * posts. Idempotent — safe to re-run; only new posts are imported.
 */
import pino from "pino";
import { getDb } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { config } from "../config/index.js";
import { WordPressClient } from "../modules/wordpress/client.js";
import { WordPressImportService } from "../modules/wordpress/import-service.js";
import { RelatedPostsService } from "../modules/related-posts/service.js";

const log = pino({ transport: { target: "pino-pretty" } });

const urlArg = process.argv[2]?.trim().replace(/\/$/, "");
const baseUrl = urlArg || config.wordpress.url;

if (!baseUrl) {
  log.error("No WordPress URL. Set WORDPRESS_URL in .env or pass it: npm run import-wordpress -- https://blog.example.com");
  process.exit(1);
}

const wpHost = new URL(baseUrl).hostname;
if (!config.media.allowedHosts.includes(wpHost)) {
  log.warn(
    { wpHost, allowedHosts: config.media.allowedHosts },
    "WordPress host is not in the media allowlist — images will NOT be mirrored. " +
      "Set WORDPRESS_URL in .env (and MEDIA_EXTRA_ALLOWED_HOSTS for any CDN host) and re-run.",
  );
}

const db = getDb();
runMigrations(db);

const client = new WordPressClient(baseUrl);
const importer = new WordPressImportService(db, client, log);

log.info({ baseUrl }, "starting WordPress import");
const summary = await importer.runImport();
log.info(summary, "WordPress import finished");

// The worker (which normally recalculates related posts after an X import) isn't
// running in this one-shot CLI, so recompute related posts inline — otherwise
// imported posts show an empty "Related posts" section until the nightly job.
if (summary.imported > 0) {
  log.info("recalculating related posts…");
  new RelatedPostsService(db).recalculateAll();
}

if (summary.errors.length > 0) {
  log.warn({ count: summary.errors.length, sample: summary.errors.slice(0, 10) }, "import completed with errors");
}

process.exit(0);
