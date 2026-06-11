import type { DB } from "../../db/index.js";
import { nowIso } from "../../lib/time.js";
import { cache } from "../../lib/cache.js";
import type { PostRow } from "../types.js";

/**
 * Hybrid related-post scoring (PRD 5.7.1):
 *   0.45 tag similarity + 0.25 text similarity + 0.10 content-type
 *   + 0.10 recency diversity + 0.10 popularity
 * Manual overrides: source='pinned' rows always rank first,
 * source='blocked' rows are never shown and survive recalculation.
 */
export class RelatedPostsService {
  constructor(private db: DB) {}

  recalculateForPost(postId: string): void {
    const post = this.db.prepare("SELECT * FROM posts WHERE id = ?").get(postId) as PostRow | undefined;
    if (!post || post.status !== "published") return;

    const candidates = this.db
      .prepare(
        `SELECT p.id, p.type, p.published_at,
          (SELECT GROUP_CONCAT(tag_id) FROM post_tags WHERE post_id = p.id) AS tag_ids,
          COALESCE((SELECT s.impression_count FROM x_metric_snapshots s
                    WHERE s.post_id = p.id ORDER BY s.collected_at DESC LIMIT 1), 0) AS x_views,
          COALESCE((SELECT SUM(human_views) FROM post_daily_views WHERE post_id = p.id), 0) AS blog_views
         FROM posts p
         WHERE p.status = 'published' AND p.deleted_at IS NULL AND p.id != ?`,
      )
      .all(postId) as Array<{
        id: string; type: string; published_at: string | null;
        tag_ids: string | null; x_views: number; blog_views: number;
      }>;
    if (candidates.length === 0) {
      this.replaceAuto(postId, []);
      return;
    }

    const myTags = new Set(
      (this.db.prepare("SELECT tag_id FROM post_tags WHERE post_id = ?").all(postId) as any[]).map(
        (r) => r.tag_id,
      ),
    );

    // FTS text similarity: match candidate index rows against this post's title + excerpt terms
    const textScores = new Map<string, number>();
    const queryText = `${post.title} ${post.excerpt ?? ""}`
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 24);
    if (queryText.length > 0) {
      const ftsQuery = queryText.map((w) => `"${w}"`).join(" OR ");
      try {
        const rows = this.db
          .prepare(
            `SELECT post_id, bm25(post_search) AS rank FROM post_search
             WHERE post_search MATCH ? AND post_id != ? ORDER BY rank LIMIT 100`,
          )
          .all(ftsQuery, postId) as Array<{ post_id: string; rank: number }>;
        // bm25 is negative-better in SQLite; normalize to 0..1
        const best = rows.length ? Math.min(...rows.map((r) => r.rank)) : 0;
        for (const r of rows) {
          textScores.set(r.post_id, best === 0 ? 0 : Math.max(0, Math.min(1, r.rank / best)));
        }
      } catch {
        // malformed FTS query — fall back to zero text similarity
      }
    }

    const maxPopularity = Math.max(1, ...candidates.map((c) => c.x_views + c.blog_views * 50));
    const myTime = post.published_at ? new Date(post.published_at).getTime() : Date.now();

    const scored = candidates.map((c) => {
      const theirTags = new Set((c.tag_ids ?? "").split(",").filter(Boolean));
      const intersection = [...myTags].filter((t) => theirTags.has(t)).length;
      const union = new Set([...myTags, ...theirTags]).size;
      const tagSim = union === 0 ? 0 : intersection / union;

      const textSim = textScores.get(c.id) ?? 0;
      const typeSim = c.type === post.type ? 1 : 0;

      // recency diversity: favor posts from a different era so suggestions
      // surface older content; furthest in time scores highest
      const theirTime = c.published_at ? new Date(c.published_at).getTime() : Date.now();
      const yearsApart = Math.abs(myTime - theirTime) / (365 * 86_400_000);
      const recencyDiversity = Math.min(1, yearsApart / 3);

      const popularity = (c.x_views + c.blog_views * 50) / maxPopularity;

      const score =
        0.45 * tagSim + 0.25 * textSim + 0.1 * typeSim + 0.1 * recencyDiversity + 0.1 * popularity;
      return { id: c.id, score, publishedAt: c.published_at };
    });

