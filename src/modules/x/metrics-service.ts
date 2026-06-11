import type { DB } from "../../db/index.js";
import type { Logger } from "pino";
import { XClient } from "./client.js";
import { XAccountService } from "./account.js";
import { XImportService } from "./import-service.js";
import { nowIso } from "../../lib/time.js";
import { cache } from "../../lib/cache.js";

/**
 * Tiered metrics refresh (PRD 5.2.6). Each tier defines a post-age window and
 * a minimum interval between snapshots. Every observation is appended, never
 * overwritten, so 30-day growth can be computed from history.
 */
const TIERS: Array<{ maxAgeDays: number; intervalMinutes: number }> = [
  { maxAgeDays: 1, intervalMinutes: 15 },
  { maxAgeDays: 7, intervalMinutes: 60 },
  { maxAgeDays: 30, intervalMinutes: 360 },
  { maxAgeDays: 180, intervalMinutes: 1440 },
  { maxAgeDays: 36500, intervalMinutes: 10080 },
];

export class XMetricsSyncService {
  private accounts: XAccountService;
  private importer: XImportService;

  constructor(
    private db: DB,
    private client: XClient,
    private log: Logger,
  ) {
    this.accounts = new XAccountService(db);
    this.importer = new XImportService(db, client, log);
  }

  /** Posts whose latest snapshot is older than their tier interval. */
  duePostIds(limit = 100): Array<{ id: string; x_post_id: string }> {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT p.id, p.x_post_id, p.published_at, p.created_at,
          (SELECT MAX(collected_at) FROM x_metric_snapshots s WHERE s.post_id = p.id) AS last_collected
         FROM posts p
         WHERE p.x_post_id IS NOT NULL AND p.deleted_at IS NULL AND p.x_source_unavailable = 0
           AND p.status IN ('published', 'review', 'imported', 'draft')`,
      )
      .all() as Array<{ id: string; x_post_id: string; published_at: string | null; created_at: string; last_collected: string | null }>;

    const due = rows.filter((r) => {
      const ageDays = (now - new Date(r.published_at ?? r.created_at).getTime()) / 86_400_000;
      const tier = TIERS.find((t) => ageDays <= t.maxAgeDays) ?? TIERS[TIERS.length - 1]!;
      if (!r.last_collected) return true;
      const minutesSince = (now - new Date(r.last_collected).getTime()) / 60_000;
      return minutesSince >= tier.intervalMinutes;
    });

    // refresh the stalest first
    due.sort((a, b) => (a.last_collected ?? "").localeCompare(b.last_collected ?? ""));
    return due.slice(0, limit).map((r) => ({ id: r.id, x_post_id: r.x_post_id }));
  }

  async refresh(limit = 100): Promise<{ refreshed: number; missing: number }> {
    const due = this.duePostIds(limit);
    if (due.length === 0) return { refreshed: 0, missing: 0 };

    const accessToken = this.accounts.getAccessToken() ?? undefined;
    let refreshed = 0;
    let missing = 0;

    for (let i = 0; i < due.length; i += 100) {
      const batch = due.slice(i, i + 100);
      const byXId = new Map(batch.map((b) => [b.x_post_id, b.id]));
      const res = await this.client.getTweets(batch.map((b) => b.x_post_id), accessToken);

      const returned = new Set<string>();
      for (const tweet of res.tweets) {
        const postId = byXId.get(tweet.id);
        if (!postId) continue;
        returned.add(tweet.id);
        this.importer.recordMetricsSnapshot(postId, tweet);
        refreshed++;
      }

      // deleted on X: flag, never delete local archive (PRD 5.2.4)
      for (const b of batch) {
        if (!returned.has(b.x_post_id)) {
          this.db
            .prepare("UPDATE posts SET x_source_unavailable = 1, updated_at = ? WHERE id = ?")
            .run(nowIso(), b.id);
          missing++;
        }
      }
    }

    this.accounts.recordMetricsRefresh();
    cache.invalidate("home", "stats", "totals", "post");
    this.log.info({ refreshed, missing }, "x metrics refresh complete");
    return { refreshed, missing };
  }
}
