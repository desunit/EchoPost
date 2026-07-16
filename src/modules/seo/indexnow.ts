import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import type { DB } from "../../db/index.js";
import { config } from "../../config/index.js";
import { SettingsService } from "../settings/service.js";
import { JobQueue } from "../jobs/queue.js";

/**
 * IndexNow change notifications (Bing, Yandex, Seznam, Naver, …). Ownership is
 * proven by serving the key at `${publicUrl}/<key>.txt`; content changes call
 * `submit()`, which enqueues an `indexnow_ping` job so the actual HTTP POST
 * gets the job queue's retries/backoff instead of blocking the request path.
 */
export class IndexNowService {
  readonly key: string;
  private queue: JobQueue;

  constructor(
    db: DB,
    private log?: Logger,
  ) {
    // INDEXNOW_KEY wins; otherwise generate once and persist in settings so the
    // key file URL stays stable across restarts (engines re-verify it per ping).
    const settings = new SettingsService(db);
    let key = config.indexNow.key || settings.get<string>("indexnow_key", "");
    if (!key) {
      key = randomBytes(16).toString("hex");
      settings.set("indexnow_key", key);
    }
    this.key = key;
    this.queue = new JobQueue(db);
  }

  get keyFileName(): string {
    return `${this.key}.txt`;
  }

  /** Queue a ping for site-relative paths (e.g. "/my-post"). No-op when disabled. */
  submit(paths: string[]): void {
    if (!config.indexNow.enabled || paths.length === 0) return;
    const urls = [...new Set(paths.map((p) => `${config.publicUrl}${p.startsWith("/") ? p : `/${p}`}`))];
    this.queue.enqueue("indexnow_ping", { urls });
  }

  /** POST the URL batch to the IndexNow endpoint. Throws on failure so the job retries. */
  async ping(urls: string[]): Promise<void> {
    if (urls.length === 0) return;
    const res = await fetch(config.indexNow.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: new URL(config.siteUrl).host,
        key: this.key,
        // Explicit keyLocation supports sub-path deployments (BASE_PATH), where
        // the key file isn't at the host root.
        keyLocation: `${config.publicUrl}/${this.keyFileName}`,
        urlList: urls,
      }),
    });
    // 200 OK and 202 Accepted both mean the batch was received.
    if (res.status !== 200 && res.status !== 202) {
      const body = await res.text().catch(() => "");
      throw new Error(`IndexNow ping failed: HTTP ${res.status} ${body}`.trim());
    }
    this.log?.info({ urls: urls.length, status: res.status }, "indexnow ping sent");
  }
}
