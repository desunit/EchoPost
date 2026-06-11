import type { DB } from "../../db/index.js";
import { visitorHash } from "../../lib/crypto.js";
import { todayDate, daysAgoDate } from "../../lib/time.js";

const BOT_PATTERNS =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|twitterbot|whatsapp|telegram|discordbot|linkedinbot|embedly|quora|pinterest|vkshare|redditbot|applebot|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|anthropic|perplexity|ccbot|amazonbot|google-extended|feedfetcher|feedly|rss|uptime|pingdom|statuscake|monitor|curl|wget|python-requests|axios|go-http-client|okhttp|headless/i;

export function isBot(userAgent: string | undefined): boolean {
  if (!userAgent) return true;
  return BOT_PATTERNS.test(userAgent);
}

export function referrerDomain(referrer: string | undefined, ownHost: string): string | null {
  if (!referrer) return null;
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, "");
    return host === ownHost.replace(/^www\./, "") ? null : host;
  } catch {
    return null;
  }
}

/**
 * Privacy-first internal analytics (PRD 5.8): no raw IPs, daily-rotating
 * visitor hash, bot traffic counted separately, bounded daily aggregates.
 */
export class AnalyticsService {
  constructor(private db: DB) {}

  recordView(input: {
    postId: string | null;
    ip: string;
    userAgent: string | undefined;
    referrer: string | undefined;
    ownHost: string;
  }): void {
    const date = todayDate();
    const bot = isBot(input.userAgent);
    const hash = visitorHash(input.ip, input.userAgent ?? "", date);

    const run = this.db.transaction(() => {
      // site-level counters
      this.db
        .prepare(
          `INSERT INTO site_daily_views (view_date, human_views, bot_views, unique_visitors)
           VALUES (?, ?, ?, 0)
           ON CONFLICT(view_date) DO UPDATE SET
             human_views = human_views + excluded.human_views,
             bot_views = bot_views + excluded.bot_views`,
        )
        .run(date, bot ? 0 : 1, bot ? 1 : 0);

      if (input.postId) {
        this.db
          .prepare(
            `INSERT INTO post_daily_views (post_id, view_date, human_views, bot_views, unique_visitors)
             VALUES (?, ?, ?, ?, 0)
             ON CONFLICT(post_id, view_date) DO UPDATE SET
               human_views = human_views + excluded.human_views,
               bot_views = bot_views + excluded.bot_views`,
          )
          .run(input.postId, date, bot ? 0 : 1, bot ? 1 : 0);
      }

      if (!bot) {
        // short-lived visitor log feeds the unique-visitor estimate; pruned daily
        const siteNew = this.db
          .prepare("INSERT OR IGNORE INTO daily_visitor_log (view_date, visitor_hash, post_id) VALUES (?, ?, '')")
          .run(date, hash);
        if (siteNew.changes > 0) {
          this.db
            .prepare("UPDATE site_daily_views SET unique_visitors = unique_visitors + 1 WHERE view_date = ?")
            .run(date);
        }
        if (input.postId) {
          const postNew = this.db
            .prepare("INSERT OR IGNORE INTO daily_visitor_log (view_date, visitor_hash, post_id) VALUES (?, ?, ?)")
            .run(date, hash, input.postId);
          if (postNew.changes > 0) {
            this.db
              .prepare(
                "UPDATE post_daily_views SET unique_visitors = unique_visitors + 1 WHERE post_id = ? AND view_date = ?",
              )
              .run(input.postId, date);
          }
        }

        const domain = referrerDomain(input.referrer, input.ownHost);
        if (domain && input.postId) {
          this.db
            .prepare(
              `INSERT INTO referrer_daily_stats (post_id, view_date, referrer_domain, view_count)
               VALUES (?, ?, ?, 1)
               ON CONFLICT(post_id, view_date, referrer_domain) DO UPDATE SET view_count = view_count + 1`,
            )
            .run(input.postId, date, domain.slice(0, 100));
        }
      }
    });
    run();
  }

  pruneVisitorLog(keepDays = 3): number {
    return this.db
      .prepare("DELETE FROM daily_visitor_log WHERE view_date < ?")
      .run(daysAgoDate(keepDays)).changes;
  }

  siteTotals(): { humanViews: number; botViews: number } {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(human_views),0) AS h, COALESCE(SUM(bot_views),0) AS b FROM site_daily_views")
      .get() as any;
    return { humanViews: row.h, botViews: row.b };
  }

  viewsToday(): number {
    const row = this.db
      .prepare("SELECT human_views FROM site_daily_views WHERE view_date = ?")
      .get(todayDate()) as any;
    return row?.human_views ?? 0;
  }

  topPostsByBlogViews(days: number, limit = 10): Array<{ id: string; title: string; slug: string; views: number }> {
    return this.db
      .prepare(
        `SELECT p.id, p.title, p.slug, SUM(v.human_views) AS views
         FROM post_daily_views v JOIN posts p ON p.id = v.post_id
         WHERE v.view_date >= ? AND p.status = 'published'
         GROUP BY p.id ORDER BY views DESC LIMIT ?`,
      )
      .all(daysAgoDate(days), limit) as any;
  }

  topReferrers(days: number, limit = 10): Array<{ referrer_domain: string; views: number }> {
    return this.db
      .prepare(
        `SELECT referrer_domain, SUM(view_count) AS views FROM referrer_daily_stats
         WHERE view_date >= ? GROUP BY referrer_domain ORDER BY views DESC LIMIT ?`,
      )
      .all(daysAgoDate(days), limit) as any;
  }

  dailySeries(days: number): Array<{ view_date: string; human_views: number; bot_views: number; unique_visitors: number }> {
    return this.db
      .prepare("SELECT * FROM site_daily_views WHERE view_date >= ? ORDER BY view_date")
      .all(daysAgoDate(days)) as any;
  }
}
