import type { DB } from "../../db/index.js";
import { encryptSecret, decryptSecret } from "../../lib/crypto.js";
import { nowIso } from "../../lib/time.js";

export interface XAccountRow {
  id: number;
  x_user_id: string | null;
  username: string | null;
  display_name: string | null;
  profile_image_url: string | null;
  connection_status: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  last_sync_at: string | null;
  last_imported_x_post_id: string | null;
  last_metrics_refresh_at: string | null;
  backfill_oldest_x_post_id: string | null;
  backfill_oldest_at: string | null;
  backfill_complete: number;
  last_error: string | null;
  updated_at: string | null;
}

/** Single connected X account (PRD 5.2.2). OAuth tokens are encrypted at rest. */
export class XAccountService {
  constructor(private db: DB) {}

  get(): XAccountRow {
    return this.db.prepare("SELECT * FROM x_account WHERE id = 1").get() as XAccountRow;
  }

  setProfile(profile: { xUserId: string; username: string; displayName: string; profileImageUrl?: string }): void {
    this.db
      .prepare(
        `UPDATE x_account SET x_user_id = ?, username = ?, display_name = ?, profile_image_url = ?,
         connection_status = 'connected', last_error = NULL, updated_at = ? WHERE id = 1`,
      )
      .run(profile.xUserId, profile.username, profile.displayName, profile.profileImageUrl ?? null, nowIso());
  }

  setTokens(accessToken: string, refreshToken: string | null, expiresAt: string | null): void {
    this.db
      .prepare(
        `UPDATE x_account SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(
        encryptSecret(accessToken),
        refreshToken ? encryptSecret(refreshToken) : null,
        expiresAt, nowIso(),
      );
  }

  getAccessToken(): string | null {
    const row = this.get();
    if (!row.access_token_enc) return null;
    try {
      return decryptSecret(row.access_token_enc);
    } catch {
      return null;
    }
  }

  disconnect(): void {
    this.db
      .prepare(
        `UPDATE x_account SET access_token_enc = NULL, refresh_token_enc = NULL,
         connection_status = 'disconnected', updated_at = ? WHERE id = 1`,
      )
      .run(nowIso());
  }

  recordSyncSuccess(lastImportedId?: string): void {
    if (lastImportedId) {
      this.db
        .prepare("UPDATE x_account SET last_sync_at = ?, last_imported_x_post_id = ?, last_error = NULL, updated_at = ? WHERE id = 1")
        .run(nowIso(), lastImportedId, nowIso());
    } else {
      this.db
        .prepare("UPDATE x_account SET last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = 1")
        .run(nowIso(), nowIso());
    }
  }

  /**
   * Advance the backfill watermark after an older batch. `oldestId` is the
   * oldest tweet id seen this batch (the `until_id` cursor for the next one);
   * `complete` marks the archive exhausted when the API returns nothing older.
   */
  recordBackfillProgress(oldestId: string | null, oldestAt: string | null, complete: boolean): void {
    this.db
      .prepare(
        `UPDATE x_account SET
           backfill_oldest_x_post_id = COALESCE(?, backfill_oldest_x_post_id),
           backfill_oldest_at = COALESCE(?, backfill_oldest_at),
           backfill_complete = ?, last_sync_at = ?, last_error = NULL, updated_at = ?
         WHERE id = 1`,
      )
      .run(oldestId, oldestAt, complete ? 1 : 0, nowIso(), nowIso());
  }

  recordMetricsRefresh(): void {
    this.db.prepare("UPDATE x_account SET last_metrics_refresh_at = ?, updated_at = ? WHERE id = 1")
      .run(nowIso(), nowIso());
  }

  recordError(message: string): void {
    this.db.prepare("UPDATE x_account SET last_error = ?, updated_at = ? WHERE id = 1")
      .run(message.slice(0, 2000), nowIso());
  }
}
