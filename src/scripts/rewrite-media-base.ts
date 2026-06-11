/**
 * One-time, idempotent rewrite of stored media URLs to include the configured
 * BASE_PATH. Run after switching a deployment to a sub-path (e.g. BASE_PATH=/blog)
 * so that media imported before the change resolves through the same proxy route.
 *
 *   npm run rewrite-media-base       # uses BASE_PATH from the environment
 *
 * Idempotent: occurrences of `/media/` are only rewritten when immediately
 * preceded by a quote, `(`, or `=`, so a previously rewritten `/blog/media/`
 * (preceded by `g`) is never matched again.
 */
import { getDb } from "../db/index.js";
import { config } from "../config/index.js";

const basePath = config.basePath;
if (!basePath) {
  console.log("BASE_PATH is empty — nothing to rewrite.");
  process.exit(0);
}

const db = getDb();
// Match /media/ only after a delimiter so /blog/media/ is left untouched on re-runs.
const bodyPattern = /([="'(])\/media\//g;
const replacement = `$1${basePath}/media/`;

const rewriteBodies = db.transaction(() => {
  let bodiesChanged = 0;
  const rows = db
    .prepare("SELECT id, markdown_body, html_body FROM posts")
    .all() as { id: string; markdown_body: string | null; html_body: string | null }[];
  const update = db.prepare("UPDATE posts SET markdown_body = ?, html_body = ? WHERE id = ?");
  for (const row of rows) {
    const md = row.markdown_body?.replace(bodyPattern, replacement) ?? null;
    const html = row.html_body?.replace(bodyPattern, replacement) ?? null;
    if (md !== row.markdown_body || html !== row.html_body) {
      update.run(md, html, row.id);
      bodiesChanged++;
    }
  }
  return bodiesChanged;
});

// media.public_url is stored bare (e.g. /media/ab/<hash>.jpg) — prepend basePath once.
const mediaUpdated = db
  .prepare(
    `UPDATE media SET public_url = ? || public_url
     WHERE public_url LIKE '/media/%' AND public_url NOT LIKE ? || '/media/%'`,
  )
  .run(basePath, basePath).changes;

const bodiesChanged = rewriteBodies();

console.log(`Rewrote media URLs for base path "${basePath}":`);
console.log(`  posts (markdown/html bodies) updated: ${bodiesChanged}`);
console.log(`  media.public_url rows updated:        ${mediaUpdated}`);
process.exit(0);
