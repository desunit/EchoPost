import type { DB } from "../../db/index.js";
import { cache } from "../../lib/cache.js";
import { daysAgoDate, daysAgoIso } from "../../lib/time.js";
import { SettingsService } from "../settings/service.js";

const STOP_WORDS = new Set(
  (
    "a an and are as at be but by for from has have how i if in into is it its just me my of on or our so that " +
    "the their then there these they this to was we what when which who will with you your not no can do does " +
    "did been being am were would could should them he she his her us out up down about over under very really " +
    "also more most some any all each other than too only now get got like one two new dont im its thats youre " +
    "ive id ill weve theyre isnt arent wasnt werent didnt doesnt cant wont because while where why when after " +
    "before during between against once here both few such own same s t don should now"
  ).split(/\s+/),
);

export interface PublicStats {
  totalPosts: number;
  totalWords: number;
  totalXViews: number;
  totalBlogViews: number;
  totalCombinedViews: number;
  totalTags: number;
  firstYear: number | null;
  topTags: Array<{ name: string; slug: string; count: number }>;
  mostViewedX: Array<{ title: string; slug: string; views: number }>;
  mostViewedBlog: Array<{ title: string; slug: string; views: number }>;
  topGrowthX30d: Array<{ title: string; slug: string; views: number }>;
  topGrowthBlog30d: Array<{ title: string; slug: string; views: number }>;
  topWords: Array<{ word: string; count: number }>;
  postSquares: Array<{ slug: string; title: string; year: number; group: string }>;
}

export const TOPIC_GROUPS = [
  "Business and tech",
  "Travel and countries",
  "Music and arts",
  "Politics",
  "Society",
  "Health and life",
  "Philosophy",
  "Other",
];

/** Public /stats aggregation (PRD 5.11), cached for an hour. */
export class StatsService {
  private settings: SettingsService;

  constructor(private db: DB) {
    this.settings = new SettingsService(db);
  }

  build(): PublicStats {
    return cache.getOrCompute("stats", 60 * 60_000, () => this.compute());
  }

  private compute(): PublicStats {
    const db = this.db;
    const published = "p.status = 'published' AND p.deleted_at IS NULL";

    const totals = db
      .prepare(
        `SELECT COUNT(*) AS posts, COALESCE(SUM(word_count), 0) AS words,
          MIN(published_at) AS first FROM posts p WHERE ${published}`,
      )
      .get() as any;

    const totalXViews = (
      db.prepare(
        `SELECT COALESCE(SUM(latest), 0) AS t FROM (
           SELECT MAX(s.impression_count) AS latest FROM x_metric_snapshots s
           JOIN posts p ON p.id = s.post_id WHERE ${published} GROUP BY s.post_id)`,
      ).get() as any
    ).t;

    const totalBlogViews = (
      db.prepare("SELECT COALESCE(SUM(human_views), 0) AS t FROM site_daily_views").get() as any
    ).t;

    const totalTags = (
      db.prepare(
        `SELECT COUNT(DISTINCT t.id) AS c FROM tags t
         JOIN post_tags pt ON pt.tag_id = t.id
         JOIN posts p ON p.id = pt.post_id WHERE ${published}`,
      ).get() as any
    ).c;

    const topTags = db
      .prepare(
        `SELECT t.name, t.slug, COUNT(*) AS count FROM tags t
         JOIN post_tags pt ON pt.tag_id = t.id
         JOIN posts p ON p.id = pt.post_id
         WHERE ${published}
         GROUP BY t.id ORDER BY count DESC LIMIT 20`,
      )
      .all() as any;

    const mostViewedX = db
      .prepare(
        `SELECT title, slug, views FROM (
           SELECT p.title, p.slug,
             (SELECT MAX(impression_count) FROM x_metric_snapshots s WHERE s.post_id = p.id) AS views
           FROM posts p WHERE ${published}
         ) WHERE views IS NOT NULL ORDER BY views DESC LIMIT 10`,
      )
      .all() as any;

    const mostViewedBlog = db
      .prepare(
        `SELECT p.title, p.slug, SUM(v.human_views) AS views
         FROM posts p JOIN post_daily_views v ON v.post_id = p.id
         WHERE ${published} GROUP BY p.id HAVING views > 0
         ORDER BY views DESC LIMIT 10`,
      )
      .all() as any;

    const topGrowthX30d = db
      .prepare(
        `SELECT p.title, p.slug,
          COALESCE((SELECT s.impression_count FROM x_metric_snapshots s
                    WHERE s.post_id = p.id ORDER BY s.collected_at DESC LIMIT 1), 0)
          - COALESCE((SELECT s.impression_count FROM x_metric_snapshots s
                      WHERE s.post_id = p.id AND s.collected_at <= ?
                      ORDER BY s.collected_at DESC LIMIT 1), 0) AS views
         FROM posts p WHERE ${published} AND p.x_post_id IS NOT NULL
         ORDER BY views DESC LIMIT 10`,
      )
      .all(daysAgoIso(30)) as any;

    const topGrowthBlog30d = db
      .prepare(
        `SELECT p.title, p.slug, SUM(v.human_views) AS views
         FROM posts p JOIN post_daily_views v ON v.post_id = p.id
         WHERE ${published} AND v.view_date >= ?
         GROUP BY p.id HAVING views > 0 ORDER BY views DESC LIMIT 10`,
      )
      .all(daysAgoDate(30)) as any;

    // most-used words (PRD 5.11.4)
    const ignored = new Set(this.settings.getSiteSettings().statsIgnoredWords.map((w) => w.toLowerCase()));
    const freq = new Map<string, number>();
    const texts = db
      .prepare(`SELECT normalized_text FROM posts p WHERE ${published} AND normalized_text IS NOT NULL`)
      .all() as Array<{ normalized_text: string }>;
    for (const { normalized_text } of texts) {
      const words = normalized_text
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^\p{L}\s]/gu, " ")
        .split(/\s+/);
      for (const w of words) {
        if (w.length < 4 || STOP_WORDS.has(w) || ignored.has(w)) continue;
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
    }
    const topWords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([word, count]) => ({ word, count }));

    // one square per post, grouped by topic category (PRD 5.11.5)
    const squares = db
      .prepare(
        `SELECT p.slug, p.title, p.published_at,
          (SELECT t.category_group FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
           WHERE pt.post_id = p.id AND t.category_group IS NOT NULL LIMIT 1) AS grp
         FROM posts p WHERE ${published} ORDER BY p.published_at ASC`,
      )
      .all() as any[];

    return {
      totalPosts: totals.posts,
      totalWords: totals.words,
      totalXViews,
      totalBlogViews,
      totalCombinedViews: totalXViews + totalBlogViews,
      totalTags,
      firstYear: totals.first ? new Date(totals.first).getUTCFullYear() : null,
      topTags,
      mostViewedX,
      mostViewedBlog,
      topGrowthX30d,
      topGrowthBlog30d,
      topWords,
      postSquares: squares.map((s) => ({
        slug: s.slug,
        title: s.title,
        year: s.published_at ? new Date(s.published_at).getUTCFullYear() : 0,
        group: s.grp ?? "Other",
      })),
    };
  }
}
