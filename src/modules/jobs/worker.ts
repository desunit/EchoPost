import type { DB } from "../../db/index.js";
import type { Logger } from "pino";
import cron from "node-cron";
import { hostname } from "node:os";
import { JobQueue, type JobRow } from "./queue.js";
import { XClient, XRateLimitError } from "../x/client.js";
import { XImportService } from "../x/import-service.js";
import { getLlmMetadataProvider } from "../metadata/llm.js";
import { XMetricsSyncService } from "../x/metrics-service.js";
import { RelatedPostsService } from "../related-posts/service.js";
import { AnalyticsService } from "../analytics/service.js";
import { MediaService } from "../media/service.js";
import { cache } from "../../lib/cache.js";
import { config } from "../../config/index.js";
import { backupDatabase } from "../../scripts-lib/backup.js";

export type JobHandler = (payload: any) => Promise<void>;

/**
 * Job worker + cron schedules (PRD §8). Cron entries only enqueue jobs; the
 * worker loop executes them with retries and rate-limit-aware backoff.
 */
export class JobWorker {
  readonly queue: JobQueue;
  private handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private cronTasks: cron.ScheduledTask[] = [];
  private workerId = `${hostname()}-${process.pid}`;
  private running = false;

  constructor(
    private db: DB,
    private log: Logger,
  ) {
    this.queue = new JobQueue(db);
    this.registerDefaultHandlers();
  }

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  private registerDefaultHandlers(): void {
    const client = new XClient();
    const importer = new XImportService(this.db, client, this.log, getLlmMetadataProvider());
    const metrics = new XMetricsSyncService(this.db, client, this.log);
    const related = new RelatedPostsService(this.db);
    const analytics = new AnalyticsService(this.db);
    const media = new MediaService(this.db);

    this.register("x_import", async () => {
      const summary = await importer.runImport();
      this.log.info(summary, "x import finished");
      if (summary.imported > 0) {
        this.queue.enqueue("recalculate_related", {}, { dedupe: true });
      }
    });

    this.register("x_backfill", async (payload) => {
      const summary = await importer.runBackfill(payload?.batchSize ?? config.x.backfillBatchSize);
      this.log.info(summary, "x backfill finished");
      if (summary.imported > 0) {
        this.queue.enqueue("recalculate_related", {}, { dedupe: true });
      }
    });

    this.register("x_metrics_refresh", async (payload) => {
      await metrics.refresh(payload?.limit ?? 100);
    });

    this.register("x_post_media_refetch", async (payload) => {
      if (!payload?.postId) return;
      const summary = await importer.refetchMedia(payload.postId);
      this.log.info({ postId: payload.postId, ...summary }, "x post media refetched");
    });

    this.register("recalculate_related", async (payload) => {
      if (payload?.postId) related.recalculateForPost(payload.postId);
      else related.recalculateAll();
    });

    this.register("rebuild_caches", async () => {
      cache.invalidate();
    });

    this.register("prune_analytics", async () => {
      const pruned = analytics.pruneVisitorLog();
      this.log.info({ pruned }, "analytics visitor log pruned");
    });

    this.register("verify_media", async () => {
      const missing = media.findMissingFiles();
      for (const m of missing) {
        try {
          await media.redownload(m);
          this.log.info({ mediaId: m.id }, "media re-downloaded");
        } catch (err) {
          this.log.warn({ err, mediaId: m.id }, "media re-download failed");
        }
      }
    });

    this.register("backup_database", async () => {
      const file = backupDatabase();
      this.log.info({ file }, "database backup written");
    });

    this.register("clean_sessions", async () => {
      this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
    });

    this.register("clean_jobs", async () => {
      this.queue.cleanOld();
    });

    this.register("vacuum", async () => {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
      this.db.exec("VACUUM");
    });
  }

  start(): void {
    if (this.timer) return;
    this.queue.releaseStale();
    this.timer = setInterval(() => void this.tick(), 5000);

    const schedule = (expr: string, type: string, payload: unknown = {}) => {
      this.cronTasks.push(
        cron.schedule(expr, () => {
          this.queue.enqueue(type, payload, { dedupe: true });
        }),
      );
    };

    schedule("0 3 * * *", "x_import");               // daily import of new X posts (records a metrics snapshot per new post)
    schedule("30 3 * * *", "recalculate_related");   // nightly recalculation
    schedule("15 * * * *", "rebuild_caches");        // hourly cache + stats refresh
    schedule("45 2 * * *", "verify_media");          // daily media verification
    schedule("0 4 * * *", "backup_database");        // daily SQLite backup
    schedule("10 4 * * *", "clean_sessions");
    schedule("20 4 * * *", "prune_analytics");
    schedule("0 5 * * 0", "clean_jobs");             // weekly
    schedule("30 5 * * 0", "vacuum");                // weekly
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const task of this.cronTasks) task.stop();
    this.cronTasks = [];
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // drain a few jobs per tick
      for (let i = 0; i < 3; i++) {
        const job = this.queue.claim(this.workerId);
        if (!job) break;
        await this.execute(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      this.queue.fail({ ...job, attempts: job.max_attempts }, `No handler for job type: ${job.type}`);
      return;
    }
    try {
      await handler(job.payload_json ? JSON.parse(job.payload_json) : {});
      this.queue.complete(job.id);
    } catch (err: any) {
      if (err instanceof XRateLimitError) {
        this.log.warn({ jobId: job.id, retryAfter: err.retryAfterSeconds }, "job rate limited");
        this.queue.fail(job, err.message, err.retryAfterSeconds);
      } else {
        this.log.error({ err, jobId: job.id, type: job.type }, "job failed");
        this.queue.fail(job, String(err?.message ?? err));
      }
    }
  }
}