    scored.sort((a, b) => b.score - a.score);

    // diversity rule: max two posts from the same ISO week (unless archive is small)
    const small = candidates.length < 20;
    const weekCounts = new Map<string, number>();
    const picked: Array<{ id: string; score: number }> = [];
    for (const s of scored) {
      if (picked.length >= 5) break;
      if (s.score <= 0) continue;
      const week = s.publishedAt ? s.publishedAt.slice(0, 10) : "unknown";
      const weekKey = week.slice(0, 8); // coarse: same ~week bucket
      const count = weekCounts.get(weekKey) ?? 0;
      if (!small && count >= 2) continue;
      weekCounts.set(weekKey, count + 1);
      picked.push({ id: s.id, score: s.score });
    }

    this.replaceAuto(postId, picked);
    cache.invalidate(`related:${postId}`);
  }

  private replaceAuto(postId: string, picked: Array<{ id: string; score: number }>): void {
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM related_posts WHERE post_id = ? AND source = 'auto'").run(postId);
      const blocked = new Set(
        (this.db
          .prepare("SELECT related_post_id FROM related_posts WHERE post_id = ? AND source = 'blocked'")
          .all(postId) as any[]).map((r) => r.related_post_id),
      );
      const pinnedCount = (
        this.db
          .prepare("SELECT COUNT(*) AS c FROM related_posts WHERE post_id = ? AND source = 'pinned'")
          .get(postId) as any
      ).c;
      let order = pinnedCount;
      for (const p of picked) {
        if (blocked.has(p.id)) continue;
        this.db
          .prepare(
            `INSERT INTO related_posts (post_id, related_post_id, score, source, sort_order, created_at)
             VALUES (?, ?, ?, 'auto', ?, ?)
             ON CONFLICT(post_id, related_post_id) DO NOTHING`,
          )
          .run(postId, p.id, p.score, order++, nowIso());
      }
    });
    run();
  }

  recalculateAll(): void {
    const ids = this.db
      .prepare("SELECT id FROM posts WHERE status = 'published' AND deleted_at IS NULL")
      .all() as Array<{ id: string }>;
    for (const { id } of ids) this.recalculateForPost(id);
  }

  /** Public related posts: pinned first, then auto, never blocked/hidden/draft. */
  forPost(postId: string, limit = 5): PostRow[] {
    return this.db
      .prepare(
        `SELECT p.* FROM related_posts r
         JOIN posts p ON p.id = r.related_post_id
         WHERE r.post_id = ? AND r.source != 'blocked'
           AND p.status = 'published' AND p.deleted_at IS NULL
         ORDER BY CASE r.source WHEN 'pinned' THEN 0 ELSE 1 END, r.sort_order
         LIMIT ?`,
      )
      .all(postId, limit) as PostRow[];
  }

  pin(postId: string, relatedPostId: string): void {
    this.db
      .prepare(
        `INSERT INTO related_posts (post_id, related_post_id, score, source, sort_order, created_at)
         VALUES (?, ?, 1.0, 'pinned', -1, ?)
         ON CONFLICT(post_id, related_post_id) DO UPDATE SET source = 'pinned', score = 1.0`,
      )
      .run(postId, relatedPostId, nowIso());
  }

  block(postId: string, relatedPostId: string): void {
    this.db
      .prepare(
        `INSERT INTO related_posts (post_id, related_post_id, score, source, sort_order, created_at)
         VALUES (?, ?, 0, 'blocked', 999, ?)
         ON CONFLICT(post_id, related_post_id) DO UPDATE SET source = 'blocked'`,
      )
      .run(postId, relatedPostId, nowIso());
  }
}
