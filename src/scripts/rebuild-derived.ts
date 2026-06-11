/**
 * Rebuild every post's derived fields from its canonical `markdown_body`:
 * `html_body`, `normalized_text`, `word_count`, and the FTS `post_search` index.
 *
 *   npm run rebuild-derived
 *
 * The rendered `html_body` is stored once (at import/save) and served verbatim,
 * so posts created before a rendering change keep their old HTML until the body
 * is regenerated. Run this after any change to the markdown→HTML pipeline — e.g.
 * the off-site `rel="nofollow"` policy (which only applies to bodies rendered
 * after it shipped) — to bring existing posts in line with the current renderer.
 *
 * Idempotent: re-rendering the same markdown yields the same output, so a second
 * run reports zero changes. Take a backup first on production (`npm run backup`).
 */
import { getDb } from "../db/index.js";
import { PostsService } from "../modules/posts/service.js";
import { renderMarkdown, markdownToText, countWords } from "../lib/markdown.js";
import type { PostRow } from "../modules/types.js";

const db = getDb();
const posts = new PostsService(db);

type Row = Pick<PostRow, "id" | "status" | "title" | "excerpt" | "markdown_body" | "html_body">;

const rebuild = db.transaction(() => {
  const rows = db
    .prepare("SELECT id, status, title, excerpt, markdown_body, html_body FROM posts")
    .all() as Row[];
  const update = db.prepare(
    "UPDATE posts SET html_body = ?, normalized_text = ?, word_count = ? WHERE id = ?",
  );

  let scanned = 0;
  let htmlChanged = 0;
  for (const row of rows) {
    scanned++;
    const markdown = row.markdown_body ?? "";
    const html = markdown ? renderMarkdown(markdown) : "";
    const text = markdown ? markdownToText(markdown) : "";
    const wordCount = countWords(text);

    if (html !== (row.html_body ?? "")) htmlChanged++;

    update.run(html, text, wordCount, row.id);
    // Re-index published posts (syncSearchIndex no-ops for non-published).
    posts.syncSearchIndex({ ...row, normalized_text: text } as PostRow);
  }
  return { scanned, htmlChanged };
});

const { scanned, htmlChanged } = rebuild();

console.log("Rebuilt derived fields from markdown_body:");
console.log(`  posts scanned:            ${scanned}`);
console.log(`  posts with HTML changes:  ${htmlChanged}`);
console.log("  normalized_text, word_count, and post_search re-synced for all posts.");
process.exit(0);
