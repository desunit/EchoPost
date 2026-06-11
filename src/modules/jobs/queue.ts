import type { DB } from "../../db/index.js";
import { newId } from "../../lib/ids.js";
import { nowIso } from "../../lib/time.js";

export type JobStatus = "pending" | "running" | "done" | "failed" | "dead";

export interface JobRow {
  id: string;
  type: string;
  payload_json: string | null;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** SQLite-backed job queue (PRD §7/§18): retries, backoff, dead-letter. */
export class JobQueue {
  constructor(private db: DB) {}

  enqueue(type: string, payload: unknown = {}, opts: { runAfter?: string; priority?: number; maxAttempts?: number; dedupe?: boolean } = {}): string | null {
    if (opts.dedupe) {
      const existing = this.db
        .prepare("SELECT id FROM jobs WHERE type = ? AND status IN ('pending', 'running') LIMIT 1")
        .get(type) as { id: string } | undefined;
      if (existing) return null;
    }
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (id, type, payload_json, status, priority, attempts, max_attempts, run_after, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`,
      )
      .run(id, type, JSON.stringify(payload), opts.priority ?? 0, opts.maxAttempts ?? 5, opts.runAfter ?? now, now, now);
    return id;
  }

  /** Atomically claim the next due job. */
  claim(workerId: string): JobRow | undefined {
    const now = nowIso();
    const claimTx = this.db.transaction(() => {
      const job = this.db
        .prepare(
          `SELECT * FROM jobs WHERE status = 'pending' AND run_after <= ?
           ORDER BY priority DESC, run_after ASC LIMIT 1`,
        )
        .get(now) as JobRow | undefined;
      if (!job) return undefined;
      this.db
        .prepare(
          "UPDATE jobs SET status = 'running', locked_at = ?, locked_by = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
        )
        .run(now, workerId, now, job.id);
      return { ...job, status: "running" as const, attempts: job.attempts + 1 };
    });
    return claimTx();
  }

  complete(id: string): void {
    this.db
      .prepare("UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }

  /** Retry with exponential backoff; dead-letter after max attempts. */
  fail(job: JobRow, error: string, retryAfterSeconds?: number): void {
    const now = nowIso();
    if (job.attempts >= job.max_attempts) {
      this.db
        .prepare(
          "UPDATE jobs SET status = 'dead', last_error = ?, locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?",
        )
        .run(error.slice(0, 2000), now, job.id);
      return;
    }
    const backoffSeconds = retryAfterSeconds ?? Math.min(3600, 30 * 2 ** (job.attempts - 1));
    const runAfter = new Date(Date.now() + backoffSeconds * 1000).toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', last_error = ?, run_after = ?,
         locked_at = NULL, locked_by = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(error.slice(0, 2000), runAfter, now, job.id);
  }

  retryNow(id: string): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = 'pending', run_after = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?",
      )
      .run(nowIso(), nowIso(), id);
  }

  /** Release jobs stuck in 'running' (e.g. after a crash). */
  releaseStale(olderThanMinutes = 30): number {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
    return this.db
      .prepare("UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE status = 'running' AND locked_at < ?")
      .run(cutoff).changes;
  }

  cleanOld(keepDays = 7): number {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
    return this.db
      .prepare("DELETE FROM jobs WHERE status IN ('done', 'dead') AND updated_at < ?")
      .run(cutoff).changes;
  }

  list(limit = 100): JobRow[] {
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as JobRow[];
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS c FROM jobs GROUP BY status").all() as Array<{
      status: string;
      c: number;
    }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  get(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  }
}
