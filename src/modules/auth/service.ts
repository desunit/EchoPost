import type { DB } from "../../db/index.js";
import { newId } from "../../lib/ids.js";
import { nowIso } from "../../lib/time.js";
import {
  hashPassword,
  verifyPassword,
  randomToken,
  sha256Hex,
} from "../../lib/crypto.js";
import { SettingsService } from "../settings/service.js";

const SESSION_TTL_MS = 7 * 86_400_000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

export interface SessionRow {
  id: string;
  token_hash: string;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  ip_prefix: string | null;
  user_agent: string | null;
}

/**
 * Single-author admin auth (PRD 5.16/§11.1): scrypt-hashed password,
 * server-side sessions referenced by an opaque cookie token, CSRF tokens
 * per session, and in-memory login rate limiting.
 */
export class AuthService {
  private settings: SettingsService;

  constructor(private db: DB) {
    this.settings = new SettingsService(db);
  }

  hasAdminPassword(): boolean {
    return !!this.settings.get<string | null>("admin_password_hash", null);
  }

  setAdminPassword(password: string): void {
    this.settings.set("admin_password_hash", hashPassword(password));
  }

  checkRateLimit(ip: string, max = 10, windowMs = 15 * 60_000): boolean {
    const now = Date.now();
    const bucket = loginAttempts.get(ip);
    if (!bucket || bucket.resetAt < now) {
      loginAttempts.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (bucket.count >= max) return false;
    bucket.count++;
    return true;
  }

  login(password: string, ip: string, userAgent?: string): string | null {
    const hash = this.settings.get<string | null>("admin_password_hash", null);
    if (!hash || !verifyPassword(password, hash)) {
      this.audit("login_failed", { ip });
      return null;
    }
    const token = randomToken();
    const now = nowIso();
    const ipPrefix = ip.split(".").slice(0, 3).join(".");
    this.db
      .prepare(
        `INSERT INTO sessions (id, token_hash, csrf_token, created_at, expires_at, ip_prefix, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId(), sha256Hex(token), randomToken(16), now,
        new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        ipPrefix, (userAgent ?? "").slice(0, 300),
      );
    this.audit("login_success", { ip: ipPrefix });
    return token;
  }

  getSession(token: string | undefined): SessionRow | undefined {
    if (!token) return undefined;
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE token_hash = ?")
      .get(sha256Hex(token)) as SessionRow | undefined;
    if (!row) return undefined;
    if (row.expires_at < nowIso()) {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
      return undefined;
    }
    return row;
  }

  logout(token: string | undefined): void {
    if (!token) return;
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(token));
  }

  audit(action: string, payload: unknown = {}, entityType?: string, entityId?: string): void {
    this.db
      .prepare(
        "INSERT INTO audit_log (actor, action, entity_type, entity_id, payload_json, created_at) VALUES ('admin', ?, ?, ?, ?, ?)",
      )
      .run(action, entityType ?? null, entityId ?? null, JSON.stringify(payload), nowIso());
  }
}
