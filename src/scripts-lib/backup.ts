import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config/index.js";
import { getDb } from "../db/index.js";

/**
 * Daily SQLite backup (PRD §13): online backup via VACUUM INTO, with
 * retention of 14 daily snapshots.
 */
export function backupDatabase(): string {
  fs.mkdirSync(config.backupPath, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const target = path.join(config.backupPath, `echopost-${stamp}.db`);
  const db = getDb();
  db.prepare("VACUUM INTO ?").run(target);
  enforceRetention();
  return target;
}

function enforceRetention(keepDaily = 14): void {
  const files = fs
    .readdirSync(config.backupPath)
    .filter((f) => f.startsWith("echopost-") && f.endsWith(".db"))
    .sort()
    .reverse();
  for (const file of files.slice(keepDaily)) {
    fs.unlinkSync(path.join(config.backupPath, file));
  }
}

/** Restore test (PRD 13.3): open the latest backup and run sanity checks. */
export function verifyLatestBackup(): { ok: boolean; details: string } {
  const files = fs.existsSync(config.backupPath)
    ? fs.readdirSync(config.backupPath).filter((f) => f.endsWith(".db")).sort().reverse()
    : [];
  if (files.length === 0) return { ok: false, details: "No backups found" };
  const latest = path.join(config.backupPath, files[0]!);
  try {
    const test = new Database(latest, { readonly: true });
    const posts = (test.prepare("SELECT COUNT(*) AS c FROM posts").get() as any).c;
    const subscribers = (test.prepare("SELECT COUNT(*) AS c FROM subscribers").get() as any).c;
    const migrations = (test.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as any).c;
    test.close();
    return { ok: true, details: `${files[0]}: ${posts} posts, ${subscribers} subscribers, ${migrations} migrations` };
  } catch (err: any) {
    return { ok: false, details: `Backup unreadable: ${err.message}` };
  }
}
