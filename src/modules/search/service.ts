import type { DB } from "../../db/index.js";
import { daysAgoDate, daysAgoIso } from "../../lib/time.js";
import type { PostRow } from "../types.js";

export type SearchSort = "relevance" | "latest" | "most_viewed" | "x_views" | "blog_views";

export interface SearchResult extends PostRow {
  rank: number;
  x_views: number;
  blog_views: number;
}

/** Public archive search over SQLite FTS5 (PRD 5.14). */
export class SearchService {
  constructor(private db: DB) {}

  search(query: string, sort: SearchSort = "relevance", limit = 50): SearchResult[] {
    const cleaned = query
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 12);
    if (cleaned.length === 0) return [];
    const ftsQuery = cleaned.map((w) => `"${w}"*`).join(" ");

    const orderBy: Record<SearchSort, string> = {
      relevance: "rank ASC",
      latest: "p.published_at DESC",
      most_viewed: "(x_views + blog_views) DESC",
      x_views: "x_views DESC",
      blog_views: "blog_views DESC",
    };

    try {
      return this.db
        .prepare(
          `SELECT p.*, bm25(post_search) AS rank,
            COALESCE((SELECT s.impression_count FROM x_metric_snapshots s
                      WHERE s.post_id = p.id ORDER BY s.collected_at DESC LIMIT 1), 0) AS x_views,
            COALESCE((SELECT SUM(human_views) FROM post_daily_views v WHERE v.post_id = p.id), 0) AS blog_views
           FROM post_search
           JOIN posts p ON p.id = post_search.post_id
           WHERE post_search MATCH ? AND p.status = 'published' AND p.deleted_at IS NULL
           ORDER BY ${orderBy[sort]}
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as SearchResult[];
    } catch {
      return [];
    }
  }

  /** Retrieval for the AMA feature: top fragments with context. */
  retrieveFragments(question: string, limit = 6): Array<{ postId: string; title: string; slug: string; text: string }> {
    const results = this.search(question, "relevance", limit);
    return results.map((r) => ({
      postId: r.id,
      title: r.title,
      slug: r.slug,
      text: (r.normalized_text ?? "").slice(0, 1500),
    }));
  }
}
