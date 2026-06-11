import type { DB } from "../../db/index.js";
import type { Logger } from "pino";
import { newId } from "../../lib/ids.js";
import { nowIso } from "../../lib/time.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";
import { config } from "../../config/index.js";
import { escapeHtml } from "../../lib/markdown.js";
import { createEmailProvider, forwardSubscriberWebhook, type EmailProvider } from "./providers.js";
import type { SubscriberStatus } from "../types.js";

export interface SubscriberRow {
  id: string;
  email: string;
  status: SubscriberStatus;
  confirmation_token_hash: string | null;
  unsubscribe_token_hash: string | null;
  subscribed_at: string | null;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  source: string | null;
  created_at: string;
  updated_at: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Double-opt-in newsletter flow (PRD 5.9). Tokens are stored hashed. */
export class NewsletterService {
  private provider: EmailProvider;

  constructor(
    private db: DB,
    private log: Logger,
    provider?: EmailProvider,
  ) {
    this.provider = provider ?? createEmailProvider();
  }

  normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  isValidEmail(email: string): boolean {
    return EMAIL_RE.test(email) && email.length <= 254;
  }

  getByEmail(email: string): SubscriberRow | undefined {
    return this.db.prepare("SELECT * FROM subscribers WHERE email = ?").get(this.normalizeEmail(email)) as
      | SubscriberRow
      | undefined;
  }

  /**
   * Subscribe: stores a pending subscriber and sends the confirmation email.
   * Duplicates are handled gracefully — active subscribers get no email,
   * pending ones get the confirmation resent.
   */
  async subscribe(emailRaw: string, source = "homepage"): Promise<{ ok: boolean; message: string }> {
    const email = this.normalizeEmail(emailRaw);
    if (!this.isValidEmail(email)) return { ok: false, message: "That email address doesn't look valid." };

    const existing = this.getByEmail(email);
    if (existing?.status === "active") {
      return { ok: true, message: "You're already subscribed." };
    }

    const confirmToken = randomToken();
    const unsubscribeToken = randomToken();
    const now = nowIso();

    if (existing) {
      this.db
        .prepare(
          `UPDATE subscribers SET status = 'pending', confirmation_token_hash = ?,
           unsubscribe_token_hash = ?, subscribed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(sha256Hex(confirmToken), sha256Hex(unsubscribeToken), now, now, existing.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO subscribers (id, email, status, confirmation_token_hash, unsubscribe_token_hash,
            subscribed_at, source, created_at, updated_at)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
        )
        .run(newId(), email, sha256Hex(confirmToken), sha256Hex(unsubscribeToken), now, source, now, now);
    }

    const confirmUrl = `${config.siteUrl}/subscribe/confirm?token=${confirmToken}`;
    try {
      await this.provider.sendTransactionalEmail({
        to: email,
        subject: `Confirm your subscription to ${config.siteTitle}`,
        text: `Confirm your subscription by opening this link:\n\n${confirmUrl}\n\nIf you didn't request this, ignore this email.`,
        html: `<p>Confirm your subscription to <strong>${escapeHtml(config.siteTitle)}</strong>:</p><p><a href="${confirmUrl}">Confirm subscription</a></p><p>If you didn't request this, ignore this email.</p>`,
      });
    } catch (err) {
      this.log.error({ err, email }, "newsletter: confirmation email failed");
      return { ok: false, message: "We couldn't send the confirmation email. Please try again later." };
    }
    return { ok: true, message: "Check your inbox to confirm your subscription." };
  }

  async confirm(token: string): Promise<SubscriberRow | undefined> {
    const row = this.db
      .prepare("SELECT * FROM subscribers WHERE confirmation_token_hash = ? AND status = 'pending'")
      .get(sha256Hex(token)) as SubscriberRow | undefined;
    if (!row) return undefined;

    const now = nowIso();
    this.db
      .prepare(
        `UPDATE subscribers SET status = 'active', confirmed_at = ?, confirmation_token_hash = NULL,
         updated_at = ? WHERE id = ?`,
      )
      .run(now, now, row.id);

    forwardSubscriberWebhook(row.email, "subscribed").catch((err) =>
      this.log.warn({ err }, "newsletter: webhook forward failed"),
    );

    try {
      await this.provider.sendTransactionalEmail({
        to: row.email,
        subject: `Welcome to ${config.siteTitle}`,
        text: `You're subscribed to ${config.siteTitle}. Read the archive: ${config.siteUrl}`,
        html: `<p>You're subscribed to <strong>${escapeHtml(config.siteTitle)}</strong>.</p><p><a href="${config.siteUrl}">Browse the archive</a></p>`,
      });
    } catch (err) {
      this.log.warn({ err }, "newsletter: welcome email failed");
    }
    return this.getByEmail(row.email);
  }

  /** One-click unsubscribe via hashed token. */
  unsubscribe(token: string): boolean {
    const row = this.db
      .prepare("SELECT * FROM subscribers WHERE unsubscribe_token_hash = ?")
      .get(sha256Hex(token)) as SubscriberRow | undefined;
    if (!row) return false;
    const now = nowIso();
    this.db
      .prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, row.id);
    forwardSubscriberWebhook(row.email, "unsubscribed").catch((err) =>
      this.log.warn({ err }, "newsletter: webhook forward failed"),
    );
    return true;
  }

  counts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS c FROM subscribers GROUP BY status")
      .all() as Array<{ status: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.c]));
  }

  newToday(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM subscribers WHERE confirmed_at >= ?")
      .get(`${new Date().toISOString().slice(0, 10)}T00:00:00`) as any;
    return row.c;
  }

  list(limit = 200, offset = 0): SubscriberRow[] {
    return this.db
      .prepare("SELECT * FROM subscribers ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as SubscriberRow[];
  }
}
